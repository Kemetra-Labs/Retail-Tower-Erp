/**
 * RT-1101 (RT-1098 slice I-1) — the voucher issuance admin contract
 * (`vouchers-admin.openapi.yaml`), contract-only.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. Four operations at the planned method and path, every one marked
 *      `x-runtime-status: contract-only` with a note.
 *   2. `cookieAuth` only, owner and tenant_admin roles (decision 2A).
 *   3. Issue: `count` 1 to 100 (decision 3A), idempotency key required,
 *      non-replayable, no-store response. Cancel: idempotency key required.
 *   4. Secrecy: `code` is a property of `IssuedVoucher` only. No read schema
 *      has it, and every read schema is closed.
 *   5. The closed error set.
 *   6. AJV fixtures: valid payloads pass, each invalid one fails.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ApiPath,
  type ContractReader,
  type OpenApiDocument,
  type OperationObject,
} from "../_helpers/openapi-contract";

const CONTRACT_ID = "vouchers-admin.openapi";
const ISSUE_LIST: ApiPath = "/api/v1/vouchers";
const ONE: ApiPath = "/api/v1/vouchers/{voucher_id}";
const CANCEL: ApiPath = "/api/v1/vouchers/{voucher_id}/cancel";

const OPERATIONS: ReadonlyArray<readonly [string, ApiPath, "get" | "post", string]> = [
  ["consoleIssueVouchers", ISSUE_LIST, "post", "voucher.issued"],
  ["consoleListVouchers", ISSUE_LIST, "get", "vouchers.listed"],
  ["consoleGetVoucher", ONE, "get", "vouchers.read"],
  ["consoleCancelVoucher", CANCEL, "post", "voucher.cancelled"],
];

const ID = "0a000000-0000-7000-8000-000000000001";
const BATCH = "0a000000-0000-7000-8000-000000000002";
const STORE = "0a000000-0000-7000-8000-000000000003";
const AT = "2026-12-31T00:00:00.000Z";

let doc: OpenApiDocument;
let api: ContractReader;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  api = contractReader(doc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

function op(path: ApiPath, method: "get" | "post"): OperationObject {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} not declared`);
  return found;
}

/** Every property name declared anywhere inside a schema, `$ref`s inlined. */
function propertyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => propertyNames(v, into));
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const props = record["properties"];
    if (props && typeof props === "object") {
      Object.keys(props as object).forEach((k) => into.add(k));
    }
    Object.values(record).forEach((v) => propertyNames(v, into));
  }
  return into;
}

const voucher = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  voucher_id: ID,
  batch_id: BATCH,
  amount_minor: 5000,
  currency_code: "EGP",
  status: "active",
  expires_at: AT,
  applies_to_all_stores: false,
  eligible_store_ids: [STORE],
  note: null,
  created_at: "2026-11-10T10:00:00.000Z",
  cancelled_at: null,
  redemption: null,
  ...over,
});

describe("vouchers-admin — document and operations", () => {
  it("declares the four operations at the planned paths", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([ISSUE_LIST, ONE, CANCEL].sort());
    expect(Object.keys(doc.paths![ISSUE_LIST]!).sort()).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths![ONE]!).filter((k) => k !== "parameters")).toEqual(["get"]);
    expect(Object.keys(doc.paths![CANCEL]!).filter((k) => k !== "parameters")).toEqual(["post"]);
  });

  it.each(OPERATIONS)("%s is contract-only, with a note and its audit action", (id, path, method, audit) => {
    const o = op(path, method);
    expect(o.operationId).toBe(id);
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(o["x-runtime-note"]).toEqual(expect.stringContaining("RT-1101"));
    expect(o["x-audit-action"]).toBe(audit);
  });

  it("collides with no operationId in any other contract", () => {
    for (const [id] of OPERATIONS) expect(otherOperationIds.has(id)).toBe(false);
  });
});

