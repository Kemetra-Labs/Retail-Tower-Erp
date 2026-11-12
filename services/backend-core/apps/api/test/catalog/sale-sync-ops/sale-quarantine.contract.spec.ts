/**
 * RT-1312 Phase 3(a) — the sale quarantine contract, contract-only (owner
 * decision D1, RT-1312 comment 16359; RT-1124 F1/F20, RT-1125 R-02).
 *
 * Two files:
 *   - `pos-sales/sale-quarantine.yaml` 1.0.0-draft: `posQuarantineSale`, the
 *     till's upload of a refused or held sale over the device bearer;
 *   - `sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft: the Console list, read,
 *     repair and write-off of quarantined sales, added beside the NEEDS_REPAIR
 *     operations.
 *
 * Structural / load-only, plus AJV fixtures. No app boot and no HTTP. What
 * this pins:
 *   1. The five new operations at their paths, each with its audit action;
 *      the four Console ones contract-only with a note, the upload
 *      implemented since RT-1312 Phase 3(b); no operationId collision.
 *   2. The upload: device bearer only, with the rotation headers; tenant,
 *      store and device never in the body; natural idempotency (no
 *      Idempotency-Key header); 200/201/409/413 answers; the stored body is an
 *      opaque object, NOT a CaptureSaleRequest.
 *   3. The reason: a closed kind enum, nullable status and code, never a
 *      retried status, and the kind rules (held: no status, no code, a
 *      previous terminal; divergence 409; cashier claim 403).
 *   4. The Console side: cookieAuth, quarantine-specific 404 and 409, repair
 *      needs its own Idempotency-Key; no money and no stored body on the
 *      projection.
 *   5. The NEEDS_REPAIR operations keep no contract-only marker and
 *      `NeedsRepairItem` keeps its exact field set.
 *   6. The delegated decisions (2026-11-11) are written in both files, with no open question left.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type ApiPath,
  type OpenApiDocument,
  type OperationObject,
} from "../../_helpers/openapi-contract";

const POS_ID = "sale-quarantine";
const OPS_ID = "sale-sync-ops";
const UPLOAD: ApiPath = "/api/pos/v1/quarantined-sales";
const LIST: ApiPath = "/api/v1/catalog/sale-sync-ops/quarantined-sales";
const ONE: ApiPath = "/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}";
const REPAIR: ApiPath = "/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/repair";
const WRITE_OFF: ApiPath = "/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/write-off";

const CONSOLE_OPS: ReadonlyArray<readonly [string, ApiPath, "get" | "post", string]> = [
  ["consoleListQuarantinedSales", LIST, "get", "sale_sync_ops.quarantine.listed"],
  ["consoleGetQuarantinedSale", ONE, "get", "sale_sync_ops.quarantine.read"],
  ["consoleRepairQuarantinedSale", REPAIR, "post", "sale_sync_ops.quarantine.repair.requested"],
  ["consoleWriteOffQuarantinedSale", WRITE_OFF, "post", "sale_sync_ops.quarantine.written_off"],
];

const REF = "0a000000-0000-7000-8000-000000001312";
const STORE = "0a000000-0000-7000-8000-000000000003";
const DEVICE = "0a000000-0000-7000-8000-000000000004";
const AT = "2026-11-11T10:00:00.000Z";

let pos: OpenApiDocument;
let ops: OpenApiDocument;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  pos = contractDocument(contracts, POS_ID);
  ops = contractDocument(contracts, OPS_ID);
  ajv.addSchema(pos as object, POS_ID);
  ajv.addSchema(ops as object, OPS_ID);
});

function validator(id: string, name: string): ValidateFunction {
  const v = ajv.getSchema(`${id}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${id} ${name}`);
  return v;
}

function op(doc: OpenApiDocument, path: ApiPath, method: "get" | "post"): OperationObject {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} not declared`);
  return found;
}

function schema(doc: OpenApiDocument, name: string): Record<string, unknown> {
  const found = doc.components?.schemas?.[name] as Record<string, unknown> | undefined;
  if (!found) throw new Error(`schema ${name} not declared`);
  return found;
}

const upload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceSystem: "pos-pulse",
  externalId: "pos-pulse:0a000000-0000-7000-8000-00000000abcd",
  idempotencyKey: "pos-pulse:0a000000-0000-7000-8000-00000000abcd",
  reason: { kind: "refused", httpStatus: 422, errorCode: "sale_tender_mismatch" },
  tillRecordedAt: AT,
  saleBody: { sourceSystem: "pos-pulse", lines: "not validated here" },
  ...over,
});

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  quarantineRef: REF,
  storeId: STORE,
  deviceId: DEVICE,
  sourceSystem: "pos-pulse",
  externalId: "pos-pulse:x",
  reasonKind: "refused",
  tillHttpStatus: 422,
  tillErrorCode: "sale_tender_mismatch",
  state: "open",
  receivedAt: AT,
  tillRecordedAt: AT,
  previousTerminalId: null,
  repairCount: 0,
  lastRepair: null,
  uploadConflictCount: 0,
  saleRef: null,
  summary: { occurredAt: AT, posTotal: "125.50", currencyCode: "EGP", lineCount: 3 },
  writeOff: null,
  ...over,
});

describe("sale quarantine — operations", () => {
  it("the POS file declares only the upload, as 1.0.0-draft", () => {
    expect(pos.info?.version).toBe("1.0.0-draft");
    expect(Object.keys(pos.paths ?? {})).toEqual([UPLOAD]);
    expect(Object.keys(pos.paths![UPLOAD]!)).toEqual(["post"]);
  });

  it("sale-sync-ops is 1.3.0-draft and still has no POS route", () => {
    expect(ops.info?.version).toBe("1.3.0-draft");
    expect(Object.keys(ops.paths ?? {}).filter((p) => p.startsWith("/api/pos/"))).toEqual([]);
  });

  it.each(CONSOLE_OPS)(
    "%s is contract-only, with an RT-1312 note and its audit action",
    (id, path, method, audit) => {
      const o = op(ops, path, method);
      expect(o.operationId).toBe(id);
      expect(o["x-runtime-status"]).toBe("contract-only");
      expect(o["x-runtime-note"]).toEqual(expect.stringContaining("RT-1312 Phase 3(b)"));
      expect(o["x-audit-action"]).toBe(audit);
    },
  );

  it("posQuarantineSale is implemented (RT-1312 Phase 3(b)): no contract-only marker, its audit action kept", () => {
    const o = op(pos, UPLOAD, "post");
    expect(o.operationId).toBe("posQuarantineSale");
    expect(o["x-runtime-status"]).toBeUndefined();
    expect(o["x-runtime-note"]).toBeUndefined();
    expect(o["x-audit-action"]).toBe("pos_sales.quarantine_uploaded");
  });

  it("collides with no operationId elsewhere", () => {
    const contracts = allContracts();
    expect(operationIdsExcept(contracts, POS_ID).has("posQuarantineSale")).toBe(false);
    const others = operationIdsExcept(contracts, OPS_ID);
    for (const [id] of CONSOLE_OPS) expect(others.has(id)).toBe(false);
  });
});

describe("sale quarantine — the POS upload", () => {
  const post = (): OperationObject => op(pos, UPLOAD, "post");

  it("accepts the device bearer only", () => {
    expect(post().security).toEqual([{ device: [] }]);
    expect(Object.keys(pos.components?.securitySchemes ?? {})).toEqual(["device"]);
  });

  it("is naturally idempotent: no Idempotency-Key header; 200 / 201 / 409 / 413", () => {
    expect(post()["x-idempotency" as keyof OperationObject]).toBeUndefined();
    expect(post().parameters).toBeUndefined();
    expect(Object.keys(post().responses ?? {}).sort()).toEqual(["200", "201", "400", "401", "409", "413", "429", "500"]);
    expect(post().responses?.["409"]).toEqual({ $ref: "#/components/responses/QuarantineConflict" });
    expect(post().responses?.["413"]).toEqual({ $ref: "#/components/responses/PayloadTooLarge" });
    expect(pos.components?.responses?.["QuarantineConflict"]?.description).toEqual(
      expect.stringContaining("quarantine_conflict"),
    );
    expect(pos.components?.responses?.["PayloadTooLarge"]?.description).toEqual(
      expect.stringContaining("payload_too_large"),
    );
  });

  it("compares a repeat upload by every field capture leaves out of payload_hash, store first", () => {
    const text = String(pos.info?.description).replace(/\s+/g, " ");
    expect(text).toEqual(expect.stringContaining("RT-1206 rule"));
    for (const field of ["operatorUserId", "admissionCheckAt", "receipt", "safetyRevision", "safetySyncedAt"]) {
      expect(text).toEqual(expect.stringContaining(`\`${field}\``));
    }
    expect(text).toEqual(expect.stringContaining("stores a digest of those facts at the first upload"));
    expect(text).toEqual(expect.stringContaining("The store scope is decided first"));
    expect(text).toEqual(expect.stringContaining("device of the uploading device's tenant AND store"));
  });

  it("declares the device token rotation headers on 200 and 201", () => {
    for (const status of ["200", "201"]) {
      expect(Object.keys(post().responses?.[status]?.headers ?? {}).sort()).toEqual([
        "X-Device-Token-Rotate-After",
        "X-Device-Token-Rotate-Stage",
      ]);
    }
  });

  it("is closed and takes no tenant, store or device from the body", () => {
    const s = schema(pos, "QuarantineSaleUpload");
    expect(s["additionalProperties"]).toBe(false);
    const props = Object.keys(s["properties"] as object);
    expect(props.join(",")).not.toMatch(/tenant|store|deviceId|receivedAt/i);
    expect(validator(POS_ID, "QuarantineSaleUpload")(upload({ storeId: STORE }))).toBe(false);
  });

  it("stores the body as an opaque object, never a CaptureSaleRequest", () => {
    const props = schema(pos, "QuarantineSaleUpload")["properties"] as Record<string, Record<string, unknown>>;
    const body = props["saleBody"]!;
    expect(body).toMatchObject({ type: "object" });
    expect(body["$ref"]).toBeUndefined();
    expect(body["properties"]).toBeUndefined();
    const v = validator(POS_ID, "QuarantineSaleUpload");
    expect(v(upload({ saleBody: { anything: [1, 2] } }))).toBe(true);
    expect(v(upload({ saleBody: "x" }))).toBe(false);
  });

  it("bounds the idempotency key like the capture rule (RT-181)", () => {
    const v = validator(POS_ID, "QuarantineSaleUpload");
    expect(v(upload())).toBe(true);
    expect(v(upload({ idempotencyKey: "short" }))).toBe(false);
    expect(v(upload({ idempotencyKey: "has a space in it ok" }))).toBe(false);
  });

  it("requires a previous terminal for a held sale, and allows one on a refused kind", () => {
    const v = validator(POS_ID, "QuarantineSaleUpload");
    const held = { kind: "held_previous_pairing", httpStatus: null, errorCode: null };
    expect(v(upload({ reason: held, previousTerminalId: DEVICE }))).toBe(true);
    expect(v(upload({ reason: held }))).toBe(false);
    expect(v(upload({ reason: held, previousTerminalId: null }))).toBe(false);
    expect(v(upload({ previousTerminalId: DEVICE }))).toBe(true);
    expect(v(upload({ previousTerminalId: null }))).toBe(true);
  });
});

describe("sale quarantine — the reason", () => {
  const reason = (): ValidateFunction => validator(POS_ID, "QuarantineReason");

  it("closes the kinds", () => {
    expect(schema(pos, "QuarantineReason")["properties"]).toMatchObject({
      kind: { enum: ["refused", "payload_divergence", "cashier_claim_refused", "held_previous_pairing"] },
    });
    expect(reason()({ kind: "not_sendable", httpStatus: null, errorCode: null })).toBe(false);
  });

  it("accepts a non-retryable 4xx or null, never a retried status", () => {
    expect(reason()({ kind: "refused", httpStatus: 422, errorCode: "sale_tender_mismatch" })).toBe(true);
    expect(reason()({ kind: "refused", httpStatus: null, errorCode: null })).toBe(true);
    expect(reason()({ kind: "refused", httpStatus: 404, errorCode: "not_found" })).toBe(true);
    for (const status of [401, 425, 429, 500, 399]) {
      expect(reason()({ kind: "refused", httpStatus: status, errorCode: null })).toBe(false);
    }
    expect(reason()({ kind: "refused", httpStatus: 422, errorCode: "Free Text!" })).toBe(false);
  });

  it("keeps a held sale without status or code", () => {
    expect(reason()({ kind: "held_previous_pairing", httpStatus: null, errorCode: null })).toBe(true);
    expect(reason()({ kind: "held_previous_pairing", httpStatus: 422, errorCode: null })).toBe(false);
    expect(reason()({ kind: "held_previous_pairing", httpStatus: null, errorCode: "x_y" })).toBe(false);
  });

  it("ties payload_divergence to 409 and cashier_claim_refused to 403 when known", () => {
    expect(reason()({ kind: "payload_divergence", httpStatus: 409, errorCode: null })).toBe(true);
    expect(reason()({ kind: "payload_divergence", httpStatus: null, errorCode: null })).toBe(true);
    expect(reason()({ kind: "payload_divergence", httpStatus: 422, errorCode: null })).toBe(false);
    expect(reason()({ kind: "cashier_claim_refused", httpStatus: 403, errorCode: "refused" })).toBe(true);
    expect(reason()({ kind: "cashier_claim_refused", httpStatus: 400, errorCode: null })).toBe(false);
  });

  it("returns a receipt with no sale facts", () => {
    const v = validator(POS_ID, "QuarantineReceipt");
    expect(v({ quarantineRef: REF, state: "open", receivedAt: AT })).toBe(true);
    expect(v({ quarantineRef: REF, state: "open", receivedAt: AT, posTotal: "1.00" })).toBe(false);
  });
});

describe("sale quarantine — the Console operations", () => {
  it("use the file-level cookieAuth session", () => {
    expect(ops.security).toEqual([{ cookieAuth: [] }]);
    for (const [, path, method] of CONSOLE_OPS) {
      const o = op(ops, path, method);
      expect(o.security).toBeUndefined();
      expect(o.responses?.["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
    }
  });

  it("answer a quarantine-specific non-disclosing 404 on the item routes", () => {
    for (const path of [ONE, REPAIR, WRITE_OFF]) {
      const o = op(ops, path, path === ONE ? "get" : "post");
      expect(o.responses?.["404"]).toEqual({ $ref: "#/components/responses/QuarantineNotFound" });
    }
    expect(ops.components?.responses?.["QuarantineNotFound"]?.description).toEqual(
      expect.stringContaining("quarantine ref"),
    );
  });

  it("repair needs the Console request's own Idempotency-Key and answers 409 repair_conflict", () => {
    const repair = op(ops, REPAIR, "post");
    expect(repair["x-idempotency" as keyof OperationObject]).toBe("required");
    expect(repair.parameters).toEqual([
      { $ref: "#/components/parameters/QuarantineRef" },
      { $ref: "#/components/parameters/IdempotencyKey" },
    ]);
    expect(repair.responses?.["409"]).toEqual({ $ref: "#/components/responses/QuarantineRepairConflict" });
    expect(ops.components?.responses?.["QuarantineRepairConflict"]?.description).toEqual(
      expect.stringContaining("repair_conflict"),
    );
    expect(repair.responses?.["403"]).toEqual({ $ref: "#/components/responses/ForbiddenOrOriginRejected" });
    expect(repair.description).toEqual(expect.stringContaining("NOT the sale's capture key"));
  });

  it("states the one-sale-per-provenance guarantee and that the till key is not replayed (D1 wording)", () => {
    const text = String(ops.info?.description);
    expect(text).toEqual(expect.stringContaining("One sale per provenance"));
    expect(text).toEqual(expect.stringContaining("NOT replayed or written into any interceptor partition"));
  });

  it("states the C2 repair rules: membership at occurredAt, no admission check, attribution", () => {
    const text = String(ops.info?.description);
    expect(text).toEqual(expect.stringContaining("member of the tenant at the sale's `occurredAt`"));
    expect(text).toEqual(expect.stringContaining("`repair_operator_unproven`"));
    expect(text).toEqual(expect.stringContaining("admission window is NOT"));
    expect(text).toEqual(expect.stringContaining("`sales.device_id` is the item's `previousTerminalId`"));
    expect(text).toEqual(expect.stringContaining("resolved, not an error"));
  });

  it("write-off: owner/tenant_admin, Idempotency-Key, a required closed note, 409 when not open", () => {
    const w = op(ops, WRITE_OFF, "post");
    expect(w["x-idempotency" as keyof OperationObject]).toBe("required");
    expect(w.parameters).toEqual([
      { $ref: "#/components/parameters/QuarantineRef" },
      { $ref: "#/components/parameters/IdempotencyKey" },
    ]);
    expect(w.responses?.["409"]).toEqual({ $ref: "#/components/responses/QuarantineRepairConflict" });
    expect(w.description).toEqual(expect.stringContaining("`owner` and `tenant_admin`"));
    const req = validator(OPS_ID, "QuarantineWriteOffRequest");
    expect(req({ note: "refunded in cash outside Retail Tower" })).toBe(true);
    expect(req({})).toBe(false);
    expect(req({ note: "" })).toBe(false);
    expect(req({ note: "x".repeat(501) })).toBe(false);
    expect(req({ note: "ok", storeId: STORE })).toBe(false);
  });

  it("projects no stored body; the only money is the summary's POS total (C5)", () => {
    const props = Object.keys(schema(ops, "QuarantinedSale")["properties"] as object);
    expect(props.join(",")).not.toMatch(/total|amount|saleBody|tenant/i);
    expect(Object.keys(schema(ops, "QuarantineSaleSummary")["properties"] as object).sort()).toEqual(
      ["currencyCode", "lineCount", "occurredAt", "posTotal"],
    );
    const v = validator(OPS_ID, "QuarantinedSale");
    expect(v(item())).toBe(true);
    expect(
      v(item({ summary: { occurredAt: null, posTotal: null, currencyCode: null, lineCount: null } })),
    ).toBe(true);
    expect(v(item({ summary: { occurredAt: AT, posTotal: 125.5, currencyCode: "EGP", lineCount: 3 } }))).toBe(
      false,
    );
    expect(
      v(item({ summary: { occurredAt: AT, posTotal: "1", currencyCode: "EGP", lineCount: 1, lines: [] } })),
    ).toBe(false);
    expect(
      v(
        item({
          state: "written-off",
          writeOff: { at: AT, note: "refunded in cash outside Retail Tower" },
        }),
      ),
    ).toBe(true);
    expect(
      v(
        item({
          state: "captured",
          saleRef: REF,
          repairCount: 1,
          lastRepair: { at: AT, outcome: "captured", httpStatus: null, errorCode: null },
        }),
      ),
    ).toBe(true);
    expect(v(item({ saleBody: {} }))).toBe(false);
    expect(v(item({ state: "dismissed" }))).toBe(false);
    expect(v(item({ tillErrorCode: "Not A Label" }))).toBe(false);
    expect(v(item({ summary: { occurredAt: AT, posTotal: "-1.00", currencyCode: "EGP", lineCount: 1 } }))).toBe(
      false,
    );
  });

  it("pages at most 200 items, with a UUIDv7 cursor", () => {
    expect(schema(ops, "QuarantinedSalePage")["properties"]).toMatchObject({ items: { maxItems: 200 } });
    expect(ops.components?.parameters?.["QuarantineCursor"]).toMatchObject({
      name: "cursor",
      schema: { pattern: expect.stringContaining("-7[0-9a-fA-F]{3}-") },
    });
  });

  it("keeps the state and reason values equal in both files and in the list filter", () => {
    expect(schema(ops, "QuarantineState")["enum"]).toEqual(schema(pos, "QuarantineState")["enum"]);
    expect(ops.components?.parameters?.["QuarantineStateQuery"]).toMatchObject({
      schema: { enum: schema(ops, "QuarantineState")["enum"] },
    });
    const kind = (schema(pos, "QuarantineReason")["properties"] as Record<string, Record<string, unknown>>)["kind"]!;
    expect(schema(ops, "QuarantineReasonKind")["enum"]).toEqual(kind["enum"]);
    expect(schema(ops, "QuarantineErrorCode")["pattern"]).toEqual(schema(pos, "ErrorCodeLabel")["pattern"]);
  });
});

describe("sale quarantine — the NEEDS_REPAIR surface keeps its shape", () => {
  it("keeps the four original operations without a contract-only marker", () => {
    for (const [path, method] of [
      ["/api/v1/catalog/sale-sync-ops/sales/{saleRef}/status", "get"],
      ["/api/v1/catalog/sale-sync-ops/needs-repair", "get"],
      ["/api/v1/catalog/sale-sync-ops/sales/{saleRef}/audit-timeline", "get"],
      ["/api/v1/catalog/sale-sync-ops/sales/{saleRef}/repair", "post"],
    ] as const) {
      expect(op(ops, path, method)["x-runtime-status"]).toBeUndefined();
    }
  });

  it("keeps NeedsRepairItem keyed by the captured sale, with its exact field set", () => {
    const s = schema(ops, "NeedsRepairItem");
    expect(s["additionalProperties"]).toBe(false);
    expect(Object.keys(s["properties"] as object).sort()).toEqual(
      [
        "externalId",
        "quarantinedAt",
        "reasonCode",
        "retryCount",
        "saleRef",
        "sourceSystem",
        "storeId",
        "syncStatus",
      ].sort(),
    );
  });
});

describe("sale quarantine — the delegated decisions are written down", () => {
  it.each([
    [
      POS_ID,
      [
        "decision P1",
        "decision P2",
        "Retention (decision P3)",
        "decision P4",
        "Size (decision P5)",
        "P6 the upload has its own per-device write budget",
        "never the 30 days",
        "256 kB",
      ],
    ],
    [OPS_ID, ["decision\n    C1", "decision C2", "decision C3", "decisions P3, C4", "decision\n    C5", "decisions P4, C6"]],
  ] as const)("%s records its decisions and has no open question left", (id, phrases) => {
    const text = String((id === POS_ID ? pos : ops).info?.description).replace(/\s+/g, " ");
    expect(text).toEqual(expect.stringContaining("Claude under owner delegation, 2026-11-11"));
    expect(text).not.toMatch(/open owner question|owner question \d/i);
    for (const phrase of phrases) expect(text).toEqual(expect.stringContaining(phrase.replace(/\s+/g, " ")));
  });
});
