/**
 * apps/api/test/pricing/price-authoring.contract.spec.ts
 *
 * RT-1151 (RT-282 PR-04, authoring half): the Retail Pricing authoring
 * contracts, `pricing/price-structure.yaml` and `pricing/price-change-sets.yaml`
 * 1.0.0-draft. `[GATED]` contract-first; every operation is
 * `x-runtime-status: contract-only` until RT-1484.
 *
 * Structural / load-only plus AJV 2020-12 fixtures; no app boot, no HTTP.
 * Pins:
 *   1. Every operation at its path and method, contract-only with a note,
 *      cookieAuth only, no operationId collision with any other contract.
 *   2. Every write: `x-idempotency: required` with the `Idempotency-Key`
 *      header, 403 (Origin) and 425 documented.
 *   3. Spec 042: the state set, `expectedVersion` on every transition,
 *      `previewHash` on approve, four eyes and emergency rules in prose,
 *      Store Managers excluded from authoring (Q-B2).
 *   4. AJV fixtures: the six item operations, the timeBasis rule, emergency
 *      needs a reason, money as exact decimal strings, preview shapes.
 */
import "reflect-metadata";

import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
} from "../_helpers/openapi-contract";

type Method = "get" | "post" | "patch";
interface Op {
  readonly contract: "price-structure" | "price-change-sets";
  readonly id: string;
  readonly method: Method;
  readonly path: string;
}

const CS = "/api/v1/pricing/change-sets";
const CS_ID = `${CS}/{changeSetId}`;
const BOOKS = "/api/v1/pricing/books";

const OPERATIONS: readonly Op[] = [
  { contract: "price-structure", id: "consoleListPriceBooks", method: "get", path: BOOKS },
  { contract: "price-structure", id: "consoleCreatePriceBook", method: "post", path: BOOKS },
  { contract: "price-structure", id: "consoleGetPriceBook", method: "get", path: `${BOOKS}/{bookId}` },
  { contract: "price-structure", id: "consoleCreatePriceZone", method: "post", path: `${BOOKS}/{bookId}/zones` },
  { contract: "price-structure", id: "consoleRetirePriceZone", method: "post", path: `${BOOKS}/{bookId}/zones/{zoneId}/retire` },
  { contract: "price-structure", id: "consoleListPriceZoneStores", method: "get", path: `${BOOKS}/{bookId}/zones/{zoneId}/stores` },
  {
    contract: "price-structure",
    id: "consoleListStorePriceZoneMemberships",
    method: "get",
    path: "/api/v1/pricing/stores/{storeId}/zone-memberships",
  },
  { contract: "price-change-sets", id: "consoleListPriceChangeSets", method: "get", path: CS },
  { contract: "price-change-sets", id: "consoleCreatePriceChangeSet", method: "post", path: CS },
  { contract: "price-change-sets", id: "consoleGetPriceChangeSet", method: "get", path: CS_ID },
  { contract: "price-change-sets", id: "consoleUpdatePriceChangeSet", method: "patch", path: CS_ID },
  { contract: "price-change-sets", id: "consoleValidatePriceChangeSet", method: "post", path: `${CS_ID}/validate` },
  { contract: "price-change-sets", id: "consoleGetPriceChangeSetPreview", method: "get", path: `${CS_ID}/preview` },
  { contract: "price-change-sets", id: "consoleSubmitPriceChangeSet", method: "post", path: `${CS_ID}/submit` },
  { contract: "price-change-sets", id: "consoleApprovePriceChangeSet", method: "post", path: `${CS_ID}/approve` },
  { contract: "price-change-sets", id: "consoleRejectPriceChangeSet", method: "post", path: `${CS_ID}/reject` },
  { contract: "price-change-sets", id: "consolePublishPriceChangeSet", method: "post", path: `${CS_ID}/publish` },
  { contract: "price-change-sets", id: "consoleRollbackPriceChangeSet", method: "post", path: `${CS_ID}/rollback` },
  { contract: "price-change-sets", id: "consoleCancelPriceChangeSet", method: "post", path: `${CS_ID}/cancel` },
];
const WRITES = OPERATIONS.filter((op) => op.method !== "get");

