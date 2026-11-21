/**
 * RT-1544 (RP-1 of specs/045-return-policy; owner decisions OD-272-1..11 of
 * RT-272 comment 12791) — `pos-sales/sales.yaml` 1.27.0-draft: the additive
 * Return Policy fields on `recordReturn`. `[GATED: contract]`, approved by the
 * owner on RT-1544 comment 18145. CONTRACT ONLY: no runtime, no migration, no
 * consumer; enforcement stays off. Structural / load-only plus AJV fixtures;
 * no app boot.
 *
 * Pins:
 *   1. the version and the info note (decisions, additive shape, rollout order);
 *   2. `RecordReturnRequest.lines[]` gains the optional line `reasonCode` (the
 *      closed OD-272-8 catalogue) and `reasonNote`, through a NEW schema, so
 *      `recordCreditSaleReversal` (which shares `ReturnLineRequest`) is
 *      untouched;
 *   3. legacy bodies stay valid: a `RecordReturnRequest` without the new
 *      fields, and a `SaleReturn` without `returnPolicy`;
 *   4. `SaleReturn.returnPolicy` is optional and is exactly {revisionId,
 *      source, windowEndsOn, legalFloorDays}; no existing `required` list moves;
 *   5. the three 422 codes, the order of the policy checks and the carried
 *      `lineRef` / `reason` of `return_line_not_returnable`;
 *   6. the change is additive: no operation, status or other schema changes.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  type OperationObject,
  type OpenApiDocument,
  type SchemaObject,
} from "../../../_helpers/openapi-contract";

const CONTRACT_ID = "sales";
const RETURNS_PATH = "/api/pos/v1/sales/{saleRef}/returns";

let sales: OpenApiDocument;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  sales = contractDocument(allContracts(), CONTRACT_ID);
  ajv.addSchema(sales as object, CONTRACT_ID);
});

const flat = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ");

function schema(name: string): SchemaObject {
  const found = sales.components?.schemas?.[name];
  if (!found) throw new Error(`${name} not declared`);
  return found;
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

function recordReturn(): OperationObject {
  const found = sales.paths?.[RETURNS_PATH]?.["post"];
  if (!found) throw new Error("recordReturn not declared");
  return found;
}

function props(name: string): Record<string, Record<string, unknown>> {
  return (schema(name).properties ?? {}) as Record<string, Record<string, unknown>>;
}

const SALE = "0190f5a2-3b4c-7d8e-9f01-0000000000d1";
const RETURN = "0190f5a2-3b4c-7d8e-9f01-0000000000f1";
const LINE = "0190f5a2-3b4c-7d8e-9f01-0000000000e1";
const REVISION = "0190f5a2-3b4c-7d8e-9f01-0000000000b2";
const CATALOGUE = ["defective", "wrong_item", "not_as_described", "changed_mind", "other"];

const LEGACY_REQUEST = {
  sourceSystem: "pos-pulse",
  externalId: "return-0001",
  lines: [{ lineRef: LINE, quantity: "1" }],
  refundTenders: [{ method: "cash", amount: "10.00" }],
} as const;

const LEGACY_RETURN = {
  returnRef: RETURN,
  saleRef: SALE,
  recordedAt: "2026-11-22T09:00:00.000Z",
  businessDate: "2026-11-22",
  sourceSystem: "pos-pulse",
  externalId: "return-0001",
  currencyCode: "EGP",
  returnTotal: "10.00",
  lines: [
    {
      lineRef: LINE,
      quantity: "1",
      lineAmount: "10.00",
      taxAmount: null,
      returnedQuantity: "1",
      returnableQuantity: "0",
    },
  ],
  refundTenders: [{ method: "cash", amount: "10.00" }],
  reason: null,
} as const;

const POLICY = { revisionId: REVISION, source: "tenant", windowEndsOn: "2026-12-06", legalFloorDays: 3 } as const;
const POLICY_SYSTEM = { revisionId: null, source: "system", windowEndsOn: "2026-11-25", legalFloorDays: 3 } as const;

function withLine(extra: Record<string, unknown>): unknown {
  return { ...LEGACY_REQUEST, lines: [{ lineRef: LINE, quantity: "1", ...extra }] };
}

// ===========================================================================
// 1. Version and note
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1544 Return Policy contract", () => {
  it("is 1.27.0-draft with a note citing the approval, the decisions, the additive shape and the rollout order", () => {
    expect(sales.info?.version).toBe("1.27.0-draft");
    const info = flat(sales.info?.description);
    expect(info).toContain("RT-1544 (1.27.0-draft; [GATED: contract] owner approval on RT-1544, comment 18145");
    expect(info).toContain("specs/045-return-policy");
    expect(info).toContain("OD-272-1..11");
    expect(info).toContain("RT-272 comment 12791");
    expect(info).toContain("`return-policy.openapi.yaml`");
    expect(info).toContain("ROLLOUT ORDER");
    expect(info).toContain("Backend-Core (RP-3) before the POS (RP-4)");
    expect(info).toContain("enforcement stays OFF");
    expect(info).toContain("`recordCreditSaleReversal` is unchanged");
  });

  it("keeps the RT-1403 note: the version moved on, the earlier note stands", () => {
    expect(flat(sales.info?.description)).toContain("RT-1403 (1.26.0-draft; [GATED: contract] owner authorization on RT-1403");
  });
});

// ===========================================================================
// 2. The request: line reason fields
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1544 line reasons on recordReturn", () => {
  it("recordReturn lines use the new RecordReturnLineRequest; the credit reversal keeps ReturnLineRequest", () => {
    expect(props("RecordReturnRequest")["lines"]).toMatchObject({ items: { $ref: "#/components/schemas/RecordReturnLineRequest" } });
    expect(props("CreditSaleReversalRequest")["lines"]).toMatchObject({ items: { $ref: "#/components/schemas/ReturnLineRequest" } });
  });

  it("ReturnLineRequest is exactly as before (lineRef and quantity, both required, strict)", () => {
    const s = schema("ReturnLineRequest");
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(["lineRef", "quantity"]);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(["lineRef", "quantity"]);
  });

  it("RecordReturnLineRequest is ReturnLineRequest plus two OPTIONAL fields, strict", () => {
    const s = schema("RecordReturnLineRequest");
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(["lineRef", "quantity"]);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(["lineRef", "quantity", "reasonCode", "reasonNote"]);
    // The inherited fields are the same wire shape as on ReturnLineRequest.
    const base = props("ReturnLineRequest");
    const next = props("RecordReturnLineRequest");
    for (const key of ["lineRef", "quantity"]) {
      expect({ type: next[key]!["type"], format: next[key]!["format"], pattern: next[key]!["pattern"] }).toEqual({
        type: base[key]!["type"],
        format: base[key]!["format"],
        pattern: base[key]!["pattern"],
      });
    }
  });

  it("reasonCode is the closed OD-272-8 catalogue, in that order", () => {
    expect(props("RecordReturnLineRequest")["reasonCode"]).toMatchObject({ type: "string", enum: CATALOGUE });
  });

  it("reasonNote is a bounded string; `other` needs it (422), the header reason stays", () => {
    expect(props("RecordReturnLineRequest")["reasonNote"]).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    const note = flat((props("RecordReturnLineRequest")["reasonNote"] as { description?: string }).description);
    expect(note).toContain("`other`");
    expect(note).toContain("`return_reason_invalid`");
    expect(props("RecordReturnRequest")["reason"]).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
  });

  it("RecordReturnRequest keeps its required list and gains no other field", () => {
    const s = schema("RecordReturnRequest");
    expect([...(s.required ?? [])].sort()).toEqual(["externalId", "lines", "refundTenders", "sourceSystem"]);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(["externalId", "lines", "reason", "refundTenders", "sourceSystem"]);
  });

  it("legacy bodies stay valid: no reason fields, and the new fields when given", () => {
    const v = validator("RecordReturnRequest");
    expect(v(LEGACY_REQUEST)).toBe(true);
    expect(v(withLine({ reasonCode: "defective" }))).toBe(true);
    expect(v(withLine({ reasonCode: "other", reasonNote: "Customer changed the size" }))).toBe(true);
    expect(v({ ...LEGACY_REQUEST, reason: "Return at the till" })).toBe(true);
  });

  it.each([
    ["an unknown reason code", { reasonCode: "damaged_in_transit" }],
    ["an empty note", { reasonCode: "other", reasonNote: "" }],
    ["a 501 character note", { reasonCode: "other", reasonNote: "x".repeat(501) }],
    ["a numeric reason code", { reasonCode: 1 }],
    ["an unknown line key", { reasonText: "free text" }],
  ])("refuses %s on a line", (_name, extra) => {
    expect(validator("RecordReturnRequest")(withLine(extra))).toBe(false);
  });

  it("the credit reversal line stays closed to the new fields", () => {
    expect(validator("ReturnLineRequest")({ lineRef: LINE, quantity: "1", reasonCode: "defective" })).toBe(false);
  });

  it("states that the new fields are part of the payload, absent stays absent, and a replay is not re-judged", () => {
    const text = flat(recordReturn().description);
    expect(text).toContain("Return policy (RT-1544");
    expect(text).toContain("A return recorded without them hashes exactly as before");
    expect(text).toContain("a replay is never re-judged");
  });
});

// ===========================================================================
// 3. The response: returnPolicy
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1544 SaleReturn.returnPolicy", () => {
  it("SaleReturn gains an OPTIONAL returnPolicy; its required list does not move", () => {
    const s = schema("SaleReturn");
    expect(props("SaleReturn")["returnPolicy"]).toMatchObject({ $ref: "#/components/schemas/SaleReturnPolicy" });
    expect([...(s.required ?? [])].sort()).toEqual(
      [
        "businessDate",
        "currencyCode",
        "externalId",
        "lines",
        "reason",
        "recordedAt",
        "refundTenders",
        "returnRef",
        "returnTotal",
        "saleRef",
        "sourceSystem",
      ].sort(),
    );
    expect(s.additionalProperties).toBe(false);
  });

  it("SaleReturnPolicy is exactly {revisionId, source, windowEndsOn, legalFloorDays}, strict, all required", () => {
    const s = schema("SaleReturnPolicy");
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(["legalFloorDays", "revisionId", "source", "windowEndsOn"]);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(["legalFloorDays", "revisionId", "source", "windowEndsOn"]);
    const p = props("SaleReturnPolicy");
    expect(p["source"]).toMatchObject({ type: "string", enum: ["system", "tenant"] });
    expect(p["windowEndsOn"]).toMatchObject({ type: "string", format: "date" });
    expect(p["legalFloorDays"]).toMatchObject({ type: "integer", minimum: 0, maximum: 365 });
    for (const keyword of ["const", "enum", "default", "example", "examples"]) {
      expect(p["legalFloorDays"]![keyword]).toBeUndefined();
    }
  });

  it("the shared SaleReturn carries the field on the two return reads as well", () => {
    expect(flat((schema("SaleReturnPolicy") as { description?: string }).description)).toContain(
      "`listSaleReturns` and `readReturnByProvenance`, share `SaleReturn`",
    );
  });

  it("a legacy SaleReturn (no returnPolicy) stays valid; so does one that carries it", () => {
    const v = validator("SaleReturn");
    expect({ ok: v(LEGACY_RETURN), errors: v.errors }).toEqual({ ok: true, errors: null });
    expect(v({ ...LEGACY_RETURN, returnPolicy: POLICY })).toBe(true);
    expect(v({ ...LEGACY_RETURN, returnPolicy: POLICY_SYSTEM })).toBe(true);
  });

  it.each([
    ["a system policy with a revision id", { ...POLICY_SYSTEM, revisionId: REVISION }],
    ["a tenant policy with no revision id", { ...POLICY, revisionId: null }],
    ["a store source (no store override in V1)", { ...POLICY, source: "store" }],
    ["a date-time windowEndsOn", { ...POLICY, windowEndsOn: "2026-12-06T00:00:00Z" }],
    ["a missing legal floor", { revisionId: REVISION, source: "tenant", windowEndsOn: "2026-12-06" }],
    ["an extra key", { ...POLICY, windowDays: 14 }],
  ])("refuses returnPolicy with %s", (_name, returnPolicy) => {
    expect(validator("SaleReturn")({ ...LEGACY_RETURN, returnPolicy })).toBe(false);
  });

  it("the Sale and SaleLine read projections gain nothing (readSale is untouched)", () => {
    expect(props("Sale")["returnPolicy"]).toBeUndefined();
    expect(props("SaleLine")["returnPolicy"]).toBeUndefined();
  });
});

// ===========================================================================
// 4. The three 422 codes
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1544 return policy refusals", () => {
  const description = (): string => flat(sales.components?.responses?.["ReturnUnprocessable"]?.description);

  it("ReturnUnprocessable lists the three codes, first, with their meaning", () => {
    const text = description();
    for (const code of ["return_window_expired", "return_line_not_returnable", "return_reason_invalid"]) {
      expect(text).toContain(`\`${code}\``);
    }
    // The policy refusals come before the older ones in the list.
    expect(text.indexOf("`return_window_expired`")).toBeLessThan(text.indexOf("`promotion_clawback_exceeds_refund`"));
    expect(text).toContain("category_excluded");
    expect(text).toContain("category_unknown");
    expect(text).toContain("only while enforcement is on, which stays off until the owner sets the legal minimum window");
  });

  it("the policy checks run after the credit and reversal checks and before the line checks (the plan's order)", () => {
    const text = flat(recordReturn().description);
    expect(text).toMatch(/after the returns gate, the sale resolve, a provenance replay, the credit-sale 403 and reversal exclusivity/);
    expect(text).toMatch(/before the line checks/);
  });

  it("recordReturn still declares exactly its statuses (no new status)", () => {
    expect(Object.keys(recordReturn().responses ?? {}).sort()).toEqual(["200", "201", "400", "401", "403", "404", "409", "422", "500"]);
  });

  it("the 422 response keeps `Error` as its schema (oasdiff: no body type change); the detailed shape is a valid Error", () => {
    const content = (sales.components?.responses?.["ReturnUnprocessable"] as unknown as {
      content?: Record<string, { schema?: unknown }>;
    }).content?.["application/json"];
    expect(content?.schema).toEqual({ $ref: "#/components/schemas/Error" });
    expect(validator("Error")({ error: { code: "return_tender_mismatch", message: "x" } })).toBe(true);

    const detailed = validator("ReturnLineNotReturnableError");
    const ok = { error: { code: "return_line_not_returnable", message: "x", lineRef: LINE, reason: "category_excluded" } };
    expect(detailed(ok)).toBe(true);
    expect(validator("Error")(ok)).toBe(true);
    expect(detailed({ error: { ...ok.error, reason: "category_unknown" } })).toBe(true);
    expect(detailed({ error: { ...ok.error, reason: "window_expired" } })).toBe(false);
    expect(detailed({ error: { code: "return_line_not_returnable", message: "x" } })).toBe(false);
    expect(detailed({ error: { ...ok.error, code: "return_window_expired" } })).toBe(false);
  });
});

// ===========================================================================
// 5. Additive only
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1544 changes nothing else", () => {
  it("keeps every operation it had (no operation added or removed)", () => {
    const ids = Object.values(sales.paths ?? {})
      .flatMap((item) => Object.values(item))
      .map((o) => o.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual(
      [
        "captureSale",
        "listSaleReturns",
        "readReturnByProvenance",
        "readSale",
        "recordCashierVoid",
        "recordCreditSaleReversal",
        "recordRefund",
        "recordRefundExecution",
        "recordReturn",
        "recordVoid",
      ].sort(),
    );
  });

  it("recordReturn is still online-gated, operator-envelope only, and idempotent", () => {
    expect(recordReturn().security).toEqual([{ operatorAuthorization: [] }]);
    expect((recordReturn() as { "x-idempotency"?: string })["x-idempotency"]).toBe("required");
    expect(flat((recordReturn() as { "x-runtime-note"?: string })["x-runtime-note"])).toContain("POS_RETURNS_ENABLED");
  });
});