describe("vouchers-admin — auth and roles (decision 2A)", () => {
  it("accepts only the human cookieAuth session, on every operation", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    for (const [, path, method] of OPERATIONS) expect(op(path, method).security).toBeUndefined();
  });

  it("names owner and tenant_admin only, and refuses store_manager with 403", () => {
    expect(doc.info?.description).toEqual(expect.stringContaining("`owner` and `tenant_admin` only"));
    expect(api.responseDescription("Forbidden")).toEqual(expect.stringContaining("`store_manager`"));
    for (const [, path, method] of OPERATIONS) {
      expect(op(path, method).responses?.["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
    }
  });

  it("takes no tenant id from the request", () => {
    for (const [, path, method] of OPERATIONS) {
      const names = (op(path, method).parameters ?? []).map((p) =>
        p.$ref ? p.$ref.split("/").pop() : p.name,
      );
      expect(names.join(",")).not.toMatch(/tenant/i);
    }
    expect([...propertyNames(doc.components?.schemas)]).not.toContain("tenant_id");
  });
});

describe("vouchers-admin — issue", () => {
  const issue = (): OperationObject => op(ISSUE_LIST, "post");

  it("requires an idempotency key and is non-replayable", () => {
    expect(issue()["x-idempotency" as keyof OperationObject]).toBe("required");
    expect(issue().parameters).toEqual([{ $ref: "#/components/parameters/IdempotencyKey" }]);
    expect(doc.components?.parameters?.["IdempotencyKey"]).toMatchObject({
      name: "Idempotency-Key",
      in: "header",
      required: true,
    });
    expect(issue().description).toEqual(expect.stringContaining("Non-replayable"));
    expect(issue().responses?.["409"]?.description).toEqual(expect.stringContaining("idempotency_key_conflict"));
    expect(issue().responses?.["425"]).toEqual({ $ref: "#/components/responses/TooEarly" });
  });

  it("never offers an Idempotent-Replayed header on the 201", () => {
    expect(Object.keys(issue().responses?.["201"]?.headers ?? {})).toEqual(["Cache-Control"]);
  });

  it("answers 201 with no-store because the body carries secret codes", () => {
    expect(issue().responses?.["201"]?.headers?.["Cache-Control"]).toMatchObject({
      schema: { type: "string", enum: ["no-store"] },
    });
  });

  it("bounds count at 1 to 100 (decision 3A) and the amount above zero", () => {
    const props = api.schema("VoucherIssueRequest")["properties"] as Record<string, Record<string, unknown>>;
    expect(props["count"]).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
    expect(props["amount_minor"]).toMatchObject({ type: "integer", minimum: 1 });
    expect(props["eligible_store_ids"]).toMatchObject({ type: "array", maxItems: 100, uniqueItems: true });
    expect(api.schema("VoucherIssueRequest")).toMatchObject({
      additionalProperties: false,
      required: ["count", "amount_minor", "applies_to_all_stores"],
    });
    expect(api.schema("VoucherIssueResponse")["properties"]).toMatchObject({
      vouchers: { maxItems: 100 },
    });
  });

  it.each([
    ["an all-stores batch", { count: 1, amount_minor: 100, applies_to_all_stores: true }],
    [
      "a subset batch with expiry and a note",
      { count: 100, amount_minor: 5000, applies_to_all_stores: false, eligible_store_ids: [STORE], expires_at: AT, note: "spring" },
    ],
    ["a null expiry", { count: 2, amount_minor: 100, applies_to_all_stores: true, expires_at: null }],
  ])("accepts %s", (_label, body) => {
    expect(validator("VoucherIssueRequest")(body)).toBe(true);
  });

  it.each([
    ["count 0", { count: 0, amount_minor: 100, applies_to_all_stores: true }],
    ["count 101", { count: 101, amount_minor: 100, applies_to_all_stores: true }],
    ["a fractional count", { count: 1.5, amount_minor: 100, applies_to_all_stores: true }],
    ["amount 0", { count: 1, amount_minor: 0, applies_to_all_stores: true }],
    ["a negative amount", { count: 1, amount_minor: -5, applies_to_all_stores: true }],
    ["a missing applies_to_all_stores", { count: 1, amount_minor: 100 }],
    ["a client-chosen code", { count: 1, amount_minor: 100, applies_to_all_stores: true, code: "AAAA-AAAA-AAAA-AAAA" }],
    ["a client-sent tenant id", { count: 1, amount_minor: 100, applies_to_all_stores: true, tenant_id: ID }],
    ["a non-uuid store", { count: 1, amount_minor: 100, applies_to_all_stores: false, eligible_store_ids: ["nope"] }],
    [
      "101 stores",
      {
        count: 1,
        amount_minor: 100,
        applies_to_all_stores: false,
        eligible_store_ids: Array.from({ length: 101 }, (_, i) => `0a000000-0000-7000-8000-${String(i).padStart(12, "0")}`),
      },
    ],
    ["a duplicate store", { count: 1, amount_minor: 100, applies_to_all_stores: false, eligible_store_ids: [STORE, STORE] }],
    ["a note over 200 characters", { count: 1, amount_minor: 100, applies_to_all_stores: true, note: "x".repeat(201) }],
  ])("refuses %s", (_label, body) => {
    expect(validator("VoucherIssueRequest")(body)).toBe(false);
  });

  it("states the eligibility rules the schema cannot express", () => {
    expect(issue().description).toEqual(expect.stringContaining("omitted or empty"));
    expect(issue().description).toEqual(expect.stringContaining("`store_not_found`"));
    expect(issue().description).toEqual(expect.stringContaining("`store_inactive`"));
  });
});

describe("vouchers-admin — secrecy: a code is in the issue response only", () => {
  it("has `code` on IssuedVoucher and the response that wraps it, and on no other schema, apart from the error envelope", () => {
    const schemas = doc.components?.schemas ?? {};
    const withCode = Object.keys(schemas).filter((name) =>
      propertyNames(api.shape(schemas[name])).has("code"),
    );
    // `Error` has `error.code` (the error code, not a voucher code).
    expect(withCode.sort()).toEqual(["Error", "IssuedVoucher", "VoucherIssueResponse"]);
    expect(Object.keys((api.schema("IssuedVoucher")["properties"] ?? {}) as object)).toContain("code");
  });

  it("closes every read schema", () => {
    for (const name of ["Voucher", "VoucherPage", "VoucherCancelResult", "VoucherRedemptionSummary"]) {
      expect(api.schema(name)["additionalProperties"]).toBe(false);
    }
  });

  it("returns the read operations' bodies as Voucher, VoucherPage and nothing else", () => {
    const ref = (path: ApiPath, method: "get" | "post", status: string): unknown =>
      (op(path, method).responses?.[status] as { content?: Record<string, { schema?: unknown }> }).content?.[
        "application/json"
      ]?.schema;
    expect(ref(ISSUE_LIST, "get", "200")).toEqual({ $ref: "#/components/schemas/VoucherPage" });
    expect(ref(ONE, "get", "200")).toEqual({ $ref: "#/components/schemas/Voucher" });
    expect(ref(CANCEL, "post", "200")).toEqual({ $ref: "#/components/schemas/VoucherCancelResult" });
    expect(ref(ISSUE_LIST, "post", "201")).toEqual({ $ref: "#/components/schemas/VoucherIssueResponse" });
  });

  it("pins the code format: 16 Crockford base32 characters, no I L O U", () => {
    const issued = validator("IssuedVoucher");
    const base = { voucher_id: ID, amount_minor: 100, currency_code: "EGP", expires_at: null };
    expect(issued({ ...base, code: "0123-4567-89AB-CDEF" })).toBe(true);
    expect(issued({ ...base, code: "GHJK-MNPQ-RSTV-WXYZ" })).toBe(true);
    for (const bad of [
      "ILOU-ILOU-ILOU-ILOU",
      "abcd-efgh-jkmn-pqrs",
      "0123456789ABCDEF",
      "0123-4567-89AB",
      "0123-4567-89AB-CDEF-0123",
    ]) {
      expect([bad, issued({ ...base, code: bad })]).toEqual([bad, false]);
    }
  });
});

describe("vouchers-admin — list and read", () => {
  it("declares the filters and keyset pagination of the plan", () => {
    expect(api.params(ISSUE_LIST).map((p) => p.name)).toEqual([
      "status",
      "batch_id",
      "eligible_store_id",
      "expires_after",
      "expires_before",
      "cursor",
      "page_size",
    ]);
    expect(api.param(ISSUE_LIST, "page_size").schema).toMatchObject({ minimum: 1, maximum: 100, default: 50 });
    expect(api.params(ISSUE_LIST).filter((p) => p.in === "header")).toEqual([]);
    expect(api.params(ONE).filter((p) => p.in === "header")).toEqual([]);
  });

  it("exposes the effective status, derived as in RT-922 §5.4", () => {
    expect(api.schema("VoucherStatus")["enum"]).toEqual(["active", "redeemed", "cancelled", "expired"]);
    expect(api.schema("VoucherStatus")["description"]).toEqual(expect.stringContaining("derived"));
  });

  it.each([
    ["an active voucher", voucher()],
    ["an all-stores voucher", voucher({ applies_to_all_stores: true, eligible_store_ids: [] })],
    ["an expired voucher", voucher({ status: "expired" })],
    [
      "a redeemed voucher",
      voucher({
        status: "redeemed",
        redemption: { redeemed_at: AT, applied_amount_minor: 3000, forfeited_amount_minor: 2000 },
      }),
    ],
    ["a cancelled voucher", voucher({ status: "cancelled", cancelled_at: AT })],
  ])("accepts %s", (_label, body) => {
    expect(validator("Voucher")(body)).toBe(true);
  });

  it.each([
    ["a code in the read", voucher({ code: "0123-4567-89AB-CDEF" })],
    ["a code hash in the read", voucher({ code_hash: "abc" })],
    ["a tenant id", voucher({ tenant_id: ID })],
    ["an unknown status", voucher({ status: "pending" })],
    ["a missing redemption", (({ redemption: _r, ...rest }) => rest)(voucher())],
    ["a non-positive amount", voucher({ amount_minor: 0 })],
  ])("refuses %s", (_label, body) => {
    expect(validator("Voucher")(body)).toBe(false);
  });

  it("accepts a page with a cursor and a last page, and refuses a page with a code", () => {
    const page = validator("VoucherPage");
    expect(page({ items: [voucher()], next_cursor: "abc" })).toBe(true);
    expect(page({ items: [], next_cursor: null })).toBe(true);
    expect(page({ items: [voucher({ code: "0123-4567-89AB-CDEF" })], next_cursor: null })).toBe(false);
    expect(page({ items: [] })).toBe(false);
  });
});

describe("vouchers-admin — cancel (decision 5A)", () => {
  const cancel = (): OperationObject => op(CANCEL, "post");

  it("requires an idempotency key and has no request body", () => {
    expect(cancel()["x-idempotency" as keyof OperationObject]).toBe("required");
    expect(cancel().parameters).toEqual([{ $ref: "#/components/parameters/IdempotencyKey" }]);
    expect(cancel().requestBody).toBeUndefined();
  });

  it("allows cancelling an expired voucher, is idempotent and refuses a redeemed one", () => {
    expect(cancel().description).toEqual(expect.stringContaining("whether or not its `expires_at` has passed"));
    expect(cancel().description).toEqual(expect.stringContaining("`already_cancelled: true`"));
    expect(cancel().responses?.["409"]?.description).toEqual(expect.stringContaining("`voucher_already_redeemed`"));
    expect(cancel().responses?.["404"]).toEqual({ $ref: "#/components/responses/VoucherNotFound" });
  });

  it("accepts a first cancel and an already-cancelled one, and refuses extra fields", () => {
    const result = validator("VoucherCancelResult");
    expect(result({ voucher_id: ID, status: "cancelled", cancelled_at: AT, already_cancelled: false })).toBe(true);
    expect(result({ voucher_id: ID, status: "cancelled", cancelled_at: AT, already_cancelled: true })).toBe(true);
    expect(result({ voucher_id: ID, status: "active", cancelled_at: AT, already_cancelled: false })).toBe(false);
    expect(result({ voucher_id: ID, status: "cancelled", cancelled_at: AT, already_cancelled: false, code: "x" })).toBe(false);
  });
});

describe("vouchers-admin — the closed error set", () => {
  it("lists exactly the plan's nine codes and the two platform codes", () => {
    expect(api.schema("VoucherAdminErrorCode")["enum"]).toEqual([
      "validation_failure",
      "store_not_found",
      "store_inactive",
      "voucher_not_found",
      "voucher_already_redeemed",
      "forbidden",
      "idempotency_key_required",
      "idempotency_key_malformed",
      "idempotency_key_conflict",
      "origin_rejected",
      "rate_limited",
    ]);
  });

  it("types the envelope's code with that set", () => {
    const error = api.schema("Error")["properties"] as Record<string, { properties?: Record<string, unknown> }>;
    expect(error["error"]?.properties?.["code"]).toEqual({ $ref: "#/components/schemas/VoucherAdminErrorCode" });
    const envelope = validator("Error");
    expect(envelope({ error: { code: "store_not_found", message: "no" } })).toBe(true);
    expect(envelope({ error: { code: "voucher_expired", message: "no" } })).toBe(false);
  });

  it("answers 429 on every operation with the shared console response", () => {
    for (const [, path, method] of OPERATIONS) {
      expect(op(path, method).responses?.["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
    }
  });
});