/** The request body schema of every write (spec 042 §12: every transition carries expectedVersion). */
const REQUEST_BODIES: Record<string, string> = {
  consoleCreatePriceBook: "CreatePriceBookRequest",
  consoleCreatePriceZone: "CreatePriceZoneRequest",
  consoleRetirePriceZone: "RetirePriceZoneRequest",
  consoleCreatePriceChangeSet: "CreatePriceChangeSetRequest",
  consoleUpdatePriceChangeSet: "UpdatePriceChangeSetRequest",
  consoleValidatePriceChangeSet: "VersionedRequest",
  consoleSubmitPriceChangeSet: "SubmitPriceChangeSetRequest",
  consoleApprovePriceChangeSet: "ApprovePriceChangeSetRequest",
  consoleRejectPriceChangeSet: "RejectPriceChangeSetRequest",
  consolePublishPriceChangeSet: "VersionedRequest",
  consoleRollbackPriceChangeSet: "RollbackPriceChangeSetRequest",
  consoleCancelPriceChangeSet: "VersionedRequest",
};
const VERSIONED_TRANSITIONS = [
  "consoleUpdatePriceChangeSet",
  "consoleValidatePriceChangeSet",
  "consoleSubmitPriceChangeSet",
  "consoleApprovePriceChangeSet",
  "consoleRejectPriceChangeSet",
  "consolePublishPriceChangeSet",
  "consoleCancelPriceChangeSet",
] as const;

const ID_1 = "0192f000-0000-7000-8000-000000000001";
const ID_2 = "0192f000-0000-7000-8000-000000000002";
const HASH = `sha256:${"a".repeat(64)}`;

const docs: Record<Op["contract"], OpenApiDocument> = {} as Record<Op["contract"], OpenApiDocument>;
const others: Record<Op["contract"], Set<string>> = {} as Record<Op["contract"], Set<string>>;
// OpenAPI 3.1 schemas are JSON Schema 2020-12.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  for (const id of ["price-structure", "price-change-sets"] as const) {
    docs[id] = contractDocument(contracts, id);
    others[id] = operationIdsExcept(contracts, id);
    ajv.addSchema(docs[id] as object, id);
  }
});

function operation(op: Op): OperationObject {
  const found = (docs[op.contract].paths?.[op.path] as Record<string, OperationObject> | undefined)?.[op.method];
  if (!found) throw new Error(`${op.method.toUpperCase()} ${op.path} not declared in ${op.contract}`);
  return found;
}

function validator(contract: Op["contract"], name: string): ValidateFunction {
  const v = ajv.getSchema(`${contract}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${contract} ${name}`);
  return v;
}

function info(contract: Op["contract"]): string {
  return String((docs[contract] as unknown as { info: { description: string } }).info.description);
}

describe("pricing authoring contracts — operations (RT-1151 PR-04)", () => {
  it("both are OpenAPI 3.1 at 1.0.0-draft", () => {
    for (const contract of ["price-structure", "price-change-sets"] as const) {
      expect(docs[contract].openapi).toBe("3.1.0");
      expect((docs[contract] as unknown as { info: { version: string } }).info.version).toBe("1.0.0-draft");
    }
  });

  it("declares exactly the planned operations (every HTTP method entry, with or without an operationId)", () => {
    const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
    for (const contract of ["price-structure", "price-change-sets"] as const) {
      const declared = Object.entries(docs[contract].paths ?? {})
        .flatMap(([path, item]) =>
          Object.entries(item as Record<string, OperationObject>)
            .filter(([method]) => HTTP_METHODS.has(method))
            .map(([method, o]) => `${method} ${path} ${String(o?.operationId)}`),
        )
        .sort();
      const planned = OPERATIONS.filter((o) => o.contract === contract)
        .map((o) => `${o.method} ${o.path} ${o.id}`)
        .sort();
      expect(declared).toEqual(planned);
    }
  });

  it.each(OPERATIONS)("$id is contract-only, cookieAuth only and unique", (op) => {
    const o = operation(op);
    expect(o.operationId).toBe(op.id);
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(String(o["x-runtime-note"] ?? "")).toMatch(/RT-1484/);
    expect(o.security).toEqual([{ cookieAuth: [] }]);
    expect(others[op.contract].has(op.id)).toBe(false);
  });

  it.each(WRITES)("$id is idempotent, Origin-checked and documents 425", (op) => {
    const o = operation(op);
    expect((o as unknown as Record<string, unknown>)["x-idempotency"]).toBe("required");
    expect((o.parameters ?? []).map((p) => p.$ref)).toContain("#/components/parameters/IdempotencyKey");
    expect(Object.keys(o.responses ?? {})).toEqual(expect.arrayContaining(["400", "401", "403", "404", "409", "425", "429", "500"]));
  });
});

