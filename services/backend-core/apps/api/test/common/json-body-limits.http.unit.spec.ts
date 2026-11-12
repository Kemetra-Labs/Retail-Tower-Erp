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
 * RT-1295 — a large snapshot body is read only after its caller passes the
 * route's connector guards on its headers (the real
 * `connectorSnapshotCallerAuthorizer` over in-memory repositories):
 *   - no, invalid, non-connector or session credentials get 401, and a
 *     connector of another environment 403, before one body byte is sent;
 *   - a refused caller never takes a slot, so it cannot block a real connector;
 *   - a client that aborts while it is being authorized never takes a slot.
 */
import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { readFileSync } from "node:fs";
import http from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { load as parseYaml } from "js-yaml";
import request from "supertest";

import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import { connectorSnapshotCallerAuthorizer } from "../../src/auth/connector-snapshot-preauth";
import type { SessionRepository } from "../../src/auth/session.repository";
import { SnapshotReportBodySchema, type SnapshotReportBody } from "../../src/catalog/erpnext-bin-view/dto/snapshot-report.dto";
import {
  StockImportReportSchema,
  type StockImportReport,
} from "../../src/catalog/erpnext-stock-import/dto/stock-import.dto";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import {
  BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES,
  BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES,
  isBinViewSnapshotJson,
  isStockImportReportJson,
  registerJsonBodyParsers,
  STOCK_IMPORT_REPORT_JSON_LIMIT_BYTES,
  type SnapshotBodyGate,
  type SnapshotCallerAuthorizer,
} from "../../src/common/json-body-limits";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { CONTRACTS_DIR } from "../_helpers/openapi-routes";

