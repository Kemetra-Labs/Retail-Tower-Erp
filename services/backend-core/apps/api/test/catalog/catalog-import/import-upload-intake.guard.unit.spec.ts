/**
 * RT-1505 (spec 049 §8.4, §8.5): the intake of the upload: the order of its
 * checks, the concurrency bound, the raw body and the idempotency fingerprint.
 */
import "reflect-metadata";

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { BadRequestException, HttpException, PayloadTooLargeException, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { Request, Response } from "express";
import { ZodError } from "zod";

import { RolesGuard, SessionOnlyAdminGuard } from "../../../src/auth";
import { CatalogImportController } from "../../../src/catalog/catalog-import/catalog-import.controller";
import { IMPORT_UPLOAD_MAX_CONCURRENT, ImportUploadGate, type ImportUploadSlot } from "../../../src/catalog/catalog-import/import-upload.gate";
import {
  importUploadPassthrough,
  ImportUploadIntakeGuard,
  type ImportUploadRequest,
} from "../../../src/catalog/catalog-import/import-upload-intake.guard";
import { TenantContextGuard } from "../../../src/context";

const KEY = "rt1505-unit-key-0000000001";

interface Harness {
  readonly req: ImportUploadRequest & PassThrough;
  readonly res: Response & EventEmitter & { headers: Record<string, string> };
  readonly context: ExecutionContext;
}

let tenantSeq = 0;

function harness(init: { headers?: Record<string, string>; query?: Record<string, unknown>; tenant?: string } = {}): Harness {
  tenantSeq += 1;
  const req = Object.assign(new PassThrough(), {
    headers: { "idempotency-key": KEY, ...init.headers },
    query: init.query ?? { mode: "create" },
    body: undefined,
    // The tenant guard has run: a distinct tenant per request unless a test says otherwise.
    context: { tenantId: init.tenant ?? `tenant-${tenantSeq}` },
  }) as unknown as Harness["req"];
  const res = Object.assign(new EventEmitter(), {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  }) as unknown as Harness["res"];
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
  return { req, res, context };
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe("ImportUploadIntakeGuard: the order of checks", () => {
  it("refuses a missing or malformed key with 400 before the query, the slot and the body", async () => {
    const gate = new ImportUploadGate(1);
    const guard = new ImportUploadIntakeGuard(gate);
    const none = harness({ headers: { "idempotency-key": "" } });
    await expect(guard.canActivate(none.context)).rejects.toMatchObject({ response: { code: "idempotency_key_required" } });
    const bad = harness({ headers: { "idempotency-key": "short" }, query: {} });
    await expect(guard.canActivate(bad.context)).rejects.toMatchObject({ response: { code: "idempotency_key_malformed" } });
    expect(gate.active()).toBe(0);
    expect(bad.req.readableFlowing).toBeNull();
  });

  it("refuses a bad query with a ZodError (the global filter's 400) before taking a slot or reading the body", async () => {
    const gate = new ImportUploadGate(1);
    const guard = new ImportUploadIntakeGuard(gate);
    for (const query of [{}, { mode: "merge" }, { mode: "create", extra: "1" }, { mode: ["create", "update"] }]) {
      const h = harness({ query });
      await expect(guard.canActivate(h.context)).rejects.toBeInstanceOf(ZodError);
      expect(h.req.readableFlowing).toBeNull();
    }
    expect(gate.active()).toBe(0);
  });

  it("answers 429 rate_limited with Retry-After when every slot is taken, WITHOUT reading the body", async () => {
    const gate = new ImportUploadGate(1);
    const guard = new ImportUploadIntakeGuard(gate);
    const first = harness();
    const pending = guard.canActivate(first.context);
    expect(gate.active()).toBe(1);
    const second = harness();
    const refused = await guard.canActivate(second.context).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect((refused as HttpException).getResponse()).toMatchObject({ code: "rate_limited" });
    expect(second.res.headers).toMatchObject({ "Retry-After": "5", "Cache-Control": "no-store", Connection: "close" });
    expect(second.req.readableFlowing).toBeNull();
    // The refused caller never took a slot: finishing the first frees the one slot there is.
    first.req.end(Buffer.from("a\n1\n"));
    await pending;
    first.res.emit("finish");
    expect(gate.active()).toBe(0);
  });

  it("bounds concurrent uploads by default at four, one per tenant", () => {
    const gate = new ImportUploadGate();
    const slots = Array.from({ length: IMPORT_UPLOAD_MAX_CONCURRENT }, (_v, i) => gate.tryAcquire(`t${i}`));
    expect(slots.every((r) => r !== null)).toBe(true);
    expect(gate.tryAcquire("another")).toBeNull();
    slots[0]?.responseEnded();
    expect(gate.tryAcquire("another")).not.toBeNull();
  });
});

describe("the upload slot (security review of PR #761, M4)", () => {
  it("allows one concurrent upload per tenant, while other tenants keep their slots", async () => {
    const gate = new ImportUploadGate(4);
    const guard = new ImportUploadIntakeGuard(gate);
    const first = harness({ tenant: "tenant-a" });
    const pending = guard.canActivate(first.context);
    const sameTenant = harness({ tenant: "tenant-a" });
    const refused = await guard.canActivate(sameTenant.context).catch((e: unknown) => e);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect(sameTenant.res.headers["Retry-After"]).toBe("5");
    expect(sameTenant.req.readableFlowing).toBeNull();
    const other = harness({ tenant: "tenant-b" });
    const otherPending = guard.canActivate(other.context);
    first.req.end(Buffer.from("a\n1\n"));
    other.req.end(Buffer.from("a\n1\n"));
    await Promise.all([pending, otherPending]);
    expect(gate.active()).toBe(2);
    first.res.emit("finish");
    // The tenant's slot is free again once its upload is over.
    const again = harness({ tenant: "tenant-a" });
    const againPending = guard.canActivate(again.context);
    again.req.end(Buffer.from("a\n1\n"));
    await expect(againPending).resolves.toBe(true);
  });

  it("is held until the handler's work is done, even when the client aborts mid-parse", async () => {
    const gate = new ImportUploadGate(1);
    const guard = new ImportUploadIntakeGuard(gate);
    const h = harness();
    const done = guard.canActivate(h.context);
    h.req.end(Buffer.from("a\n1\n"));
    await done;
    const slot = h.req.importUploadSlot as ImportUploadSlot;
    expect(slot.begin()).toBe(true);
    // The client goes away while the server still parses.
    h.res.emit("close");
    h.res.emit("finish");
    expect(gate.active()).toBe(1);
    expect(gate.tryAcquire("someone-else")).toBeNull();
    slot.end();
    expect(gate.active()).toBe(0);
    expect(gate.tryAcquire("someone-else")).not.toBeNull();
  });

  it("is released by the response alone when the handler never runs (a replay, a conflict)", async () => {
    const gate = new ImportUploadGate(1);
    const guard = new ImportUploadIntakeGuard(gate);
    const h = harness();
    const done = guard.canActivate(h.context);
    h.req.end(Buffer.from("a\n1\n"));
    await done;
    expect(gate.active()).toBe(1);
    h.res.emit("finish");
    h.res.emit("close");
    expect(gate.active()).toBe(0);
  });

  it("tells a handler that starts after the client left to do nothing, and frees the slot exactly once", async () => {
    const gate = new ImportUploadGate(1);
    const guard = new ImportUploadIntakeGuard(gate);
    const h = harness();
    const done = guard.canActivate(h.context);
    h.req.end(Buffer.from("a\n1\n"));
    await done;
    h.res.emit("close");
    const slot = h.req.importUploadSlot as ImportUploadSlot;
    expect(slot.begin()).toBe(false);
    expect(gate.active()).toBe(0);
    slot.end();
    expect(gate.active()).toBe(0);
    // A fresh slot of the same gate is unaffected by the stale one's extra calls.
    expect(gate.tryAcquire("t")).not.toBeNull();
    expect(gate.tryAcquire("u")).toBeNull();
  });

  it("drops a body that does not arrive within the deadline: 400, the connection closes, the slot frees with the response", async () => {
    const gate = new ImportUploadGate(1, 40);
    const guard = new ImportUploadIntakeGuard(gate);
    const slow = harness();
    const started = Date.now();
    const err = await guard.canActivate(slow.context).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "validation_error" });
    expect(slow.res.headers["Connection"]).toBe("close");
    expect(gate.active()).toBe(1);
    slow.res.emit("close");
    expect(gate.active()).toBe(0);
    // A body that is complete in time is unaffected by the deadline.
    const fine = harness();
    const ok = guard.canActivate(fine.context);
    fine.req.end(Buffer.from("a\n1\n"));
    await expect(ok).resolves.toBe(true);
  });
});