describe("price-change-sets — spec 042 rules", () => {
  it("has the spec 042 states", () => {
    const states = (docs["price-change-sets"].components?.schemas?.["ChangeSetState"] as { enum: string[] }).enum;
    expect(states).toEqual(["draft", "validated", "pending_approval", "approved", "published", "superseded", "rolled_back", "cancelled"]);
  });

  it.each(WRITES)("$id takes its own, required request body", (op) => {
    const requestBody = operation(op).requestBody as
      | { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> }
      | undefined;
    expect(requestBody?.required).toBe(true);
    const body = requestBody?.content?.["application/json"]?.schema?.$ref;
    expect(body).toBe(`#/components/schemas/${REQUEST_BODIES[op.id]}`);
  });

  /** A complete, valid request for each versioned transition. */
  const VALID_TRANSITION_BODIES: Record<(typeof VERSIONED_TRANSITIONS)[number], Record<string, unknown>> = {
    consoleUpdatePriceChangeSet: { expectedVersion: 2, title: "Weekend prices" },
    consoleValidatePriceChangeSet: { expectedVersion: 2 },
    consoleSubmitPriceChangeSet: { expectedVersion: 2, acknowledgedFindings: ["rounded_price"] },
    consoleApprovePriceChangeSet: { expectedVersion: 2, previewHash: HASH, acknowledgedFindings: ["replaces"] },
    consoleRejectPriceChangeSet: { expectedVersion: 2, reason: "Wrong Zone" },
    consolePublishPriceChangeSet: { expectedVersion: 2 },
    consoleCancelPriceChangeSet: { expectedVersion: 2 },
  };

  it.each(VERSIONED_TRANSITIONS)("%s requires a positive expectedVersion and nothing else is missing", (id) => {
    const v = validator("price-change-sets", REQUEST_BODIES[id]!);
    const valid = VALID_TRANSITION_BODIES[id];
    expect(v(valid)).toBe(true);
    const { expectedVersion: _omitted, ...withoutVersion } = valid;
    expect(v(withoutVersion)).toBe(false);
    expect(v({ ...valid, expectedVersion: 0 })).toBe(false);
  });

  it("approve and submit take explicit acknowledgements (spec 042 §5, spec 041 §6)", () => {
    const approve = validator("price-change-sets", "ApprovePriceChangeSetRequest");
    expect(approve({ expectedVersion: 2, previewHash: HASH, acknowledgedFindings: ["replaces", "invalidates_dependent"] })).toBe(true);
    expect(approve({ expectedVersion: 2, previewHash: HASH, acknowledgedFindings: ["shadowed"] })).toBe(false);
    const submit = validator("price-change-sets", "SubmitPriceChangeSetRequest");
    expect(submit({ expectedVersion: 2, acknowledgedFindings: ["rounded_price"] })).toBe(true);
    expect(submit({ expectedVersion: 2 })).toBe(true);
  });

  it("the rollback 409 body validates against its response schema", () => {
    const v = ajv.compile({ $ref: "price-change-sets#/components/responses/RollbackConflict/content/application~1json/schema" });
    expect(v({ error: { code: "rollback_blocked", message: "m" }, blockingRevisionNos: [419] })).toBe(true);
    expect(v({ error: { code: "change_set_invalid_state", message: "m" } })).toBe(true);
    // rollback_blocked always carries its blocking revisions: the generic Error branch cannot carry it.
    expect(v({ error: { code: "rollback_blocked", message: "m" } })).toBe(false);
  });

  it("lead time, acknowledgements and the Zone-retire race are documented", () => {
    const responses = (docs["price-change-sets"] as unknown as { components: { responses: Record<string, { description: string }> } })
      .components.responses;
    expect(responses["ValidateUnprocessable"]!.description).toMatch(/lead_time_violation/);
    expect(responses["SubmitUnprocessable"]!.description).toMatch(/acknowledgement_required/);
    const structure = (docs["price-structure"] as unknown as { components: { responses: Record<string, { description: string }> } })
      .components.responses;
    expect(structure["RetireZoneConflict"]!.description).toMatch(/Change Set targets it/);
  });

  it("approve is bound to a previewHash; reject needs a reason", () => {
    const approve = validator("price-change-sets", "ApprovePriceChangeSetRequest");
    expect(approve({ expectedVersion: 2, previewHash: HASH })).toBe(true);
    expect(approve({ expectedVersion: 2 })).toBe(false);
    expect(approve({ expectedVersion: 2, previewHash: "abc" })).toBe(false);
    const reject = validator("price-change-sets", "RejectPriceChangeSetRequest");
    expect(reject({ expectedVersion: 2 })).toBe(false);
  });

  it("states the ratified authority rules in prose", () => {
    const text = info("price-change-sets");
    expect(text).toMatch(/Store Managers have no price authoring in\s+V1/);
    expect(text).toMatch(/self_approval_forbidden/);
    expect(text).toMatch(/approved before publication by an independent second authorized person/);
    expect(text).toMatch(/There is no post-hoc\s+review path/);
    expect(text).toMatch(/stale_validation/);
    expect(text).toMatch(/Publishing always happens \*\*now\*\*/);
  });

  it("an emergency set needs a reason; rollback is not created directly", () => {
    const v = validator("price-change-sets", "CreatePriceChangeSetRequest");
    expect(v({ kind: "standard", title: "November" })).toBe(true);
    expect(v({ kind: "emergency", title: "Fix" })).toBe(false);
    expect(v({ kind: "emergency", title: "Fix", reason: "wrong shelf price" })).toBe(true);
    expect(v({ kind: "rollback", title: "Back" })).toBe(false);
  });
});

