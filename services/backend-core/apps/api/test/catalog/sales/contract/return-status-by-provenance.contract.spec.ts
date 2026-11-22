/**
 * RT-1548 slice 1 (RT-196 design spec section 4, BR-1 to BR-7; owner approval
 * on RT-1548 comment 18204) — `pos-sales/sales.yaml` 1.28.0-draft: the
 * affirmative return status read `readReturnStatusByProvenance`.
 * `[GATED: contract]`. CONTRACT ONLY: no route, no runtime, no migration, no
 * POS change. Structural / load-only plus AJV fixtures; no app boot.
 *
 * Pins:
 *   1. the version and the info note (approval, the additive shape, contract-only);
 *   2. the operation: path, id, operator auth like `readSale`, the two query
 *      parameters, the contract-only marker and its note, the audit action;
 *   3. the responses: 200 / 400 / 401 / 404 / 500 only, and a 404 that is never
 *      `not_recorded` (BR-2: gate, then sale resolve, then the provenance);
 *   4. the 200 body is exactly two verdicts, `recorded` (with the exact
 *      `SaleReturn`, BR-3, and the required `creditLinked` flag, BR-4) and
 *      `not_recorded`; no third verdict, no timestamp, no settlement;
 *   5. the BR-7 late-commit bound, stated on the read and on `recordReturn`, with the
 *      rollout rule (bound first), the elapsed-time quiet period and the credit-reversal carve-out;
 *   6. `readReturnByProvenance` and `ReturnRead` are untouched (additive only).
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
const STATUS_PATH = "/api/pos/v1/sales/{saleRef}/returns/by-provenance/status";
const BY_PROVENANCE_PATH = "/api/pos/v1/sales/{saleRef}/returns/by-provenance";
const RETURNS_PATH = "/api/pos/v1/sales/{saleRef}/returns";
const READ_SALE_PATH = "/api/pos/v1/sales/{saleRef}";

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

function statusRead(): OperationObject {
  const found = sales.paths?.[STATUS_PATH]?.["get"];
  if (!found) throw new Error("readReturnStatusByProvenance not declared");
  return found;
}

function operation(path: string, method: string): OperationObject {
  const found = sales.paths?.[path]?.[method];
  if (!found) throw new Error(`${method} ${path} not declared`);
  return found;
}

const description = (op: OperationObject): string => flat(op.description);

const SALE = "0190f5a2-3b4c-7d8e-9f01-0000000000d1";
const RETURN = "0190f5a2-3b4c-7d8e-9f01-0000000000f1";
const LINE = "0190f5a2-3b4c-7d8e-9f01-0000000000e1";

const SALE_RETURN = {
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

// ===========================================================================
// 1. Version and note
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1548 return status read: version and note", () => {
  it("is 1.28.0-draft with a note citing the approval, the spec rules, the additive shape and contract-only", () => {
    expect(sales.info?.version).toBe("1.28.0-draft");
    const info = flat(sales.info?.description);
    expect(info).toContain("RT-1548 (1.28.0-draft; [GATED: contract] owner approval on RT-1548 comment 18204");
    expect(info).toContain("RT-196 design spec");
    expect(info).toContain("BR-2");
    expect(info).toContain("BR-7");
    expect(info).toContain("`readReturnByProvenance` is unchanged");
    expect(info).toContain("CONTRACT ONLY");
    expect(info).toContain("`readReturnStatusByProvenance`");
  });

  it("the note says what is NOT in this version: no third verdict, no tombstone", () => {
    const info = flat(sales.info?.description);
    expect(info).toContain("no `unknown` or `pending` verdict");
    expect(info).toContain("tombstone");
    expect(info).toContain("Option B");
  });

  it("the rollout order puts the BR-7 bound first and keeps the read off until it is complete (M-1)", () => {
    const info = flat(sales.info?.description);
    expect(info).toContain("(2) the BR-7 bound on `recordReturn`, deployed FIRST to every instance that serves it");
    expect(info).toContain("(3) the status read (the route and its audit event), which must not answer a verdict until every instance that serves `recordReturn` enforces the bound");
    expect(info).toContain("ship the bound first, or keep the read off until the rollout has completed");
  });

  it("keeps the RT-1544 note: the version moved on, the earlier note stands", () => {
    expect(flat(sales.info?.description)).toContain("RT-1544 (1.27.0-draft; [GATED: contract] owner approval on RT-1544, comment 18145");
  });
});

// ===========================================================================
// 2. The operation
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1548 readReturnStatusByProvenance", () => {
  it("is GET /api/pos/v1/sales/{saleRef}/returns/by-provenance/status, tagged pos-sales", () => {
    const op = statusRead();
    expect(op.operationId).toBe("readReturnStatusByProvenance");
    expect((op as { tags?: string[] }).tags).toEqual(["pos-sales"]);
  });

  it("uses the same device plus operator scheme as readSale and readReturnByProvenance", () => {
    const expected = [{ operatorAuthorization: [] }];
    expect(statusRead().security).toEqual(expected);
    expect(operation(READ_SALE_PATH, "get").security).toEqual(expected);
    expect(operation(BY_PROVENANCE_PATH, "get").security).toEqual(expected);
  });

  it("takes the sale ref and the two provenance query parameters, all required, and no Idempotency-Key", () => {
    const refs = (statusRead().parameters ?? []).map((p) => p.$ref);
    expect(refs).toEqual([
      "#/components/parameters/SaleRef",
      "#/components/parameters/ReturnSourceSystem",
      "#/components/parameters/ReturnExternalId",
    ]);
    expect(refs).not.toContain("#/components/parameters/IdempotencyKey");
    expect((statusRead() as { "x-idempotency"?: string })["x-idempotency"]).toBeUndefined();
    expect(sales.components?.parameters?.["ReturnSourceSystem"]).toMatchObject({ in: "query", required: true });
    expect(sales.components?.parameters?.["ReturnExternalId"]).toMatchObject({ in: "query", required: true });
  });

  it("is contract-only with a note naming the runtime slice, and audits as pos_sales.return_read", () => {
    const op = statusRead();
    expect(op["x-runtime-status"]).toBe("contract-only");
    const note = flat(op["x-runtime-note"]);
    expect(note).toContain("RT-1548");
    expect(note).toContain("slice 2");
    expect(note).toContain("must not answer a verdict until every instance that serves `recordReturn` enforces the BR-7 bound");
    expect(note).toContain("ship the bound first, or keep the read off until the rollout has completed");
    expect(op["x-audit-action"]).toBe("pos_sales.return_read");
  });

  it("states the BR-2 order (gate, sale resolve, then the provenance) and that a 404 is never not_recorded", () => {
    const text = description(statusRead());
    expect(text).toContain("AFFIRMATIVE `not_recorded`");
    expect(text).toContain("decided after the returns gate and the sale resolve");
    expect(text).toContain("Behind `POS_RETURNS_ENABLED`");
    expect(text).toContain("NEVER `not_recorded`");
    expect(text).toContain("only ever said about a sale the caller can read");
  });

  it("states the scope rule: a key recorded against another sale answers not_recorded exactly as a key recorded nowhere", () => {
    const text = description(statusRead());
    expect(text).toContain("recorded against another sale");
    expect(text).toContain("answers `not_recorded` exactly as a key recorded nowhere does");
    expect(text).toContain("no existence leak");
    expect(text).toContain("409");
  });

  it("states that a credit-sale reversal is recorded, flagged, never paid out (BR-4)", () => {
    const text = description(statusRead());
    expect(text).toContain("credit-sale reversal");
    expect(text).toContain("`creditLinked: true`");
    expect(text).toContain("mismatch");
  });

  it("states that the read audits one ref-only event, writes nothing and needs no migration (BR-5, BR-6)", () => {
    const text = description(statusRead());
    expect(text).toContain("`pos_sales.return_read`");
    expect(text).toContain("ref-only");
    expect(text).toContain("No migration");
    expect(text).toContain("`(tenant, source_system, external_id)`");
  });
});

// ===========================================================================
// 3. Responses
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1548 responses", () => {
  const responses = (): Record<string, { $ref?: string; content?: Record<string, { schema?: unknown }> }> =>
    (statusRead().responses ?? {}) as never;

  it("answers 200, 400, 401, 404 and 500 only", () => {
    expect(Object.keys(responses()).sort()).toEqual(["200", "400", "401", "404", "500"]);
  });

  it("200 is ReturnProvenanceStatus; 400, 401 and 500 are the shared responses", () => {
    expect(responses()["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/ReturnProvenanceStatus" });
    expect(responses()["400"]?.$ref).toBe("#/components/responses/ValidationFailure");
    expect(responses()["401"]?.$ref).toBe("#/components/responses/Unauthorized");
    expect(responses()["500"]?.$ref).toBe("#/components/responses/SystemFailure");
  });

  it("404 is its own non-disclosing response: gate off or sale out of scope, one body, never a verdict", () => {
    expect(responses()["404"]?.$ref).toBe("#/components/responses/ReturnStatusNotFound");
    const text = flat(sales.components?.responses?.["ReturnStatusNotFound"]?.description);
    expect(text).toContain("returns gate is off");
    expect(text).toContain("does not resolve in the caller's (tenant, store) scope");
    expect(text).toContain("one body");
    expect(text).toContain("NEVER `not_recorded`");
    expect(text).toContain("not a verdict");
    const body = (sales.components?.responses?.["ReturnStatusNotFound"] as { content?: Record<string, { schema?: unknown }> }).content;
    expect(body?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/Error" });
  });

  it("the shared NotFound response (used by the sibling reads) is not edited", () => {
    const text = flat(sales.components?.responses?.["NotFound"]?.description);
    expect(text).toContain("(RT-490) the return ref or return provenance does not resolve as a return of that sale");
  });
});

// ===========================================================================
// 4. The verdict body
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1548 ReturnProvenanceStatus", () => {
  const props = (name: string): Record<string, Record<string, unknown>> =>
    (schema(name).properties ?? {}) as Record<string, Record<string, unknown>>;

  it("is exactly two variants, discriminated by status", () => {
    const s = schema("ReturnProvenanceStatus");
    expect(s["oneOf"]).toEqual([
      { $ref: "#/components/schemas/ReturnRecordedStatus" },
      { $ref: "#/components/schemas/ReturnNotRecordedStatus" },
    ]);
    expect(s["discriminator"]).toEqual({
      propertyName: "status",
      mapping: {
        recorded: "#/components/schemas/ReturnRecordedStatus",
        not_recorded: "#/components/schemas/ReturnNotRecordedStatus",
      },
    });
  });

  it("recorded carries the exact SaleReturn (BR-3) and a required creditLinked flag (BR-4), nothing else", () => {
    const s = schema("ReturnRecordedStatus");
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(["creditLinked", "saleReturn", "status"]);
    expect(Object.keys(props("ReturnRecordedStatus")).sort()).toEqual(["creditLinked", "saleReturn", "status"]);
    expect(props("ReturnRecordedStatus")["status"]).toMatchObject({ type: "string", const: "recorded" });
    // BR-3: the exact SaleReturn, except a zero-refund credit reversal (Finding 2, below).
    expect(props("ReturnRecordedStatus")["saleReturn"]).toMatchObject({
      oneOf: [{ $ref: "#/components/schemas/SaleReturn" }, { $ref: "#/components/schemas/ReturnStatusZeroRefundReturn" }],
    });
    expect(schema("ReturnRecordedStatus")["if"]).toEqual({ required: ["creditLinked"], properties: { creditLinked: { const: false } } });
    expect(schema("ReturnRecordedStatus")["then"]).toEqual({ properties: { saleReturn: { $ref: "#/components/schemas/SaleReturn" } } });
    expect(props("ReturnRecordedStatus")["creditLinked"]).toMatchObject({ type: "boolean" });
    expect(props("ReturnRecordedStatus")["settlement"]).toBeUndefined();
  });

  it("not_recorded is the status and nothing else: no timestamp, no bound, no reason", () => {
    const s = schema("ReturnNotRecordedStatus");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["status"]);
    expect(Object.keys(props("ReturnNotRecordedStatus"))).toEqual(["status"]);
    expect(props("ReturnNotRecordedStatus")["status"]).toMatchObject({ type: "string", const: "not_recorded" });
  });

  it("the descriptions say what each verdict proves and what not_recorded does not", () => {
    const recorded = flat(schema("ReturnRecordedStatus").description);
    expect(recorded).toContain("credit-sale reversal");
    expect(recorded).toContain("`creditLinked`");
    expect(recorded).toContain("never pays");
    expect(recorded).toContain("same `SaleReturn` that `recordReturn` answers with");
    expect(recorded).toContain("a credit-sale reversal whose cash refund is 0 has no refund row");
    expect(recorded).toContain("for `creditLinked: false` it is always a full `SaleReturn` with at least one refund allocation");
    const notRecorded = flat(schema("ReturnNotRecordedStatus").description);
    expect(notRecorded).toContain("late-commit bound");
    expect(notRecorded).toContain("60 seconds");
    expect(notRecorded).toContain("not by itself");
    expect(notRecorded).toContain("has a COMMIT still to be issued");
    expect(notRecorded).toContain("treats it as a mismatch, raises it to support and never pays cash on it");
  });

  // ---- CodeRabbit Finding 2: a zero-refund credit-sale reversal has an empty refundTenders ----
  describe("a credit-sale reversal with nothing refunded in cash (empty refundTenders)", () => {
    const ZERO_REFUND_RETURN = { ...SALE_RETURN, refundTenders: [] };
    const v = (): ValidateFunction => validator("ReturnProvenanceStatus");

    it("validates as recorded when creditLinked is true", () => {
      expect({ ok: v()({ status: "recorded", saleReturn: ZERO_REFUND_RETURN, creditLinked: true }), errors: v().errors }).toEqual({ ok: true, errors: null });
    });

    it("a credit-linked return that did refund cash still validates, as a plain SaleReturn", () => {
      expect(v()({ status: "recorded", saleReturn: SALE_RETURN, creditLinked: true })).toBe(true);
    });

    it("is rejected when creditLinked is false: an ordinary return always has a refund allocation", () => {
      expect(v()({ status: "recorded", saleReturn: ZERO_REFUND_RETURN, creditLinked: false })).toBe(false);
    });

    it("is rejected without the flag, and a plain SaleReturn still refuses an empty refundTenders", () => {
      expect(v()({ status: "recorded", saleReturn: ZERO_REFUND_RETURN })).toBe(false);
      expect(validator("SaleReturn")(ZERO_REFUND_RETURN)).toBe(false);
    });

    it("the empty-refund shape accepts no allocation: a credit-linked return with one matches only SaleReturn", () => {
      expect(validator("ReturnStatusZeroRefundReturn")(SALE_RETURN)).toBe(false);
      expect(validator("ReturnStatusZeroRefundReturn")(ZERO_REFUND_RETURN)).toBe(true);
    });

    it("stays identical to SaleReturn except refundTenders and the description (no drift)", () => {
      const strip = (name: string): Record<string, unknown> => {
        const s = schema(name);
        const properties = Object.fromEntries(
          Object.entries(s.properties ?? {}).filter(([key]) => key !== "refundTenders"),
        );
        return { type: s.type, additionalProperties: s.additionalProperties, required: s.required, properties };
      };
      expect(strip("ReturnStatusZeroRefundReturn")).toEqual(strip("SaleReturn"));
      const refund = props("ReturnStatusZeroRefundReturn")["refundTenders"];
      expect(refund).toMatchObject({ type: "array", maxItems: 0 });
      expect(refund?.["minItems"]).toBeUndefined();
      expect(props("ReturnStatusZeroRefundReturn")["lines"]).toEqual(props("SaleReturn")["lines"]);
      // SaleReturn itself is untouched: refundTenders keeps minItems 1.
      expect(props("SaleReturn")["refundTenders"]).toMatchObject({ type: "array", minItems: 1 });
    });
  });

  it("accepts a recorded verdict, flagged and unflagged, and a not_recorded verdict", () => {
    const v = validator("ReturnProvenanceStatus");
    expect({ ok: v({ status: "recorded", saleReturn: SALE_RETURN, creditLinked: false }), errors: v.errors }).toEqual({ ok: true, errors: null });
    expect(v({ status: "recorded", saleReturn: SALE_RETURN, creditLinked: true })).toBe(true);
    expect(v({ status: "not_recorded" })).toBe(true);
  });

  it.each([
    ["a recorded verdict without the creditLinked flag", { status: "recorded", saleReturn: SALE_RETURN }],
    ["a recorded verdict without the return", { status: "recorded", creditLinked: false }],
    ["a recorded verdict with a settlement", { status: "recorded", saleReturn: SALE_RETURN, creditLinked: false, settlement: null }],
    ["a recorded verdict with a non-boolean flag", { status: "recorded", saleReturn: SALE_RETURN, creditLinked: "no" }],
    ["a recorded verdict carrying a return that is not a SaleReturn", { status: "recorded", saleReturn: { returnRef: RETURN }, creditLinked: false }],
    ["a not_recorded verdict with a return", { status: "not_recorded", saleReturn: SALE_RETURN }],
    ["a not_recorded verdict with a server timestamp", { status: "not_recorded", notRecordedAsOf: "2026-11-22T09:00:00Z" }],
    ["a not_recorded verdict with the creditLinked flag", { status: "not_recorded", creditLinked: false }],
    ["a third verdict, unknown", { status: "unknown" }],
    ["a third verdict, pending", { status: "pending" }],
    ["a third verdict, unknown_yet", { status: "unknown_yet" }],
    ["no status", {}],
  ])("refuses %s", (_name, body) => {
    expect(validator("ReturnProvenanceStatus")(body)).toBe(false);
  });
});

// ===========================================================================
// 5. BR-7: the late-commit bound
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1548 BR-7 late-commit bound", () => {
  const BOUND = "issues no COMMIT later than 60 seconds after receiving the request";

  it("the read states the bound as a COMMIT deadline, the guarantee it gives not_recorded and what it does not cover", () => {
    const text = description(statusRead());
    expect(text).toContain("RT-1548 (BR-7)");
    expect(text).toContain(BOUND);
    expect(text).toContain("never commits afterwards");
    expect(text).toContain("received more than 60 seconds before the read");
    expect(text).toContain("does not by itself cover a `recordReturn` request received less than 60 seconds before the read");
    expect(text).toContain("quiet period");
    expect(text).toContain("15 minutes");
  });

  it("recordReturn carries the same bound, from the slice-2 runtime, and records the replication assumption (M-2)", () => {
    const text = description(operation(RETURNS_PATH, "post"));
    expect(text).toContain("RT-1548 (BR-7)");
    expect(text).toContain("The runtime issues no COMMIT for a `recordReturn` request later than 60 seconds after receiving the request");
    expect(text).toContain("never commits afterwards");
    expect(text).toContain("slice 2");
    expect(text).toContain("It bounds when the COMMIT is issued, not when the database finishes it");
    expect(text).toContain("no unbounded synchronous-replication commit wait");
    expect(text).toContain("Slice 2 verifies and documents the `synchronous_commit` and replica setting before `readReturnStatusByProvenance` answers verdicts");
  });

  it("the guarantee is that no COMMIT is still to be issued; completion is bounded only under the replication precondition (Finding 1)", () => {
    const text = description(statusRead());
    expect(text).toContain("has a COMMIT still to be issued");
    expect(text).not.toContain("can still commit a return under this provenance");
    expect(text).toContain("The bound is on issuing the COMMIT, not on its completion");
    expect(text).toContain("a normative rollout precondition of this read, no unbounded synchronous-replication commit wait");
    expect(text).toContain("slice 2 verifies and documents the `synchronous_commit` and replica setting before the read answers verdicts");
    const note = flat(statusRead()["x-runtime-note"]);
    expect(note).toContain("slice 2 first verifies and documents the `synchronous_commit` and replica setting");
    expect(flat(sales.info?.description)).toContain("and slice 2 first verifies and documents the `synchronous_commit` and replica setting");
  });

  it("states the late-commit obligation of the client: a later recorded verdict is a mismatch, raised to support, never paid (Finding 1)", () => {
    const text = description(statusRead());
    expect(text).toContain("Late commit: if a return the client closed as not recorded is later seen as recorded");
    expect(text).toContain("a later `recorded` verdict for its key, `readSale` showing it, or any server answer for the closed key");
    expect(text).toContain("it raises the row to support (`needs_support`, mismatch) and never pays cash on it");
    expect(text).toContain("RT-1498 owns that code; this contract states the obligation");
  });

  it('says "timed out under this bound", never a bare "timed out" (L-2)', () => {
    for (const text of [description(statusRead()), description(operation(RETURNS_PATH, "post"))]) {
      expect(text).toContain("timed out under this bound");
      expect(text).not.toMatch(/timed out never/);
    }
  });

  it("the quiet period covers the transport delay before receipt, not only the bound and the request timeout (L-3)", () => {
    expect(description(statusRead())).toContain("which must exceed the bound plus its request timeout plus the transport delay before receipt");
    expect(description(operation(RETURNS_PATH, "post"))).toContain("the quiet period must also cover the transport delay before receipt, which the bound does not");
  });

  it("the quiet period is elapsed time: a client that cannot show it elapsed treats it as not elapsed (M-3)", () => {
    const text = description(statusRead());
    expect(text).toContain("The quiet period is elapsed time");
    expect(text).toContain("a client that cannot show that it has elapsed (its clock stepped forward, or it restarted) treats it as not elapsed");
  });

  it("not_recorded makes no claim about an in-flight recordCreditSaleReversal (L-1)", () => {
    const text = description(statusRead());
    expect(text).toContain("`not_recorded` makes no claim about an in-flight `recordCreditSaleReversal`");
    expect(text).toContain("outside the bound");
    expect(text).toContain("RT-196 D-c");
  });

  it("the read must not answer a verdict until every recordReturn instance enforces the bound (M-1)", () => {
    const text = description(statusRead());
    expect(text).toContain("the read must not answer a verdict until every instance that serves `recordReturn` enforces the bound");
    expect(text).toContain("ship the bound first, or keep the read off (404) until the rollout has completed");
    expect(flat(operation(RETURNS_PATH, "post")["x-runtime-note"])).toContain(
      "must be live on every instance that serves this route before `readReturnStatusByProvenance` answers a verdict",
    );
  });

  it("the bound is shorter than the 15-minute quiet period it must fit inside (OD-196-5)", () => {
    const seconds = Number(/issues no COMMIT later than (\d+) seconds after receiving the request/.exec(description(statusRead()))?.[1]);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);
    // The 15 s POS request timeout plus the bound is under a tenth of the 15-minute quiet period, which leaves
    // the rest as margin for the transport delay before receipt and the commit itself.
    expect((seconds + 15) * 10).toBeLessThan(15 * 60);
  });
});

// ===========================================================================
// 6. Additive only
// ===========================================================================
describe("pos-sales/sales.yaml — RT-1548 is additive", () => {
  it("readReturnByProvenance keeps its operation id, auth, responses and its not-proof 404 text", () => {
    const op = operation(BY_PROVENANCE_PATH, "get");
    expect(op.operationId).toBe("readReturnByProvenance");
    expect(op.security).toEqual([{ operatorAuthorization: [] }]);
    expect(Object.keys(op.responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "500"]);
    expect((op.responses?.["404"] as { $ref?: string }).$ref).toBe("#/components/responses/NotFound");
    expect(op["x-runtime-status"]).toBeUndefined();
    const text = description(op);
    expect(text).toContain("404 `not_found` (non-disclosing, one body)");
    expect(text).toContain("so it is not by itself proof that the return was never recorded");
    expect(text).toContain("Not behind `POS_RETURNS_ENABLED`");
  });

  it("ReturnRead is unchanged: saleReturn and settlement, both required", () => {
    const s = schema("ReturnRead");
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(["saleReturn", "settlement"]);
    expect(Object.keys((s.properties ?? {}) as object).sort()).toEqual(["saleReturn", "settlement"]);
  });

  it("SaleReturn gains nothing (the verdict wraps it, it does not extend it)", () => {
    const keys = Object.keys((schema("SaleReturn").properties ?? {}) as object);
    expect(keys).not.toContain("creditLinked");
    expect(keys).not.toContain("status");
  });

  it("RT-1548 tags exactly one path, four schemas and one response (additivity itself is oasdiff's check)", () => {
    const tagged = (value: unknown): boolean => /\bRT-1548\b/.test(String((value as { description?: unknown })?.description ?? ""));
    // Paths: the operations whose own description cites RT-1548 (recordReturn's BR-7 paragraph is the one documented edit).
    const taggedOps = Object.entries(sales.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) => tagged(op))
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(taggedOps.sort()).toEqual([`GET ${STATUS_PATH}`, `POST ${RETURNS_PATH}`].sort());
    expect(Object.keys(sales.paths?.[STATUS_PATH] ?? {})).toEqual(["get"]);
    const taggedSchemas = Object.entries(sales.components?.schemas ?? {})
      .filter(([, def]) => tagged(def))
      .map(([name]) => name);
    expect(taggedSchemas.sort()).toEqual([
      "ReturnNotRecordedStatus",
      "ReturnProvenanceStatus",
      "ReturnRecordedStatus",
      "ReturnStatusZeroRefundReturn",
    ]);
    const taggedResponses = Object.entries(sales.components?.responses ?? {})
      .filter(([, def]) => tagged(def))
      .map(([name]) => name);
    expect(taggedResponses).toEqual(["ReturnStatusNotFound"]);
  });
});