const REQUEST_REF = "0190f0f0-0000-7000-8000-0000000012a4";
const SNAPSHOT_PATH = `/api/connector/v1/erpnext/bin-view-requests/${REQUEST_REF}/snapshot`;
const OTHER_PATH = "/api/v1/rt-1284-probe/echo";
/** body-parser's default JSON limit, "100kb" = 102,400 bytes. */
const DEFAULT_LIMIT_BYTES = 100 * 1024;
/** For the RT-1284 suites, which test the limits and the bound, not who may call. */
const admitAll: SnapshotCallerAuthorizer = async () => undefined;

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

  @Post("api/connector/v1/erpnext/stock-import-requests/:requestRef/report")
  @HttpCode(200)
  stockImport(
    @Param("requestRef") _requestRef: string,
    @Body(new ZodValidationPipe(StockImportReportSchema)) body: StockImportReport,
  ): { rows: number } {
    return { rows: body.rows.length };
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

const STOCK_IMPORT_PATH = `/api/connector/v1/erpnext/stock-import-requests/${REQUEST_REF}/report`;

/**
 * RT-1288: the largest legal stock-import report (stock-import.yaml: 100 rows,
 * every string at its maximum length), with every name in Arabic, as the
 * Connector sends it (`json.dumps`, `ensure_ascii=True`: `\uXXXX` escapes).
 */
function maximalArabicStockImportReport(): string {
  const name = (prefix: string, i: number) => `${prefix}${i}`.padEnd(140, "\u0645");
  const creation = "2026-11-11T10:00:00.123456+02:00";
  const rows = Array.from({ length: 100 }, (_, i) => ({
    ledgerEntryRef: name("L", i),
    entryIndex: 2147483647,
    voucherType: name("T", i),
    voucherNo: name("N", i),
    voucherDetailNo: name("D", i),
    purpose: name("P", i),
    isReturn: true,
    returnAgainst: name("R", i),
    postingDate: "2026-11-11",
    postingTime: "23:59:59.999999",
    creation,
    isCancelled: true,
    actualQty: `-${"9".repeat(15)}.${"9".repeat(6)}`,
    stockUom: name("U", i),
    erpnextItemRef: { doctype: "Item", name: name("I", i) },
    erpnextBatchRef: { doctype: "Batch", name: name("B", i) },
    hasRetailProvenance: false,
    correctionRef: name("C", i),
  }));
  const last = rows[rows.length - 1]!;
  const body = {
    rows,
    readThrough: { creation, ledgerEntryRef: last.ledgerEntryRef, entryIndex: last.entryIndex },
    exhausted: false,
    readAt: "2026-11-11T12:00:00.000Z",
    refusal: null,
  };
  return pythonStyleJson(body).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
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
    gate = registerJsonBodyParsers(app, admitAll);
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

describe("RT-1288 stockImportReportRows body limit", () => {
  let app: NestExpressApplication;
  let maximal: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    registerJsonBodyParsers(app, admitAll);
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    maximal = maximalArabicStockImportReport();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: string) =>
    request(app.getHttpServer()).post(path).set("Content-Type", "application/json").send(body);

  it("the limit is 2 MiB and covers the largest legal report with Arabic names", () => {
    expect(STOCK_IMPORT_REPORT_JSON_LIMIT_BYTES).toBe(2_097_152);
    expect(Buffer.byteLength(maximal)).toBeGreaterThan(DEFAULT_LIMIT_BYTES);
    expect(Buffer.byteLength(maximal)).toBeLessThan(STOCK_IMPORT_REPORT_JSON_LIMIT_BYTES);
  });

  it("accepts that report on stockImportReportRows (it would be 413 under the 100 kB default)", async () => {
    const res = await post(STOCK_IMPORT_PATH, maximal);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: 100 });
  });

  it("refuses 2 MiB + 1 byte with 413, and another route still refuses the report", async () => {
    const tooLarge = await post(STOCK_IMPORT_PATH, padTo(maximal, STOCK_IMPORT_REPORT_JSON_LIMIT_BYTES + 1));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe("payload_too_large");
    expect((await post(OTHER_PATH, maximal)).status).toBe(413);
  });

  it("matches only POST application/json on the report path", () => {
    const req = (method: string, path: string, contentType: string) =>
      ({ method, path, headers: { "content-type": contentType } }) as Parameters<typeof isStockImportReportJson>[0];
    expect(isStockImportReportJson(req("POST", STOCK_IMPORT_PATH, "application/json"))).toBe(true);
    expect(isStockImportReportJson(req("GET", STOCK_IMPORT_PATH, "application/json"))).toBe(false);
    expect(isStockImportReportJson(req("POST", SNAPSHOT_PATH, "application/json"))).toBe(false);
    expect(isStockImportReportJson(req("POST", STOCK_IMPORT_PATH, "text/plain"))).toBe(false);
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
function openPost(
  port: number,
  path: string,
  contentLength: number,
  extraHeaders: Record<string, string> = {},
): {
  req: http.ClientRequest;
  response: Promise<RawResponse>;
} {
  const req = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path,
    headers: { "content-type": "application/json", "content-length": String(contentLength), ...extraHeaders },
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
    gate = registerJsonBodyParsers(app, admitAll);
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

  it("bounds a compressed body even when its Content-Length is small (it inflates past 100 kB)", async () => {
    const gz = gzipSync(Buffer.from(largeValidWindow()));
    expect(gz.length).toBeLessThan(DEFAULT_LIMIT_BYTES);

    const held = await holdAllSlots();
    const compressed = openPost(port, SNAPSHOT_PATH, gz.length, { "content-encoding": "gzip" });
    compressed.req.end(gz);
    let busy: RawResponse;
    try {
      busy = await Promise.race([
        compressed.response,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer to the compressed body")), 5000)),
      ]);
    } finally {
      compressed.req.destroy();
      for (const req of held) req.destroy();
    }
    expect(busy.status).toBe(503);
    expect((JSON.parse(busy.body) as { error: { code: string } }).error.code).toBe("snapshot_busy");
    await waitFor(() => gate.inFlight() === 0);

    // With a free slot it is admitted, inflated, validated and released.
    const admitted = openPost(port, SNAPSHOT_PATH, gz.length, { "content-encoding": "gzip" });
    admitted.req.end(gz);
    const ok = await admitted.response;
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ entries: 500 });
    await waitFor(() => gate.inFlight() === 0);
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

describe("stock-view.yaml 1.5.0-draft — 413 payload_too_large and 503 snapshot_busy (additive)", () => {
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

  it("lists 413 PayloadTooLarge and 503 SnapshotBusy with Retry-After on binViewReportSnapshot", () => {
    expect(doc.info.version).toBe("1.5.0-draft");
    expect(op?.operationId).toBe("binViewReportSnapshot");
    expect(op?.responses["503"]).toEqual({ $ref: "#/components/responses/SnapshotBusy" });
    expect(op?.responses["413"]).toEqual({ $ref: "#/components/responses/PayloadTooLarge" });
    expect(doc.components.responses["PayloadTooLarge"]?.description).toContain("payload_too_large");
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
    registerJsonBodyParsers(app, admitAll);
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

describe("RT-1295 pre-authentication before a large snapshot body is read", () => {
  const TENANT = "0190f0f0-0000-7000-8000-00000000aaaa";
  const tokenRow = (id: string, scope: string) => ({
    id,
    scope,
    tenantId: TENANT,
    userId: null,
    storeId: null,
  });
  /** Raw bearer → token row; only `connector-*` rows are connector-scoped. */
  const tokens: Record<string, ReturnType<typeof tokenRow>> = {
    "connector-pilot": tokenRow("t-pilot", "connector"),
    "connector-dev": tokenRow("t-dev", "connector"),
    "connector-slow": tokenRow("t-slow", "connector"),
    "pos-device": tokenRow("t-pos", "pos"),
  };
  const registrations: Record<string, string> = { "t-pilot": "pilot", "t-dev": "dev", "t-slow": "pilot" };
  let releaseSlowLookup: () => void = () => undefined;
  let slowLookupStarted = false;
  const authTokens = {
    async findActiveByRawToken(raw: string) {
      if (raw === "connector-slow") {
        slowLookupStarted = true;
        await new Promise<void>((resolve) => (releaseSlowLookup = resolve));
      }
      return tokens[raw] ?? null;
    },
    async findActiveConnectorCredentialByTokenId(tokenId: string) {
      const environment = registrations[tokenId];
      return environment === undefined ? null : { registrationId: `r-${tokenId}`, tenantId: TENANT, environment };
    },
  } as unknown as AuthTokenRepository;
  const sessions = {} as SessionRepository;

  let app: NestExpressApplication;
  let gate: SnapshotBodyGate;
  let port: number;
  let previousEnvironment: string | undefined;
  /** The last request the gate sent to the authorizer (server side). */
  let lastAuthorized: { destroyed: boolean } | undefined;
  const LARGE = 200 * 1024;

  beforeAll(async () => {
    previousEnvironment = process.env["DEPLOYMENT_ENVIRONMENT"];
    process.env["DEPLOYMENT_ENVIRONMENT"] = "pilot";
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    const authorize = connectorSnapshotCallerAuthorizer(sessions, authTokens);
    gate = registerJsonBodyParsers(app, (req, res) => {
      lastAuthorized = req;
      return authorize(req, res);
    });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    if (previousEnvironment === undefined) delete process.env["DEPLOYMENT_ENVIRONMENT"];
    else process.env["DEPLOYMENT_ENVIRONMENT"] = previousEnvironment;
  });

  afterEach(async () => {
    await waitFor(() => gate.inFlight() === 0);
  });

  /** Sends only the headers of a large snapshot upload; fails if no answer comes before the body. */
  async function headersOnly(headers: Record<string, string>, path = SNAPSHOT_PATH): Promise<RawResponse> {
    const upload = openPost(port, path, LARGE, headers);
    upload.req.flushHeaders(); // not one body byte is sent
    return Promise.race([
      upload.response,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer before the body was sent")), 5000)),
    ]).finally(() => upload.req.destroy());
  }

  it.each([
    ["no credential", {}, 401],
    ["an unknown bearer", { authorization: "Bearer not-a-token" }, 401],
    ["a non-connector (POS) bearer", { authorization: "Bearer pos-device" }, 401],
    ["a dashboard session cookie", { cookie: "dp2_session=abc", authorization: "Bearer connector-pilot" }, 401],
    ["a connector of another environment", { authorization: "Bearer connector-dev" }, 403],
  ])("refuses %s before reading the body (%i, Connection: close, no slot)", async (_label, headers, status) => {
    const res = await headersOnly(headers);
    expect(res.status).toBe(status);
    expect(res.headers["connection"]).toBe("close");
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe(status === 401 ? "unauthorized" : "forbidden");
    expect(gate.inFlight()).toBe(0);
  });

  it.each([
    ["no credential", {}, 401],
    ["a connector of another environment", { authorization: "Bearer connector-dev" }, 403],
  ] as const)("RT-1288: refuses %s on a large stockImportReportRows body before reading it (%i)", async (_label, headers, status) => {
    const res = await headersOnly({ ...headers }, STOCK_IMPORT_PATH);
    expect(res.status).toBe(status);
    expect(gate.inFlight()).toBe(0);
  });

  it("unauthenticated uploads cannot hold the slots: a real connector report still gets through", async () => {
    const refused = await Promise.all(
      Array.from({ length: BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES + 1 }, () => headersOnly({})),
    );
    expect(refused.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(gate.inFlight()).toBe(0);

    const ok = await request(app.getHttpServer())
      .post(SNAPSHOT_PATH)
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer connector-pilot")
      .send(largeValidWindow());
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ entries: 500 });
  });

  it("still bounds authorized connectors at 2, and answers an unauthenticated caller 401 (not 503) while full", async () => {
    const held = Array.from({ length: BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES }, () => {
      const { req } = openPost(port, SNAPSHOT_PATH, LARGE, { authorization: "Bearer connector-pilot" });
      req.write("{");
      return req;
    });
    try {
      await waitFor(() => gate.inFlight() === BIN_VIEW_SNAPSHOT_MAX_LARGE_BODIES);
      const busy = await headersOnly({ authorization: "Bearer connector-pilot" });
      expect(busy.status).toBe(503);
      expect((JSON.parse(busy.body) as { error: { code: string } }).error.code).toBe("snapshot_busy");
      const anonymous = await headersOnly({});
      expect(anonymous.status).toBe(401);
    } finally {
      for (const req of held) req.destroy();
    }
  });

  it("does not pre-authenticate a body of at most 100 kB (the route's guards handle it after parsing)", async () => {
    const small = await request(app.getHttpServer())
      .post(SNAPSHOT_PATH)
      .set("Content-Type", "application/json")
      .send('{"entries": [], "readAt": "2026-11-08T12:00:00.000+02:00"}');
    // The probe route has no guards; the real controller's ConnectorAuthGuard refuses it.
    expect(small.status).toBe(200);
  });

  it("a client that aborts while being authorized never takes a slot", async () => {
    slowLookupStarted = false;
    lastAuthorized = undefined;
    const upload = openPost(port, SNAPSHOT_PATH, LARGE, { authorization: "Bearer connector-slow" });
    upload.req.write("{");
    await waitFor(() => slowLookupStarted);
    upload.req.destroy();
    // The server has seen the abort: its "close" has fired, so a slot taken
    // from now on would never be released.
    await waitFor(() => lastAuthorized?.destroyed === true);
    releaseSlowLookup();
    // Let the authorizer's remaining lookup and the gate's continuation run.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(gate.inFlight()).toBe(0);
  });
});