describe("price-change-sets — item fixtures", () => {
  const v = () => validator("price-change-sets", "PriceChangeItem");
  const items = { kind: "items", productIds: [ID_1] };

  it("accepts each of the six operations", () => {
    expect(v()({ op: "set_price", scope: { kind: "book" }, products: items, price: "125.50", effectiveFrom: "2026-11-01T00:00" })).toBe(true);
    expect(v()({ op: "adjust_amount", scope: { kind: "zone", zoneId: ID_2 }, products: { kind: "category", categoryId: ID_2 }, amount: "-5.00", effectiveFrom: "2026-11-01T00:00:00" })).toBe(true);
    expect(v()({ op: "adjust_percent", scope: { kind: "stores", storeIds: [ID_2] }, products: items, percent: "-12.50", effectiveFrom: "2026-11-01T00:00" })).toBe(true);
    expect(v()({ op: "end_price", scope: { kind: "book" }, products: items, effectiveFrom: "2026-12-01T00:00" })).toBe(true);
    expect(v()({ op: "reset_store_override", scope: { kind: "stores", storeIds: [ID_2] }, products: items, effectiveFrom: "2026-12-01T00:00" })).toBe(true);
    expect(v()({ op: "move_store_zone", storeId: ID_1, zoneId: ID_2, effectiveFrom: "2026-12-01T00:00:00+02:00" })).toBe(true);
  });

  it("matches date-times to the time basis", () => {
    const base = { op: "set_price", scope: { kind: "book" }, products: items, price: "10.00" };
    expect(v()({ ...base, effectiveFrom: "2026-11-01T00:00:00+02:00" })).toBe(false);
    expect(v()({ ...base, timeBasis: "absolute", effectiveFrom: "2026-11-01T00:00:00+02:00" })).toBe(true);
    expect(v()({ ...base, timeBasis: "absolute", effectiveFrom: "2026-11-01T00:00:00" })).toBe(false);
    expect(v()({ op: "move_store_zone", storeId: ID_1, zoneId: ID_2, timeBasis: "store_local", effectiveFrom: "2026-12-01T00:00:00+02:00" })).toBe(false);
    expect(v()({ op: "move_store_zone", storeId: ID_1, zoneId: ID_2, effectiveFrom: "2026-12-01T00:00:00" })).toBe(false);
    expect(v()({ ...base, timeBasis: "absolute", effectiveFrom: "2026-11-01T00:00Z" })).toBe(false);
  });

  it("rejects floats, over-precise money, unknown ops and a reset outside a Store scope", () => {
    const base = { op: "set_price", scope: { kind: "book" }, products: items, effectiveFrom: "2026-11-01T00:00" };
    expect(v()({ ...base, price: 10.5 })).toBe(false);
    expect(v()({ ...base, price: "10.12345" })).toBe(false);
    expect(v()({ ...base, price: "-1.00" })).toBe(false);
    expect(v()({ ...base, op: "clearance", price: "1.00" })).toBe(false);
    expect(v()({ op: "reset_store_override", scope: { kind: "book" }, products: items, effectiveFrom: "2026-12-01T00:00" })).toBe(false);
    expect(v()({ ...base, price: "1.00", sellUnit: "kg" })).toBe(false);
  });
});

