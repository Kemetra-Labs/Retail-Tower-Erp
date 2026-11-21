/**
 * apps/api/test/return-policy/return-policy.contract.spec.ts
 *
 * RT-1544 (RP-1 of specs/045-return-policy, plan G5 / RT-272, owner decisions
 * OD-272-1..11 of RT-272 comment 12791): the Return Policy V1 contract,
 * `return-policy.openapi.yaml` 1.0.0-draft. `[GATED: contract]`, approved by
 * the owner on RT-1544 comment 18145. CONTRACT ONLY: every operation is
 * `x-runtime-status: contract-only` (no route, no migration, no consumer);
 * enforcement stays off and the legal minimum window is the owner's value, so
 * it appears nowhere in the contract.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. The four operations at their paths, all contract-only with a note, and
 *      no operationId collision in any other contract.
 *   2. Auth: the Console operations are the human `cookieAuth` session only;
 *      the eligibility read takes the operator envelope exactly like
 *      `readSale`, and no scope arrives in a query or body field.
 *   3. The publish: `Idempotency-Key`, `expectedRevisionId`, a required
 *      `reason`, `windowDays` 0..365, the excluded category set, the refusal
 *      codes.
 *   4. The effective read, the revision and the eligibility projections are
 *      strict; the legal floor is a bounded integer with NO value written in
 *      the contract (no `const`, `enum` or `default`).
 *   5. AJV fixtures: valid payloads pass, each invalid one fails, including
 *      every structural rule expressed with `if` / `then`.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
  type ResponseObject,
  type SchemaObject,
} from "../_helpers/openapi-contract";

const CONTRACT_ID = "return-policy.openapi";

type Method = "get" | "post";
interface Route {
  readonly path: string;
  readonly method: Method;
}

const TENANT_READ: Route = { path: "/api/v1/tenants/{tenant_id}/return-policy", method: "get" };
const TENANT_REVISIONS: Route = { path: "/api/v1/tenants/{tenant_id}/return-policy/revisions", method: "get" };
const TENANT_PUBLISH: Route = { path: "/api/v1/tenants/{tenant_id}/return-policy/revisions", method: "post" };
const ELIGIBILITY: Route = { path: "/api/pos/v1/sales/{saleRef}/return-eligibility", method: "get" };

const OPERATIONS = [
  ["consoleGetTenantReturnPolicy", TENANT_READ],
  ["consoleListTenantReturnPolicyRevisions", TENANT_REVISIONS],
  ["consolePublishTenantReturnPolicy", TENANT_PUBLISH],
  ["posGetSaleReturnEligibility", ELIGIBILITY],
] as const;
const CONSOLE_OPERATIONS = OPERATIONS.filter(([id]) => id.startsWith("console"));

interface ResponseWithContent extends ResponseObject {
  content?: Record<string, { schema?: unknown }>;
}

interface PathItem {
  parameters?: ParameterObject[];
  get?: OperationObject & { "x-idempotency"?: string; requestBody?: RequestBody };
  post?: OperationObject & { "x-idempotency"?: string; requestBody?: RequestBody };
}
interface RequestBody {
  required?: boolean;
  content?: Record<string, { schema?: { $ref?: string } }>;
}

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function pathItem(route: Route): PathItem {
  const item = (doc.paths as Record<string, PathItem> | undefined)?.[route.path];
  if (!item) throw new Error(`${route.path} not declared`);
  return item;
}

function op(route: Route): NonNullable<PathItem["get"]> {
  const found = pathItem(route)[route.method];
  if (!found) throw new Error(`${route.method.toUpperCase()} ${route.path} not declared`);
  return found;
}

function schema(name: string): SchemaObject {
  const s = doc.components?.schemas?.[name];
  if (!s) throw new Error(`schema ${name} not declared`);
  return s;
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

function resolveParameter(p: ParameterObject): ParameterObject {
  if (!p.$ref) return p;
  return doc.components?.parameters?.[p.$ref.replace("#/components/parameters/", "")] ?? {};
}

function params(route: Route): ParameterObject[] {
  return [...(pathItem(route).parameters ?? []), ...(op(route).parameters ?? [])].map(resolveParameter);
}

function response(route: Route, status: string): ResponseWithContent {
  const r = op(route).responses?.[status];
  if (!r) throw new Error(`${route.path} declares no ${status}`);
  if (!r.$ref) return r;
  const found = doc.components?.responses?.[r.$ref.replace("#/components/responses/", "")];
  if (!found) throw new Error(`response ${r.$ref} not declared`);
  return found;
}

function statusesOf(route: Route): string[] {
  return Object.keys(op(route).responses ?? {}).sort();
}

const flat = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ");

function without<T extends object>(value: T, key: keyof T): Omit<T, typeof key> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const REV_1 = "0190f5a2-3b4c-7d8e-9f01-0000000000b1";
const REV_2 = "0190f5a2-3b4c-7d8e-9f01-0000000000b2";
const CAT_A = "0190f5a2-3b4c-7d8e-9f01-0000000000c1";
const CAT_B = "0190f5a2-3b4c-7d8e-9f01-0000000000c2";
const USER = "0190f5a2-3b4c-7d8e-9f01-000000000004";
const SALE = "0190f5a2-3b4c-7d8e-9f01-0000000000d1";
const LINE_1 = "0190f5a2-3b4c-7d8e-9f01-0000000000e1";
const LINE_2 = "0190f5a2-3b4c-7d8e-9f01-0000000000e2";
// A test-only floor: the contract itself carries no value (OD-272-5, owner/legal).
const FLOOR = 3;

const SYSTEM_EFFECTIVE = {
  source: "system",
  revisionId: null,
  windowDays: FLOOR,
  excludedCategoryIds: [],
  legalFloorDays: FLOOR,
} as const;
const TENANT_EFFECTIVE = {
  source: "tenant",
  revisionId: REV_2,
  windowDays: 14,
  excludedCategoryIds: [CAT_A, CAT_B],
  legalFloorDays: FLOOR,
} as const;

const REVISION_1 = {
  revisionId: REV_1,
  windowDays: 7,
  excludedCategoryIds: [],
  reason: "Pilot window",
  effectiveFrom: "2026-11-22T09:00:00.000Z",
  supersedesRevisionId: null,
  state: "superseded",
  createdByUserId: USER,
  createdAt: "2026-11-22T09:00:00.000Z",
} as const;
const REVISION_2 = {
  ...REVISION_1,
  revisionId: REV_2,
  windowDays: 14,
  excludedCategoryIds: [CAT_A, CAT_B],
  reason: "Exclude clearance and gift cards",
  supersedesRevisionId: REV_1,
  state: "current",
  effectiveFrom: "2026-11-23T09:00:00.000Z",
  createdAt: "2026-11-23T09:00:00.000Z",
} as const;

const TENANT_POLICY_SYSTEM = { effective: SYSTEM_EFFECTIVE, latestRevision: null, latestRevisionId: null } as const;
const TENANT_POLICY_PUBLISHED = {
  effective: TENANT_EFFECTIVE,
  latestRevision: REVISION_2,
  latestRevisionId: REV_2,
} as const;

const PUBLISH = {
  expectedRevisionId: REV_1,
  windowDays: 14,
  excludedCategoryIds: [CAT_A, CAT_B],
  reason: "Exclude clearance and gift cards",
} as const;

const APPLIED = {
  revisionId: REV_2,
  source: "tenant",
  windowEndsOn: "2026-12-06",
  legalFloorDays: FLOOR,
} as const;
const APPLIED_SYSTEM = { revisionId: null, source: "system", windowEndsOn: "2026-11-25", legalFloorDays: FLOOR } as const;

const ELIGIBILITY_BODY = {
  saleRef: SALE,
  returnPolicy: APPLIED,
  lines: [
    { lineRef: LINE_1, returnable: true },
    { lineRef: LINE_2, returnable: false, reason: "category_excluded" },
  ],
} as const;

// ===========================================================================
// 1. Document and operations
// ===========================================================================
describe("return-policy — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly the four operations", () => {
    const declared = Object.entries((doc.paths ?? {}) as Record<string, PathItem>).flatMap(([path, item]) =>
      (["get", "post"] as const).filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path} ${item[m]!.operationId}`),
    );
    expect(declared.sort()).toEqual(OPERATIONS.map(([id, r]) => `${r.method.toUpperCase()} ${r.path} ${id}`).sort());
  });

  it.each(OPERATIONS)("%s is contract-only with a note that names the runtime slice", (_id, route) => {
    expect(op(route)["x-runtime-status"]).toBe("contract-only");
    const note = flat(op(route)["x-runtime-note"]);
    expect(note.length).toBeGreaterThan(20);
    expect(note).toContain("RP-3");
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPERATIONS.map(([id]) => id).filter((id) => otherOperationIds.has(id))).toEqual([]);
  });

  it("cites the plan, the owner decisions, the [GATED] approval and the off posture in the info", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain("RT-1544");
    expect(info).toContain("specs/045-return-policy");
    expect(info).toContain("OD-272-1");
    expect(info).toContain("RT-272 comment 12791");
    expect(info).toContain("[GATED: contract]");
    expect(info).toContain("RT-1544 comment 18145");
    expect(info).toContain("contract-only");
    expect(info).toContain("enforcement stays OFF");
  });

  it("states the rollout order: Backend-Core before the POS, and what a 404 on the read means", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain("ROLLOUT ORDER");
    expect(info).toContain("RP-3");
    expect(info).toContain("RP-4");
    expect(info).toContain("returns_unavailable");
    expect(info).toContain("pos-sales/sales.yaml");
    expect(info).toContain("1.27.0-draft");
  });

  it("does not invent the legal minimum window: the info says it is the owner's and carries no number for it", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain("OD-272-5");
    expect(info).toMatch(/owner or legal supplies the value/i);
  });
});

// ===========================================================================
// 2. Auth and scope
// ===========================================================================
describe("return-policy — auth and scope", () => {
  it.each(CONSOLE_OPERATIONS)("%s accepts only the human cookieAuth session", (_id, route) => {
    expect(op(route).security).toEqual([{ cookieAuth: [] }]);
  });

  it("the eligibility read takes the operator envelope only, like readSale", () => {
    expect(op(ELIGIBILITY).security).toEqual([{ operatorAuthorization: [] }]);
  });

  it("defines exactly the cookieAuth and operatorAuthorization schemes", () => {
    expect(Object.keys(doc.components?.securitySchemes ?? {}).sort()).toEqual(["cookieAuth", "operatorAuthorization"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
    expect(doc.components!.securitySchemes!["operatorAuthorization"]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.components!.securitySchemes!["operatorAuthorization"]!["bearerFormat"]).toBeUndefined();
  });

  it("the eligibility read takes only the saleRef path parameter; scope comes from the envelope", () => {
    expect(params(ELIGIBILITY).map((p) => p.name)).toEqual(["saleRef"]);
    expect(params(ELIGIBILITY)[0]).toMatchObject({ in: "path", required: true, schema: { type: "string", format: "uuid" } });
  });

  it("the eligibility read is audited and is a new operation, not a change to readSale", () => {
    expect(op(ELIGIBILITY)["x-audit-action"]).toBe("return_policy.eligibility_read");
    expect(flat(op(ELIGIBILITY).description)).toContain("`readSale`");
  });

  it.each(CONSOLE_OPERATIONS)("%s refuses scope and role as the non-disclosing 404", (_id, route) => {
    expect(statusesOf(route)).toContain("404");
    expect(flat(response(route, "404").description)).toMatch(/non-disclosing/i);
  });

  it("the tenant_id path parameter is a required uuid on the Console operations", () => {
    for (const [, route] of CONSOLE_OPERATIONS) {
      expect(params(route).find((p) => p.name === "tenant_id")).toMatchObject({
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      });
    }
  });

  it("states the roles: owner and tenant_admin, session only (OD-272-11)", () => {
    for (const [, route] of CONSOLE_OPERATIONS) {
      const text = flat(op(route).description);
      expect(text).toContain("`owner`");
      expect(text).toContain("`tenant_admin`");
      expect(text).not.toContain("`store_manager`");
    }
  });

  it("a request body never carries a tenant or store id", () => {
    expect(Object.keys(schema("PublishReturnPolicyRequest").properties ?? {}).filter((k) => /tenant|store/i.test(k))).toEqual([]);
  });
});

// ===========================================================================
// 3. Publish
// ===========================================================================
describe("return-policy — publish", () => {
  it("requires the Idempotency-Key header", () => {
    expect(op(TENANT_PUBLISH)["x-idempotency"]).toBe("required");
    expect(params(TENANT_PUBLISH).find((p) => p.name === "Idempotency-Key")).toMatchObject({
      in: "header",
      required: true,
      schema: { type: "string", minLength: 16, maxLength: 128, pattern: "^[\\x21-\\x7E]{16,128}$" },
    });
  });

  it("takes its strict body and answers 201 with the updated read", () => {
    expect(op(TENANT_PUBLISH).requestBody?.required).toBe(true);
    expect(op(TENANT_PUBLISH).requestBody?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/PublishReturnPolicyRequest",
    });
    expect(response(TENANT_PUBLISH, "201").content?.["application/json"]).toMatchObject({
      schema: { $ref: "#/components/schemas/TenantReturnPolicy" },
    });
    expect(response(TENANT_PUBLISH, "201").headers?.["Idempotent-Replayed"]).toEqual({
      $ref: "#/components/headers/IdempotentReplayed",
    });
  });

  const EXPECTED_STATUSES: Record<string, string[]> = {
    consoleGetTenantReturnPolicy: ["200", "400", "401", "404", "429", "500"],
    consoleListTenantReturnPolicyRevisions: ["200", "400", "401", "404", "429", "500"],
    consolePublishTenantReturnPolicy: ["201", "400", "401", "403", "404", "409", "422", "425", "429", "500"],
    posGetSaleReturnEligibility: ["200", "400", "401", "404", "500"],
  };

  it.each(OPERATIONS)("%s declares exactly its documented statuses", (id, route) => {
    expect(statusesOf(route)).toEqual([...EXPECTED_STATUSES[id]!].sort());
  });

  const CODES: Array<[string, Route, string, string[]]> = [
    ["publish", TENANT_PUBLISH, "400", ["validation_error", "idempotency_key_required", "idempotency_key_malformed"]],
    ["publish", TENANT_PUBLISH, "403", ["origin_rejected"]],
    ["publish", TENANT_PUBLISH, "409", ["return_policy_changed_concurrently", "idempotency_key_conflict"]],
    ["publish", TENANT_PUBLISH, "422", ["return_policy_window_below_legal_floor", "return_policy_category_invalid"]],
    ["publish", TENANT_PUBLISH, "425", ["idempotency_in_progress"]],
    ["publish", TENANT_PUBLISH, "429", ["rate_limited"]],
  ];
  it.each(CODES)("%s %s documents the %s codes %j", (_name, route, status, codes) => {
    const text = flat(response(route, status).description);
    for (const code of codes) expect(text).toContain(`\`${code}\``);
  });

  it("states the order of checks and what the publish writes (revision, categories, audit row)", () => {
    const text = flat(op(TENANT_PUBLISH).description);
    expect(text).toContain("Order of checks");
    expect(text).toContain("`return_policy.published`");
    expect(text).toContain("Apply Now");
    expect(text).toContain("expectedRevisionId");
    // Applied at publish and at evaluation (OD-272-5).
    expect(text).toContain("legal floor");
  });

  it("the list is a keyset page, newest first", () => {
    expect(params(TENANT_REVISIONS).map((p) => p.name).sort()).toEqual(["cursor", "page_size", "tenant_id"]);
    expect(flat(op(TENANT_REVISIONS).description)).toContain("newest first");
    expect(response(TENANT_REVISIONS, "200").content?.["application/json"]).toMatchObject({
      schema: { $ref: "#/components/schemas/ReturnPolicyRevisionPage" },
    });
  });

  it("publish request: strict, all four fields required, windowDays 0..365, a bounded unique category set", () => {
    const s = schema("PublishReturnPolicyRequest");
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(["excludedCategoryIds", "expectedRevisionId", "reason", "windowDays"]);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props["windowDays"]).toEqual({ $ref: "#/components/schemas/WindowDays" });
    expect(schema("WindowDays")).toMatchObject({ type: "integer", minimum: 0, maximum: 365 });
    expect(props["excludedCategoryIds"]).toEqual({ $ref: "#/components/schemas/ExcludedCategoryIds" });
    expect(schema("ExcludedCategoryIds")).toMatchObject({
      type: "array",
      uniqueItems: true,
      maxItems: 500,
      items: { type: "string", format: "uuid" },
    });
    expect(schema("Reason")).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
  });
});

// ===========================================================================
// 4. Projections
// ===========================================================================
describe("return-policy — projections", () => {
  it.each([
    "EffectiveReturnPolicy",
    "ReturnPolicyRevision",
    "ReturnPolicyRevisionPage",
    "TenantReturnPolicy",
    "PublishReturnPolicyRequest",
    "AppliedReturnPolicy",
    "ReturnLineVerdict",
    "ReturnEligibility",
  ])("%s is strict (additionalProperties false)", (name) => {
    expect(schema(name).additionalProperties).toBe(false);
  });

  it("no projection carries a tenant id, a device id, a store id or a hash", () => {
    const names = [
      "EffectiveReturnPolicy",
      "ReturnPolicyRevision",
      "TenantReturnPolicy",
      "AppliedReturnPolicy",
      "ReturnLineVerdict",
      "ReturnEligibility",
    ];
    for (const name of names) {
      expect(Object.keys(schema(name).properties ?? {}).filter((k) => /tenant|device|store|hash/i.test(k))).toEqual([]);
    }
  });

  it("the legal floor is a bounded integer with no value in the contract (OD-272-5: owner or legal supplies it)", () => {
    const floor = schema("LegalFloorDays");
    expect(floor).toMatchObject({ type: "integer", minimum: 0, maximum: 365 });
    for (const keyword of ["const", "enum", "default", "example", "examples"]) {
      expect(floor[keyword]).toBeUndefined();
    }
    expect(flat(floor.description)).toContain("System-locked");
  });

  it("the returned applied-policy object is exactly the RP-1 echo: revisionId, source, windowEndsOn, legalFloorDays", () => {
    const s = schema("AppliedReturnPolicy");
    expect([...(s.required ?? [])].sort()).toEqual(["legalFloorDays", "revisionId", "source", "windowEndsOn"]);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(["legalFloorDays", "revisionId", "source", "windowEndsOn"]);
  });

  it("a line verdict names a reason only from the two category reasons", () => {
    const props = schema("ReturnLineVerdict").properties as Record<string, Record<string, unknown>>;
    expect(props["reason"]).toMatchObject({ type: "string", enum: ["category_excluded", "category_unknown"] });
  });

  it("the eligibility read carries no explicit window verdict (windowEndsOn is the only window field)", () => {
    expect(Object.keys(schema("ReturnEligibility").properties ?? {}).sort()).toEqual(["lines", "returnPolicy", "saleRef"]);
  });
});

// ===========================================================================
// 5. AJV fixtures
// ===========================================================================
describe("return-policy — AJV fixtures", () => {
  it.each([
    ["EffectiveReturnPolicy", SYSTEM_EFFECTIVE],
    ["EffectiveReturnPolicy", TENANT_EFFECTIVE],
    ["ReturnPolicyRevision", REVISION_1],
    ["ReturnPolicyRevision", REVISION_2],
    ["TenantReturnPolicy", TENANT_POLICY_SYSTEM],
    ["TenantReturnPolicy", TENANT_POLICY_PUBLISHED],
    ["ReturnPolicyRevisionPage", { items: [REVISION_2, REVISION_1], nextCursor: null }],
    ["ReturnPolicyRevisionPage", { items: [REVISION_2], nextCursor: "abc_DEF-1" }],
    ["PublishReturnPolicyRequest", PUBLISH],
    ["PublishReturnPolicyRequest", { ...PUBLISH, expectedRevisionId: null, windowDays: 0, excludedCategoryIds: [] }],
    ["PublishReturnPolicyRequest", { ...PUBLISH, windowDays: 365 }],
    ["AppliedReturnPolicy", APPLIED],
    ["AppliedReturnPolicy", APPLIED_SYSTEM],
    ["ReturnEligibility", ELIGIBILITY_BODY],
  ] as const)("%s accepts %j", (name, value) => {
    const v = validator(name);
    expect({ ok: v(value), errors: v.errors }).toEqual({ ok: true, errors: null });
  });

  const REJECTED: Array<[string, unknown, string]> = [
    ["PublishReturnPolicyRequest", { ...PUBLISH, windowDays: -1 }, "a negative window"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, windowDays: 366 }, "a window above 365"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, windowDays: 1.5 }, "a fractional window"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, windowDays: "7" }, "a string window"],
    ["PublishReturnPolicyRequest", without(PUBLISH, "reason"), "no reason"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, reason: "" }, "an empty reason"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, reason: "x".repeat(501) }, "a 501 character reason"],
    ["PublishReturnPolicyRequest", without(PUBLISH, "expectedRevisionId"), "no expectedRevisionId"],
    ["PublishReturnPolicyRequest", without(PUBLISH, "excludedCategoryIds"), "no excludedCategoryIds"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, excludedCategoryIds: [CAT_A, CAT_A] }, "a duplicate category"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, excludedCategoryIds: ["not-a-uuid"] }, "a non-uuid category"],
    ["PublishReturnPolicyRequest", { ...PUBLISH, tenantId: USER }, "a body tenant id"],
    ["EffectiveReturnPolicy", { ...SYSTEM_EFFECTIVE, revisionId: REV_1 }, "a system policy with a revision id"],
    ["EffectiveReturnPolicy", { ...SYSTEM_EFFECTIVE, excludedCategoryIds: [CAT_A] }, "a system policy with exclusions"],
    ["EffectiveReturnPolicy", { ...TENANT_EFFECTIVE, revisionId: null }, "a tenant policy with no revision id"],
    ["EffectiveReturnPolicy", { ...TENANT_EFFECTIVE, source: "store" }, "a store source (V1 has no store override)"],
    ["EffectiveReturnPolicy", { ...TENANT_EFFECTIVE, legalFloorDays: undefined }, "no legal floor"],
    ["ReturnPolicyRevision", { ...REVISION_2, state: "pending" }, "an unknown state"],
    ["ReturnPolicyRevision", without(REVISION_2, "createdByUserId"), "an unattributed revision"],
    ["TenantReturnPolicy", { ...TENANT_POLICY_SYSTEM, latestRevisionId: REV_1 }, "a system read with a revision id"],
    ["TenantReturnPolicy", { ...TENANT_POLICY_PUBLISHED, latestRevision: null }, "a tenant read with no revision"],
    ["AppliedReturnPolicy", without(APPLIED, "windowEndsOn"), "no windowEndsOn"],
    ["AppliedReturnPolicy", { ...APPLIED, windowEndsOn: "2026-12-06T00:00:00Z" }, "a date-time windowEndsOn"],
    ["AppliedReturnPolicy", { ...APPLIED, legalFloorDays: -1 }, "a negative floor"],
    ["AppliedReturnPolicy", { ...APPLIED_SYSTEM, revisionId: REV_1 }, "a system echo with a revision id"],
    ["AppliedReturnPolicy", { ...APPLIED, revisionId: null }, "a tenant echo with no revision id"],
    [
      "ReturnEligibility",
      { ...ELIGIBILITY_BODY, lines: [{ lineRef: LINE_1, returnable: false }] },
      "a refused line with no reason",
    ],
    [
      "ReturnEligibility",
      { ...ELIGIBILITY_BODY, lines: [{ lineRef: LINE_1, returnable: true, reason: "category_excluded" }] },
      "a returnable line with a reason",
    ],
    [
      "ReturnEligibility",
      { ...ELIGIBILITY_BODY, lines: [{ lineRef: LINE_1, returnable: false, reason: "window_expired" }] },
      "a window reason on a line",
    ],
    ["ReturnEligibility", { ...ELIGIBILITY_BODY, lines: [] }, "no lines"],
  ];
  it.each(REJECTED)("%s rejects %j (%s)", (name, value) => {
    expect(validator(name)(value)).toBe(false);
  });
});