describe("ImportUploadIntakeGuard: the body and the fingerprint", () => {
  it("reads the bytes, hands them to the handler and sets the idempotency fingerprint (SHA-256 + canonical query, absent as null)", async () => {
    const gate = new ImportUploadGate(2);
    const guard = new ImportUploadIntakeGuard(gate);
    const h = harness({ query: { mode: "upsert", file_name: "p.csv" } });
    const done = guard.canActivate(h.context);
    h.req.end(Buffer.from("sku\nA\n"));
    await expect(done).resolves.toBe(true);
    const bytes = Buffer.from("sku\nA\n");
    expect(h.req.importUpload).toEqual({ bytes, sha256: sha(bytes), query: { mode: "upsert", file_name: "p.csv" } });
    expect(h.req.body).toEqual({ fileSha256: sha(bytes), query: ["upsert", null, null, "p.csv"] });
  });

  it("gives different fingerprints to other bytes and to any other query value", async () => {
    const guard = new ImportUploadIntakeGuard(new ImportUploadGate(20));
    async function fingerprint(bytes: string, query: Record<string, string>): Promise<string> {
      const h = harness({ query });
      const done = guard.canActivate(h.context);
      h.req.end(Buffer.from(bytes));
      await done;
      return JSON.stringify(h.req.body);
    }
    const base = await fingerprint("a\n1\n", { mode: "create" });
    const all = new Set([
      base,
      await fingerprint("a\n2\n", { mode: "create" }),
      await fingerprint("a\n1\n", { mode: "update" }),
      await fingerprint("a\n1\n", { mode: "create", delimiter: "comma" }),
      await fingerprint("a\n1\n", { mode: "create", sheet: "Products" }),
      await fingerprint("a\n1\n", { mode: "create", file_name: "x.csv" }),
      await fingerprint("a\n1\n", { mode: "create", file_name: "caf\u{e9}.csv" }),
      await fingerprint("a\n1\n", { mode: "create", file_name: "cafe\u{301}.csv" }),
    ]);
    expect(all.size).toBe(8);
    expect(await fingerprint("a\n1\n", { mode: "create" })).toBe(base);
  });

  it("refuses a body over 5 MiB with 413 file_too_large and frees the slot when the response ends", async () => {
    const gate = new ImportUploadGate(1);
    const guard = new ImportUploadIntakeGuard(gate);
    const h = harness({ headers: { "content-length": String(5 * 1024 * 1024 + 1) } });
    const err = await guard.canActivate(h.context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect((err as PayloadTooLargeException).getResponse()).toMatchObject({ code: "file_too_large" });
    expect(gate.active()).toBe(1);
    h.res.emit("close");
    h.res.emit("finish");
    expect(gate.active()).toBe(0);
  });

  it("refuses an empty body with 400 validation_error", async () => {
    const guard = new ImportUploadIntakeGuard(new ImportUploadGate(1));
    const h = harness();
    const done = guard.canActivate(h.context).catch((e: unknown) => e);
    h.req.end();
    const err = await done;
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "validation_error" });
  });

  it("fails loudly (a plain Error, a 500) when a body parser consumed the body", async () => {
    const guard = new ImportUploadIntakeGuard(new ImportUploadGate(1));
    const h = harness();
    h.req.body = { parsed: true };
    const err = await guard.canActivate(h.context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HttpException);
  });
});