describe("price-change-sets — preview and header fixtures", () => {
  const summary = {
    lines: 2,
    stores: 1,
    devices: 3,
    products: 2,
    increases: 1,
    decreases: 1,
    unchanged: 0,
    maxIncreasePct: "12.50",
    maxDecreasePct: "-3.46",
    earliestEffectiveAt: "2026-11-01T00:00:00+02:00",
    findings: { replaces: 1, shadowed: 0, invalidates_dependent: 0, conflicts_pending: 0, past_dated: 0, invalid: 0 },
    blocking: false,
  };

  it("accepts a preview page and rejects a line with a float price", () => {
    const v = validator("price-change-sets", "PriceChangeSetPreview");
    const line = {
      storeId: ID_1,
      productId: ID_2,
      sellUnit: "each",
      oldPrice: "130.0000",
      oldSourceScope: "book",
      newPrice: "125.5000",
      newSourceScope: "zone",
      deltaPct: "-3.46",
      effectiveFrom: "2026-11-01T00:00:00+02:00",
      class: "replaces",
      devices: 3,
      messages: [],
    };
    const page = {
      changeSetId: ID_1,
      version: 7,
      validatedAtRevision: 418,
      previewHash: HASH,
      summary,
      membershipChanges: [],
      lines: [line],
      nextCursor: null,
    };
    expect(v(page)).toBe(true);
    expect(v({ ...page, lines: [{ ...line, newPrice: 125.5 }] })).toBe(false);
    expect(v({ ...page, lines: [{ ...line, class: "ok" }] })).toBe(false);
    expect(v({ ...page, lines: [{ ...line, deltaPct: "999900.00" }] })).toBe(true);
  });

  it("accepts a published header with its revision and actors", () => {
    const v = validator("price-change-sets", "PriceChangeSetHeader");
    const actor = { userId: ID_1, at: "2026-11-01T09:00:00Z" };
    const header = {
      id: ID_1,
      kind: "standard",
      title: "November",
      reason: null,
      state: "published",
      publicationStatus: "scheduled",
      version: 4,
      validatedAtRevision: 417,
      previewHash: HASH,
      sensitive: true,
      sensitivityReasons: ["approval_mode_always"],
      revisionNo: 418,
      rollsBackChangeSetId: null,
      rolledBackByChangeSetId: null,
      created: actor,
      submitted: actor,
      approved: { userId: ID_2, at: "2026-11-01T10:00:00Z" },
      published: actor,
      cancelled: null,
      lastRejection: null,
    };
    expect(v(header)).toBe(true);
    expect(v({ ...header, state: "live" })).toBe(false);
    expect(v({ ...header, tenantId: ID_1 })).toBe(false);
  });

  it("a rollback's from is a strict instant", () => {
    const v = validator("price-change-sets", "RollbackPriceChangeSetRequest");
    expect(v({ reason: "r", from: "2026-11-01T00:00:00+02:00" })).toBe(true);
    expect(v({ reason: "r", from: "2026-11-01T00:00" })).toBe(false);
  });

  it("rollback_blocked names the blocking revisions", () => {
    const v = validator("price-change-sets", "RollbackBlocked");
    expect(v({ error: { code: "rollback_blocked", message: "m" }, blockingRevisionNos: [419] })).toBe(true);
    expect(v({ error: { code: "rollback_blocked", message: "m" }, blockingRevisionNos: [] })).toBe(false);
  });
});

