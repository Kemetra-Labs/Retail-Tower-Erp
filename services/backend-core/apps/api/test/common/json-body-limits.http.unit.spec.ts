/**
 * RT-1284 — route-scoped JSON body limit for `binViewReportSnapshot`.
 *
 * Boots a DB-less Nest app with the same parser registration as main.ts and two
 * probe routes: the snapshot path (validated with the real
 * `SnapshotReportBodySchema`) and an ordinary JSON route. Proves:
 *   - the largest legal ASCII tracked window (> 100 kB) parses and validates;
 *   - a body of exactly 32 MiB passes body parsing and reaches validation;
 *   - 32 MiB + 1 byte gets 413;
 *   - every other route still refuses a body above 100 kB with 413;
 *   - malformed JSON still gets 400 (the 413 translation passes other errors on);
 *   - at most 2 snapshot bodies above 100 kB are read at once: a third gets 503
 *     `snapshot_busy` with Retry-After before its body is read; small bodies
 *     are never bounded; a slot is released after success, a parse error, a
 *     413 and a client abort.
 */
import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { load as parseYaml } from "js-yaml";
import request from "supertest";

import { SnapshotReportBodySchema, type SnapshotReportBody } from "../../src/catalog/erpnext-bin-view/dto/snapshot-report.dto";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import {
  BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES,
  BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES,
  isBinViewSnapshotJson,
  registerJsonBodyParsers,
  type SnapshotBodyGate,
} from "../../src/common/json-body-limits";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { CONTRACTS_DIR } from "../_helpers/openapi-routes";

const REQUEST_REF = "0190f0f0-0000-7000-8000-0000000012a4";
const SNAPSHOT_PATH = `/api/connector/v1/erpnext/bin-view-requests/${REQUEST_REF}/snapshot`;
const OTHER_PATH = "/api/v1/rt-1284-probe/echo";
/** body-parser's default JSON limit, "100kb" = 102,400 bytes. */
const DEFAULT_LIMIT_BYTES = 100 * 1024;

@Controller()
class ProbeController {
  @Post("api/connector/v1/erpnext/bin-view-requests/:requestRef/snapshot")
  @HttpCode(200)
  snapshot(
    @Param("requestRef") _requestRef: string,
    @Body(new ZodValidationPipe(SnapshotReportBodySchema)) body: SnapshotReportBody,
  ): { entries: number } {
    return { entries: body.entries.length };
  }

  @Post("api/v1/rt-1284-probe/echo")
  @HttpCode(200)
  echo(@Body() body: { pad?: string }): { padLength: number } {
    return { padLength: body.pad?.length ?? -1 };
  }
}

/**
 * The largest legal window under stock-view.yaml 1.4.0-draft with ASCII names,
 * serialized as the Connector sends it (`", "` / `": "` separators).
 */
function maximalAsciiTrackedWindow(): string {
  // Distinct names (the DTO refuses a repeated Batch), each 140 characters.
  const name = (prefix: string, i: number) => `${prefix}${i}`.padEnd(140, "A");
  const quantity = `-${"9".repeat(15)}.${"9".repeat(6)}`;
  const entries = Array.from({ length: 500 }, (_, e) => ({
    erpnextItemRef: { doctype: "Item", name: name("I", e) },
    quantity,
    stockUom: name("U", e),
    tracking: {
      hasBatchNo: true,
      hasSerialNo: false,
      hasExpiryDate: true,
      batches: Array.from({ length: 200 }, (_, b) => ({
        batchRef: { doctype: "Batch", name: name(`B${e}-`, b) },
        quantity,
        expiryDate: "2026-12-31",
        disabled: false,
      })),
    },
  }));
  const body = {
    entries,
    // windowSeq 19: the largest legal value (maxWindows 20), two digits.
    window: { attemptRef: "0190f0f0-0000-7000-8000-000000000000", windowSeq: 19, isFinal: true },
    readAt: "2026-11-08T12:00:00.000+02:00",
  };
  return pythonStyleJson(body);
}

