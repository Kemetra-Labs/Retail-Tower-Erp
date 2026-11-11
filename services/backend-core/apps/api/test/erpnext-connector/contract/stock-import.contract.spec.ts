/**
 * apps/api/test/erpnext-connector/contract/stock-import.contract.spec.ts
 *
 * RT-1286 (Inventory Gate 8 P2, [GATED: OpenAPI]) — conformance test for
 * `packages/contracts/openapi/erpnext-connector/stock-import.yaml`, the
 * contract-only ERP-origin stock import feed that RT-1287 (Connector reader)
 * and RT-1288 (Backend-Core ingestion) build against.
 *
 * Loaded with an explicit `dir`, like `stock-view.contract.spec.ts`, because
 * the production loader's directory scan is non-recursive (R9). Structural
 * checks pin the transport (pull + idempotent report, connectorBearer,
 * non-disclosing 404, strict bodies, no valuation, no contract-only marker since RT-1288);
 * Ajv (JSON Schema 2020-12, the OpenAPI 3.1 dialect) validates instances,
 * because the refusal rule is an `if`/`then`. The last section proves the
 * acceptance criterion that the DC-4 key
 * `('erpnext','<vt>:<vno>:<detail>[:<batch>]')` can be built from the
 * reported fields, and that `ledgerEntryRef` tells a cancellation's reverse
 * row from its original.
 *
 * Load-only: no app boot, no HTTP, no Docker.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

const CONTRACT_ID = "stock-import";
const OPERATION_IDS = ["stockImportPullRequests", "stockImportReportRows"] as const;
const PULL_PATH = "/api/connector/v1/erpnext/stock-import-requests";
const REPORT_PATH = "/api/connector/v1/erpnext/stock-import-requests/{requestRef}/report";

function openapiSubDir(sub: string): string {
  return resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi", sub);
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: unknown;
  parameters?: Array<{ $ref?: string }>;
  responses?: Record<string, { $ref?: string }>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-idempotency"?: string;
}

interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, { pattern?: string; type?: string | string[]; enum?: string[] }>;
  description?: string;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, { in?: string; name?: string; required?: boolean; schema?: Record<string, unknown> }>;
    responses?: Record<string, { description?: string }>;
  };
}

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;

function collectOperationIds(docs: OpenApiDocument[], into: Set<string>): void {
  for (const d of docs) {
    for (const item of Object.values(d.paths ?? {})) {
      for (const op of Object.values(item)) {
        if (typeof op?.operationId === "string") into.add(op.operationId);
      }
    }
  }
}

beforeAll(() => {
  const connectorContracts = loadOpenApiContracts({ dir: openapiSubDir("erpnext-connector") });
  const contract = connectorContracts.find((c) => c.id === CONTRACT_ID);
  if (!contract) {
    throw new Error(`${CONTRACT_ID} not found; loaded ids: [${connectorContracts.map((c) => c.id).join(", ")}]`);
  }
  doc = contract.document as OpenApiDocument;

  otherOperationIds = new Set<string>();
  collectOperationIds(loadOpenApiContracts().map((c) => c.document as OpenApiDocument), otherOperationIds);
  for (const sub of ["catalog", "pos-sales", "inventory", "pos-payments", "connector", "erpnext-reconciliation", "erpnext-sync-ops", "sale-sync-ops", "settlement"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map((c) => c.document as OpenApiDocument),
      otherOperationIds,
    );
  }
  for (const c of connectorContracts) {
    if (c.id !== CONTRACT_ID) collectOperationIds([c.document as OpenApiDocument], otherOperationIds);
  }
});

const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ");
const info = (): string => flat(doc.info?.description);
const schema = (name: string): SchemaObject => {
  const s = doc.components?.schemas?.[name];
  if (!s) throw new Error(`schema ${name} missing`);
  return s;
};
const op = (path: string, method: string): OperationObject => {
  const o = doc.paths?.[path]?.[method];
  if (!o) throw new Error(`${method} ${path} missing`);
  return o;
};
const operations = (): OperationObject[] =>
  Object.values(doc.paths ?? {}).flatMap((item) => Object.values(item));

// ===========================================================================
// 1. Document and transport
// ===========================================================================
describe("erpnext-connector/stock-import.yaml — document (RT-1286)", () => {
  it("is OpenAPI 3.1 at 1.0.1-draft and cites the gate, the planning record and the consumers", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.1-draft");
    expect(info()).toContain("RT-1286 (Inventory Gate 8 follow-up P2; [GATED: OpenAPI] owner go-ahead 2026-11-11");
    expect(info()).toContain("Confluence page 70680596, §3 row (b)");
    expect(info()).toContain("the Connector reader is RT-1287 and the Backend-Core ingestion is RT-1288");
  });

  it("records the owner decisions of 2026-11-11 and the v16 bench", () => {
    expect(info()).toContain("one report row per Batch entry; `ledgerEntryRef` on every row; a refused request answered with a refusal report");
    expect(info()).toContain("pinned v16 bench (Frappe v16.52.0 / ERPNext v16.51.0");
    expect(info()).not.toMatch(/v15/);
  });

  it("records captain decisions D1-D3: warehouse-specific key, entryIndex cursor, settle bound", () => {
    expect(info()).toContain("DC-4 KEY (captain decision D1, owner delegation 2026-11-11, RT-1286)");
    expect(info()).toContain("`voucherType`, `voucherNo`, `voucherDetailNo`, the request's `erpnextWarehouseRef`, and, when the row has one, `erpnextBatchRef.name`");
    expect(info()).toContain("two effects of one voucher row at different warehouses");
    expect(info()).toContain("MUST NEVER share a key");
    expect(info()).toContain("CURSOR, SETTLE AND OVERLAP (captain decisions D2 and D3");
    expect(info()).toContain("A page may end inside a ledger row");
    expect(info()).toContain("A transaction open longer than `settleSeconds` can still commit behind the cursor");
    expect(info()).toContain("default `settleSeconds` 300 until measured");
    const settle = flat(JSON.stringify(schema("StockImportRequest").properties?.["settleSeconds"]));
    expect(settle).toContain("site database clock");
    expect(schema("StockImportRequest").required).toContain("settleSeconds");
  });

  it("states facts only, no classification on the wire (G8-7), and the Backend-Core-first rollout", () => {
    expect(info()).toContain("FACTS ONLY (G8-7)");
    expect(info()).toContain("It classifies nothing and filters nothing by business rule");
    expect(info()).toContain("ROLLOUT ORDER (Backend-Core first");
  });

  it("declares exactly the two operations, unique across every shipped contract", () => {
    const ids = operations().map((o) => o.operationId).sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
    for (const id of OPERATION_IDS) expect(otherOperationIds.has(id)).toBe(false);
    expect(op(PULL_PATH, "get").operationId).toBe("stockImportPullRequests");
    expect(op(REPORT_PATH, "post").operationId).toBe("stockImportReportRows");
  });

  it("is served by RT-1288: neither operation keeps a contract-only marker (1.0.1-draft)", () => {
    for (const o of operations()) {
      expect(o["x-runtime-status"]).toBeUndefined();
      expect(o["x-runtime-note"]).toBeUndefined();
    }
    expect(info()).toContain("1.0.1-draft lifts their contract-only markers; wording only, no shape change");
  });

  it("uses the connector namespace and the connectorBearer machine scheme only", () => {
    for (const path of Object.keys(doc.paths ?? {})) expect(path.startsWith("/api/connector/v1/erpnext/")).toBe(true);
    for (const o of operations()) expect(o.security).toEqual([{ connectorBearer: [] }]);
    const scheme = doc.components?.securitySchemes?.["connectorBearer"] as { type?: string; scheme?: string };
    expect(scheme).toEqual(expect.objectContaining({ type: "http", scheme: "bearer" }));
    expect(doc.components?.securitySchemes?.["clerkJwt"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.["cookieAuth"]).toBeUndefined();
  });

  it("the pull takes since + bounded limit and answers the stock-view response set", () => {
    const pull = op(PULL_PATH, "get");
    expect(pull.parameters?.map((p) => p.$ref)).toEqual(["#/components/parameters/Since", "#/components/parameters/Limit"]);
    expect(Object.keys(pull.responses ?? {}).sort()).toEqual(["200", "400", "401", "403", "404", "409", "500"]);
    expect(pull.responses?.["409"]?.$ref).toBe("#/components/responses/SnapshotRequired");
    expect(doc.components?.parameters?.["Limit"]?.schema).toEqual(expect.objectContaining({ minimum: 1, maximum: 500 }));
  });

  it("the report requires the Idempotency-Key, binds requestRef in the path and replays with 200", () => {
    const report = op(REPORT_PATH, "post");
    expect(report["x-idempotency"]).toBe("required");
    expect(report.parameters?.map((p) => p.$ref)).toEqual([
      "#/components/parameters/RequestRef",
      "#/components/parameters/IdempotencyKey",
    ]);
    const key = doc.components?.parameters?.["IdempotencyKey"];
    expect(key).toEqual(expect.objectContaining({ in: "header", name: "Idempotency-Key", required: true }));
    expect(key?.schema?.["pattern"]).toBe("^[\\x21-\\x7E]{16,128}$");
    expect(doc.components?.parameters?.["RequestRef"]).toEqual(expect.objectContaining({ in: "path", required: true }));
    expect(Object.keys(report.responses ?? {}).sort()).toEqual(["200", "201", "400", "401", "403", "404", "409", "413", "500"]);
  });

  it("the 404 is non-disclosing and the closed error set is stated", () => {
    expect(flat(doc.components?.responses?.["NotFound"]?.description)).toContain("identical for cross-tenant, out-of-scope and genuinely-absent refs, with no existence leak");
    const errorCodeText = flat(JSON.stringify(doc.components?.schemas?.["Error"]));
    for (const c of ["validation_error", "snapshot_required", "idempotency_key_conflict", "import_report_conflict", "not_found", "forbidden", "payload_too_large", "system_failure"]) {
      expect(errorCodeText).toContain(c);
    }
  });
});

// ===========================================================================
// 2. Schemas: strict, scoped, no valuation
// ===========================================================================
describe("stock-import.yaml — schemas", () => {
  const OBJECT_SCHEMAS = [
    "ErpnextItemRef", "ErpnextBatchRef", "LedgerKey", "StockImportRequest", "StockImportPage",
    "StockImportReport", "StockImportRefusal", "StockImportRow", "RecordedStockImport",
  ];

  it("every payload schema is strict (additionalProperties: false)", () => {
    for (const name of OBJECT_SCHEMAS) expect(schema(name).additionalProperties).toBe(false);
  });

  it("no schema carries tenant scope, credentials or any valuation field", () => {
    const forbidden = /^(tenant_?id|tenantId|password|token|secret|rate|valuation_?rate|valuationRate|incoming_?rate|amount|cost|price|stock_value|stockValue)$/i;
    const offenders = Object.entries(doc.components?.schemas ?? {}).flatMap(([name, s]) =>
      Object.keys(s.properties ?? {}).filter((prop) => forbidden.test(prop)).map((prop) => `${name}.${prop}`),
    );
    expect(offenders).toEqual([]);
    expect(Object.keys(schema("StockImportReport").properties ?? {})).not.toContain("storeId");
  });

  it("the row carries every §3 (b) fact, all required", () => {
    expect(schema("StockImportRow").required?.slice().sort()).toEqual([
      "actualQty", "correctionRef", "creation", "entryIndex", "erpnextBatchRef", "erpnextItemRef", "hasRetailProvenance",
      "isCancelled", "isReturn", "ledgerEntryRef", "postingDate", "postingTime", "purpose", "returnAgainst",
      "stockUom", "voucherDetailNo", "voucherNo", "voucherType",
    ]);
  });

  it("quantities are exact-decimal strings with the stock-view pattern", () => {
    expect(schema("StockImportRow").properties?.["actualQty"]).toEqual(
      expect.objectContaining({ type: "string", pattern: "^-?[0-9]{1,15}(\\.[0-9]{1,6})?$" }),
    );
  });

  it("the Item and Batch refs are verbatim the stock-view ones", () => {
    const stockView = loadOpenApiContracts({ dir: openapiSubDir("erpnext-connector") }).find((c) => c.id === "stock-view");
    const sv = (stockView?.document as OpenApiDocument).components?.schemas ?? {};
    expect(schema("ErpnextItemRef")).toEqual(sv["ErpnextItemRef"]);
    expect(schema("ErpnextBatchRef").properties).toEqual(sv["ErpnextBatchRef"]?.properties);
    expect(schema("ErpnextBatchRef").required).toEqual(sv["ErpnextBatchRef"]?.required);
  });

  it("voucherType and purpose are open strings, never an enum (no classification on the wire)", () => {
    expect(JSON.stringify(schema("StockImportRow").properties?.["voucherType"])).not.toContain("enum");
    expect(JSON.stringify(schema("StockImportRow").properties?.["purpose"])).not.toContain("enum");
  });

  it("maxRows is bounded at 100 and the report rows array at 100", () => {
    expect(schema("StockImportRequest").properties?.["maxRows"]).toEqual(expect.objectContaining({ minimum: 1, maximum: 100 }));
    expect((schema("StockImportReport").properties?.["rows"] as unknown as { maxItems?: number }).maxItems).toBe(100);
  });
});

// ===========================================================================
// 3. Instances (Ajv)
// ===========================================================================
describe("stock-import.yaml — instances", () => {
  let validateRequest: ValidateFunction;
  let validateReport: ValidateFunction;
  let validateRecorded: ValidateFunction;

  beforeAll(() => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ ...(doc as object), $id: "stock-import" });
    const compile = (name: string): ValidateFunction => ajv.compile({ $ref: `stock-import#/components/schemas/${name}` });
    validateRequest = compile("StockImportRequest");
    validateReport = compile("StockImportReport");
    validateRecorded = compile("RecordedStockImport");
  });

  const expectValid = (validate: ValidateFunction, instance: unknown): void => {
    const ok = validate(instance);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  };
  const expectInvalid = (validate: ValidateFunction, instance: unknown): void => {
    expect(validate(instance)).toBe(false);
  };

  const READ_AT = "2026-11-11T10:00:00.000+02:00";
  const request = (overrides: Record<string, unknown> = {}) => ({
    requestRef: "00000000-0000-7000-8000-00000000e001",
    runRef: "00000000-0000-7000-8000-00000000a001",
    pageSeq: 0,
    storeId: "00000000-0000-7000-8000-00000000570e",
    erpnextWarehouseRef: "Stores - RT",
    after: { creation: "2026-11-11T09:55:00.000000+02:00", ledgerEntryRef: null, entryIndex: null },
    settleSeconds: 300,
    overlapSeconds: 300,
    maxRows: 100,
    itemCursor: "c1",
    ...overrides,
  });
  const row = (overrides: Record<string, unknown> = {}) => ({
    ledgerEntryRef: "SLE-0001",
    entryIndex: 0,
    voucherType: "Purchase Receipt",
    voucherNo: "MAT-PRE-2026-00001",
    voucherDetailNo: "pri-row-1",
    purpose: null,
    isReturn: false,
    returnAgainst: null,
    postingDate: "2026-11-11",
    postingTime: "09:58:12.123456",
    creation: "2026-11-11T09:58:12.512345+02:00",
    isCancelled: false,
    actualQty: "24.000000",
    stockUom: "Box",
    erpnextItemRef: { doctype: "Item", name: "PANADOL-24" },
    erpnextBatchRef: { doctype: "Batch", name: "B-2026-11-A" },
    hasRetailProvenance: false,
    correctionRef: null,
    ...overrides,
  });
  const report = (rows: unknown[], overrides: Record<string, unknown> = {}) => ({
    rows,
    readThrough: rows.length === 0 ? null : { creation: "2026-11-11T09:58:12.512345+02:00", ledgerEntryRef: "SLE-0001", entryIndex: 0 },
    exhausted: true,
    readAt: READ_AT,
    ...overrides,
  });

  it("a page-0 request with a null-ref overlap bound, a continuation page and a first-ever request validate", () => {
    expectValid(validateRequest, request());
    expectValid(validateRequest, request({ pageSeq: 1, overlapSeconds: 0, after: { creation: "2026-11-11T09:58:12.512345+02:00", ledgerEntryRef: "SLE-0001", entryIndex: 3 } }));
    expectValid(validateRequest, request({ after: null, overlapSeconds: 0 }));
  });

  it("a null-ref bound with an entryIndex, or a request without settleSeconds, is invalid", () => {
    expectInvalid(validateRequest, request({ after: { creation: "2026-11-11T09:55:00+02:00", ledgerEntryRef: null, entryIndex: 0 } }));
    const { settleSeconds: _settle, ...noSettle } = request();
    expectInvalid(validateRequest, noSettle);
    expectInvalid(validateRequest, request({ settleSeconds: 3601 }));
  });

  it("a request with maxRows above 100, an unknown key or no warehouse is invalid", () => {
    expectInvalid(validateRequest, request({ maxRows: 101 }));
    expectInvalid(validateRequest, request({ tenantId: "t" }));
    const { erpnextWarehouseRef: _omit, ...noWarehouse } = request();
    expectInvalid(validateRequest, noWarehouse);
  });

  it("a Purchase Receipt batch row, a non-batch Stock Entry row and an empty exhausted page validate", () => {
    expectValid(validateReport, report([row()]));
    expectValid(validateReport, report([row({ voucherType: "Stock Entry", purpose: "Manufacture", erpnextBatchRef: null })]));
    expectValid(validateReport, report([]));
  });

  it("a float quantity, a bad posting time or a valuation field on a row is invalid", () => {
    expectInvalid(validateReport, report([row({ actualQty: 24 })]));
    expectInvalid(validateReport, report([row({ actualQty: "1e3" })]));
    expectInvalid(validateReport, report([row({ postingTime: "25:00:00" })]));
    expectInvalid(validateReport, report([row({ valuationRate: "10.00" })]));
  });

  it("a readThrough without a ledgerEntryRef or entryIndex is invalid", () => {
    expectInvalid(validateReport, report([row()], { readThrough: { creation: "2026-11-11T09:58:12.512345+02:00", ledgerEntryRef: null, entryIndex: null } }));
    expectInvalid(validateReport, report([row()], { readThrough: { creation: "2026-11-11T09:58:12.512345+02:00", ledgerEntryRef: "SLE-0001", entryIndex: null } }));
    expectInvalid(validateReport, report([row()], { readThrough: { creation: "2026-11-11T09:58:12.512345+02:00", ledgerEntryRef: "SLE-0001" } }));
  });

  it("a page may end inside a ledger row (D2): its readThrough names the last Batch entry", () => {
    const first = row({ entryIndex: 0, erpnextBatchRef: { doctype: "Batch", name: "B-A" } });
    const second = row({ entryIndex: 1, erpnextBatchRef: { doctype: "Batch", name: "B-B" } });
    expectValid(validateReport, report([first, second], {
      readThrough: { creation: first.creation, ledgerEntryRef: "SLE-0001", entryIndex: 1 },
      exhausted: false,
    }));
  });

  it("an empty page without a refusal must be exhausted (no rewind to a null position)", () => {
    expectInvalid(validateReport, report([], { exhausted: false }));
    expectInvalid(validateReport, report([], { exhausted: false, refusal: null }));
    expectValid(validateReport, report([], { exhausted: true, refusal: null }));
  });

  it("a refusal report validates only with no rows, a null readThrough and exhausted false", () => {
    const refusal = { reason: "unknown_warehouse" };
    expectValid(validateReport, report([], { exhausted: false, refusal }));
    expectInvalid(validateReport, report([], { exhausted: false, refusal: { reason: "ledger_row_too_large" } }));
    expectInvalid(validateReport, report([row()], { exhausted: false, refusal }));
    expectInvalid(validateReport, report([], { exhausted: true, refusal }));
    expectInvalid(validateReport, report([], { exhausted: false, refusal: { reason: "unmapped_item" } }));
    expectValid(validateReport, report([row()], { refusal: null }));
  });

  it("the report carries no scope: a body storeId or tenant_id is invalid", () => {
    expectInvalid(validateReport, report([row()], { storeId: "00000000-0000-7000-8000-00000000570e" }));
    expectInvalid(validateReport, report([row()], { tenant_id: "t" }));
  });

  it("RecordedStockImport carries both clocks and validates", () => {
    expectValid(validateRecorded, {
      requestRef: "00000000-0000-7000-8000-00000000e001",
      runRef: "00000000-0000-7000-8000-00000000a001",
      pageSeq: 0,
      erpnextWarehouseRef: "Stores - RT",
      recordedRowCount: 1,
      exhausted: true,
      refused: false,
      readAt: READ_AT,
      recordedAt: "2026-11-11T08:00:01.000Z",
    });
  });

  // =========================================================================
  // 4. AC: the DC-4 key can be built from the reported fields
  // =========================================================================
  describe("DC-4 key derivation (acceptance criterion)", () => {
    type Row = ReturnType<typeof row>;
    /**
     * The key components the contract makes normative (D1): voucher type, voucher no, detail
     * row, the request's warehouse, the Batch when present, and `cancel` for a compensating
     * effect. RT-1288 fixes the string format; a component tuple stands in for it here.
     */
    const dc4Key = (r: Row, warehouse: string, reverse: boolean): string[] => [
      "erpnext", r.voucherType, r.voucherNo, String(r.voucherDetailNo), warehouse,
      ...(r.erpnextBatchRef === null ? [] : [(r.erpnextBatchRef as { name: string }).name]),
      ...(reverse ? ["cancel"] : []),
    ];
    const same = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);
    /** The reverse-row rule: of two cancelled rows of one voucher row and Batch, the later created one. */
    const reverseOf = (a: Row, b: Row): Row => (Date.parse(b.creation) > Date.parse(a.creation) ? b : a);

    it("builds distinct keys for each Batch entry of one ledger row", () => {
      const a = row({ entryIndex: 0, erpnextBatchRef: { doctype: "Batch", name: "B-A" }, actualQty: "10.000000" });
      const b = row({ entryIndex: 1, erpnextBatchRef: { doctype: "Batch", name: "B-B" }, actualQty: "14.000000" });
      expectValid(validateReport, report([a, b], { readThrough: { creation: a.creation, ledgerEntryRef: "SLE-0001", entryIndex: 1 } }));
      expect(dc4Key(a, "Stores - RT", false)).toEqual(["erpnext", "Purchase Receipt", "MAT-PRE-2026-00001", "pri-row-1", "Stores - RT", "B-A"]);
      expect(same(dc4Key(a, "Stores - RT", false), dc4Key(b, "Stores - RT", false))).toBe(false);
    });

    it("builds the un-batched key for a row with no Batch", () => {
      expect(dc4Key(row({ erpnextBatchRef: null }), "Stores - RT", false)).toEqual(
        ["erpnext", "Purchase Receipt", "MAT-PRE-2026-00001", "pri-row-1", "Stores - RT"],
      );
    });

    it("never gives one voucher row's effects at two warehouses the same key (D1)", () => {
      const out = row({ voucherType: "Stock Entry", voucherNo: "MAT-STE-2026-00009", purpose: "Material Transfer", actualQty: "-5.000000", erpnextBatchRef: null });
      const inn = row({ voucherType: "Stock Entry", voucherNo: "MAT-STE-2026-00009", purpose: "Material Transfer", ledgerEntryRef: "SLE-0003", actualQty: "5.000000", erpnextBatchRef: null });
      expect(out.voucherDetailNo).toBe(inn.voucherDetailNo);
      expect(same(dc4Key(out, "Stores - A", false), dc4Key(inn, "Stores - B", false))).toBe(false);
    });

    it("identifies a cancellation's reverse row as the later created one and keys it with cancel", () => {
      const original = row({ isCancelled: true });
      const reverse = row({
        ledgerEntryRef: "SLE-0002",
        isCancelled: true,
        actualQty: "-24.000000",
        creation: "2026-11-11T09:59:00.000000+02:00",
      });
      expectValid(validateReport, report([original, reverse], { readThrough: { creation: reverse.creation, ledgerEntryRef: "SLE-0002", entryIndex: 0 } }));
      expect(original.voucherDetailNo).toBe(reverse.voucherDetailNo);
      expect(reverseOf(original, reverse)).toBe(reverse);
      expect(reverseOf(reverse, original)).toBe(reverse);
      const reverseKey = dc4Key(reverseOf(original, reverse), "Stores - RT", true);
      expect(reverseKey[reverseKey.length - 1]).toBe("cancel");
      expect(same(reverseKey, dc4Key(original, "Stores - RT", false))).toBe(false);
    });

    it("an ERP-native Purchase Return is reportable as a negative row with its return link (Q4)", () => {
      expectValid(validateReport, report([row({ isReturn: true, returnAgainst: "MAT-PRE-2026-00001", voucherNo: "MAT-PRE-RET-2026-00001", actualQty: "-2.000000" })]));
    });

    it("a governed correction carries its reference; a Retail-provenance voucher is flagged (Q3, 899)", () => {
      expectValid(validateReport, report([row({ voucherType: "Stock Reconciliation", purpose: "Stock Reconciliation", correctionRef: "BRK-2026-0007" })]));
      expectValid(validateReport, report([row({ voucherType: "Sales Invoice", hasRetailProvenance: true, actualQty: "-1.000000" })]));
    });
  });
});