describe("importUploadPassthrough", () => {
  function passthrough(method: string, path: string, contentType = "application/json"): string | undefined {
    const req = { method, path, headers: { "content-type": contentType } } as unknown as Request;
    const next = jest.fn();
    importUploadPassthrough(req, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req.headers["content-type"];
  }

  it.each([
    ["POST", "/api/v1/catalog/imports"],
    ["POST", "/api/v1/catalog/imports/"],
    ["POST", "/API/V1/Catalog/Imports"],
  ])("marks %s %s as raw bytes", (method, path) => {
    expect(passthrough(method, path)).toBe("application/octet-stream");
  });

  it.each([
    ["GET", "/api/v1/catalog/imports"],
    ["POST", "/api/v1/catalog/imports/0a000000-0000-7000-8000-000000000001/validate"],
    ["POST", "/api/v1/catalog/products"],
    ["PUT", "/api/v1/catalog/imports/0a000000-0000-7000-8000-000000000001/mapping"],
  ])("leaves %s %s to the JSON parsers", (method, path) => {
    expect(passthrough(method, path)).toBe("application/json");
  });
});

describe("CatalogImportController: the guard order", () => {
  it("runs the session, tenant and role guards (headers and cookie only) before the intake reads a body", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CatalogImportController)).toEqual([SessionOnlyAdminGuard, TenantContextGuard, RolesGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, CatalogImportController.prototype.upload)).toEqual([ImportUploadIntakeGuard]);
    // Class guards run before method guards, so a refused caller never has its body read or a slot taken (RT-1295).
    // (The HTTP spec proves it: a store_staff upload is the 404 and writes nothing.)
  });
});