describe("price-structure — rules and fixtures", () => {
  it("states the v1 single-Book and immutable default Zone rules", () => {
    const text = info("price-structure");
    expect(text).toMatch(/at most one\s+non-retired retail Price Book/);
    expect(text).toMatch(/default Zone/);
    expect(text).toMatch(/changes only through a Change Set/);
  });

  it("a Book create needs code, name, currency and tax basis; nothing else", () => {
    const v = validator("price-structure", "CreatePriceBookRequest");
    expect(v({ code: "RETAIL", name: "Retail", currencyCode: "EGP", taxPriceBasis: "inclusive" })).toBe(true);
    expect(v({ code: "RETAIL", name: "Retail", currencyCode: "EGP" })).toBe(false);
    expect(v({ code: "RETAIL", name: "Retail", currencyCode: "EGP", taxPriceBasis: "gross" })).toBe(false);
    expect(v({ code: "RETAIL", name: "Retail", currencyCode: "EGP", taxPriceBasis: "inclusive", pricingContext: "b2b" })).toBe(false);
  });

  it("a membership row is absolute and carries its revision", () => {
    const v = validator("price-structure", "PriceZoneMembership");
    const row = {
      id: ID_1,
      priceZoneId: ID_2,
      effectiveFrom: "2026-11-01T00:00:00Z",
      effectiveTo: null,
      publishedInRevision: 3,
      carriedForward: false,
    };
    expect(v(row)).toBe(true);
    expect(v({ ...row, publishedInRevision: 0 })).toBe(false);
  });
});

describe("pricing authoring contracts — review round 2 (RT-1151 PR-04)", () => {
  function schemaOf(contract: Op["contract"], pointer: string): ValidateFunction {
    return ajv.compile({ $ref: `${contract}#${pointer}` });
  }

  function opDescription(contract: Op["contract"], id: string): string {
    const op = OPERATIONS.find((o) => o.contract === contract && o.id === id)!;
    return String(operation(op).description ?? "");
  }

  it("DeltaPercent holds the largest change between two positive prices", () => {
    const v = validator("price-change-sets", "DeltaPercent");
    expect(v(`${"9".repeat(22)}.99`)).toBe(true);
    expect(v("-100.00")).toBe(true);
    expect(v(`${"9".repeat(23)}.00`)).toBe(false);
  });

  it("`at` is a strict RFC 3339 instant: a colonless offset is refused", () => {
    const at = schemaOf("price-structure", "/components/parameters/At/schema");
    expect(at("2026-11-01T00:00:00+02:00")).toBe(true);
    expect(at("2026-11-01T00:00:00Z")).toBe(true);
    expect(at("2026-11-01T00:00:00+0200")).toBe(false);
  });

  it("every nextCursor is a valid request cursor or null", () => {
    const pointers: ReadonlyArray<[Op["contract"], string]> = [
      ["price-structure", "/components/schemas/PriceZoneStorePage/properties/nextCursor"],
      ["price-change-sets", "/components/schemas/PriceChangeSetPage/properties/nextCursor"],
      ["price-change-sets", "/components/schemas/PriceChangeSetPreview/properties/nextCursor"],
    ];
    for (const [contract, pointer] of pointers) {
      const v = schemaOf(contract, pointer);
      expect(v(null)).toBe(true);
      expect(v("abc_DEF-123")).toBe(true);
      expect(v("abc=")).toBe(false);
      expect(v("")).toBe(false);
    }
  });

  it("the 425 Retry-After header is required (the interceptor always sends it)", () => {
    for (const contract of ["price-structure", "price-change-sets"] as const) {
      const header = (docs[contract] as unknown as { components: { headers: Record<string, { required?: boolean }> } }).components
        .headers["RetryAfterInProgress"];
      expect(header?.required).toBe(true);
    }
  });

  it("documents the rules the review asked for", () => {
    expect(opDescription("price-change-sets", "consoleUpdatePriceChangeSet")).toMatch(/rollback[\s\S]*cannot be replaced/);
    expect(opDescription("price-change-sets", "consoleSubmitPriceChangeSet")).toMatch(/straight to `approved`[\s\S]*replaces/);
    expect(opDescription("price-structure", "consoleRetirePriceZone")).toMatch(/publish\s+lock/);
    expect(opDescription("price-structure", "consoleListPriceZoneStores")).toMatch(/`nextCursor` carries both/);
    const responses = (docs["price-structure"] as unknown as { components: { responses: Record<string, { description: string }> } })
      .components.responses;
    expect(responses["RevisionUnknown"]!.description).toMatch(/omitted `as_of_revision` is never 422/);
  });
});