/** JSON with Python `json.dumps` default separators (", " and ": "). */
function pythonStyleJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonStyleJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const parts = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pythonStyleJson(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** `json` followed by spaces up to exactly `bytes` bytes (still valid JSON). */
function padTo(json: string, bytes: number): string {
  const length = Buffer.byteLength(json);
  if (length > bytes) throw new Error(`body is already ${length} bytes, above ${bytes}`);
  return json + " ".repeat(bytes - length);
}

describe("RT-1284 JSON body limits", () => {
  let app: NestExpressApplication;
  let gate: SnapshotBodyGate;
  let maximal: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    gate = registerJsonBodyParsers(app);
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    maximal = maximalAsciiTrackedWindow();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: string, contentType = "application/json") =>
    request(app.getHttpServer()).post(path).set("Content-Type", contentType).send(body);

  it("the limit is 32 MiB and covers the largest legal ASCII tracked window", () => {
    expect(BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES).toBe(33_554_432);
    expect(Buffer.byteLength(maximal)).toBe(27_640_156);
    expect(Buffer.byteLength(maximal)).toBeLessThan(BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES);
  });

  it("accepts the largest legal ASCII tracked window on binViewReportSnapshot", async () => {
    const res = await post(SNAPSHOT_PATH, maximal);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: 500 });
  });

  it("a body of exactly 32 MiB passes body parsing and reaches validation", async () => {
    const res = await post(SNAPSHOT_PATH, padTo(maximal, BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: 500 });
  });

  it("an invalid body above 100 kB reaches validation (400, not 413)", async () => {
    const res = await post(SNAPSHOT_PATH, padTo('{"entries": "not-an-array"}', 1024 * 1024));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("refuses 32 MiB + 1 byte on binViewReportSnapshot with 413", async () => {
    const res = await post(SNAPSHOT_PATH, padTo(maximal, BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES + 1));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
    await waitFor(() => gate.inFlight() === 0);
  });

  it("another route still parses a body of exactly 100 kB", async () => {
    const json = '{"pad": ""}';
    const pad = "x".repeat(DEFAULT_LIMIT_BYTES - Buffer.byteLength(json));
    const res = await post(OTHER_PATH, `{"pad": "${pad}"}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ padLength: pad.length });
  });

  it("another route still refuses a body above 100 kB with 413", async () => {
    const res = await post(OTHER_PATH, padTo('{"pad": "x"}', DEFAULT_LIMIT_BYTES + 1));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  it("another route refuses the maximal window that binViewReportSnapshot accepts", async () => {
    const res = await post(OTHER_PATH, maximal);
    expect(res.status).toBe(413);
  });
});

/** Polls `check` until it is true (at most 5 s). */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached within 5 s");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A raw POST with a declared Content-Length; the body is written by the caller. */
function openPost(port: number, path: string, contentLength: number): {
  req: http.ClientRequest;
  response: Promise<RawResponse>;
} {
  const req = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path,
    headers: { "content-type": "application/json", "content-length": String(contentLength) },
  });
  req.on("error", () => undefined); // aborts and early closes are part of these tests
  const response = new Promise<RawResponse>((resolve) => {
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
  });
  return { req, response };
}

/** A legal window above 100 kB without `tracking` (500 entries, 140-character names). */
function largeValidWindow(): string {
  const name = (prefix: string, i: number) => `${prefix}${i}`.padEnd(140, "A");
  return JSON.stringify({
    entries: Array.from({ length: 500 }, (_, e) => ({
      erpnextItemRef: { doctype: "Item", name: name("I", e) },
      quantity: "1",
      stockUom: name("U", e),
    })),
    readAt: "2026-11-08T12:00:00.000+02:00",
  });
}

describe("RT-1284 concurrency bound on large snapshot bodies", () => {
  let app: NestExpressApplication;
  let gate: SnapshotBodyGate;
  let port: number;
  const LARGE = 200 * 1024;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    gate = registerJsonBodyParsers(app);
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    await waitFor(() => gate.inFlight() === 0);
  });

  /** Opens `BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES` large uploads and leaves them unfinished. */
  async function holdAllSlots(): Promise<http.ClientRequest[]> {
    const held = Array.from({ length: BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES }, () => {
      const { req } = openPost(port, SNAPSHOT_PATH, LARGE);
      req.write("{");
      return req;
    });
    await waitFor(() => gate.inFlight() === BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES);
    return held;
  }

  it("bounds large bodies at 2", () => {
    expect(BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES).toBe(2);
  });

  it("answers a third large body 503 snapshot_busy with Retry-After before reading it; aborts release the slots", async () => {
    const held = await holdAllSlots();

    const third = openPost(port, SNAPSHOT_PATH, LARGE);
    third.req.flushHeaders(); // headers only: not one body byte is sent
    // Without the bound the server would wait for the body forever: fail fast instead.
    const res = await Promise.race([
      third.response,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer before the body was sent")), 5000)),
    ]).finally(() => {
      third.req.destroy();
      for (const req of held) req.destroy();
    });
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    const body = JSON.parse(res.body) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("snapshot_busy");
    expect(body.error.request_id).toBe(res.headers["x-request-id"]);

    // Client abort (the held uploads were destroyed above) releases each slot.
    await waitFor(() => gate.inFlight() === 0);
  });

  it("never bounds a body of at most 100 kB, even with every slot taken", async () => {
    const held = await holdAllSlots();
    const small = await request(app.getHttpServer())
      .post(SNAPSHOT_PATH)
      .set("Content-Type", "application/json")
      .send(padTo('{"entries": [], "readAt": "2026-11-08T12:00:00.000+02:00"}', DEFAULT_LIMIT_BYTES));
    expect(small.status).toBe(200);
    expect(small.body).toEqual({ entries: 0 });
    expect(gate.inFlight()).toBe(2);
    for (const req of held) req.destroy();
  });

  it("does not bound another route", async () => {
    const held = await holdAllSlots();
    const other = await request(app.getHttpServer())
      .post(OTHER_PATH)
      .set("Content-Type", "application/json")
      .send('{"pad": "x"}');
    expect(other.status).toBe(200);
    for (const req of held) req.destroy();
  });

  it("releases the slot after a successful large report", async () => {
    const body = largeValidWindow();
    expect(Buffer.byteLength(body)).toBeGreaterThan(DEFAULT_LIMIT_BYTES);
    for (let i = 0; i < BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES + 1; i += 1) {
      const res = await request(app.getHttpServer()).post(SNAPSHOT_PATH).set("Content-Type", "application/json").send(body);
      expect(res.status).toBe(200);
      await waitFor(() => gate.inFlight() === 0);
    }
  });

  it("releases the slot after a parse error and after a validation error", async () => {
    const malformed = await request(app.getHttpServer())
      .post(SNAPSHOT_PATH)
      .set("Content-Type", "application/json")
      .send(`{"entries": [${" ".repeat(LARGE)}`);
    expect(malformed.status).toBe(400);
    await waitFor(() => gate.inFlight() === 0);

    const invalid = await request(app.getHttpServer())
      .post(SNAPSHOT_PATH)
      .set("Content-Type", "application/json")
      .send(padTo('{"entries": "not-an-array"}', LARGE));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("validation_error");
    await waitFor(() => gate.inFlight() === 0);
  });
});

describe("stock-view.yaml 1.5.0-draft — 503 snapshot_busy (additive)", () => {
  type Doc = {
    info: { version: string; description: string };
    paths: Record<string, Record<string, { operationId?: string; responses: Record<string, { $ref?: string }> }>>;
    components: {
      responses: Record<string, { description: string; headers?: Record<string, { $ref?: string }> }>;
      headers: Record<string, { schema: { type: string; minimum?: number } }>;
    };
  };
  const doc = parseYaml(readFileSync(join(CONTRACTS_DIR, "erpnext-connector/stock-view.yaml"), "utf8")) as Doc;
  const op = doc.paths["/api/connector/v1/erpnext/bin-view-requests/{requestRef}/snapshot"]?.["post"];

  it("lists 503 SnapshotBusy with Retry-After on binViewReportSnapshot", () => {
    expect(doc.info.version).toBe("1.5.0-draft");
    expect(op?.operationId).toBe("binViewReportSnapshot");
    expect(op?.responses["503"]).toEqual({ $ref: "#/components/responses/SnapshotBusy" });
    const busy = doc.components.responses["SnapshotBusy"];
    expect(busy?.description).toContain("snapshot_busy");
    expect(busy?.headers?.["Retry-After"]).toEqual({ $ref: "#/components/headers/RetryAfterBusy" });
    expect(doc.components.headers["RetryAfterBusy"]?.schema).toEqual({ type: "integer", minimum: 1 });
    expect(doc.info.description.replace(/\s+/g, " ")).toContain("VERSION 1.5 (RT-1284;");
  });
});

describe("malformed JSON", () => {
  it("still gets 400 on both routes", async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    registerJsonBodyParsers(app);
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    try {
      for (const path of [SNAPSHOT_PATH, OTHER_PATH]) {
        const res = await request(app.getHttpServer()).post(path).set("Content-Type", "application/json").send('{"a":');
        expect(res.status).toBe(400);
      }
    } finally {
      await app.close();
    }
  });
});

describe("isBinViewSnapshotJson", () => {
  const req = (method: string, path: string, contentType?: string) =>
    ({ method, path, headers: contentType === undefined ? {} : { "content-type": contentType } }) as Parameters<
      typeof isBinViewSnapshotJson
    >[0];

  it.each([
    ["POST", SNAPSHOT_PATH, "application/json"],
    ["POST", `${SNAPSHOT_PATH}/`, "application/json; charset=utf-8"],
    ["POST", SNAPSHOT_PATH.toUpperCase(), "Application/JSON"],
    // Looser than type-is by design (documented on isBinViewSnapshotJson).
    ["POST", SNAPSHOT_PATH, "application/json;"],
  ])("takes %s %s (%s)", (method, path, contentType) => {
    expect(isBinViewSnapshotJson(req(method, path, contentType))).toBe(true);
  });

  it.each([
    ["GET", SNAPSHOT_PATH, "application/json"],
    ["POST", SNAPSHOT_PATH, "text/plain"],
    ["POST", SNAPSHOT_PATH, undefined],
    ["POST", `${SNAPSHOT_PATH}x`, "application/json"],
    ["POST", "/api/connector/v1/erpnext/bin-view-requests", "application/json"],
    ["POST", `/api/connector/v1/erpnext/bin-view-requests/a/b/snapshot`, "application/json"],
    ["POST", OTHER_PATH, "application/json"],
  ])("leaves %s %s (%s) to the default parser", (method, path, contentType) => {
    expect(isBinViewSnapshotJson(req(method, path, contentType))).toBe(false);
  });

  it("leaves a request with no path to the default parser", () => {
    expect(isBinViewSnapshotJson({ method: "POST", headers: { "content-type": "application/json" } } as Parameters<
      typeof isBinViewSnapshotJson
    >[0])).toBe(false);
  });
});
