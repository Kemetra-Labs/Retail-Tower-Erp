/**
 * RT-1335 (RT-286 slice S2) — the Offer Engine V1 contract
 * (`offers.openapi.yaml`), contract-only.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. Eleven Console operations and the device Pack read at the planned
 *      method and path, every one marked `x-runtime-status: contract-only`
 *      with an RT-1335 note naming the RT-1336 schema and RT-1337 runtime.
 *   2. `cookieAuth` on the Console operations and `device` on the Pack read;
 *      the OD-12 roles and capabilities; no tenant id in any request.
 *   3. The offer definition of spec 048 §5: closed schemas, the parameter
 *      domains, eligibility with exclusion winning (OD-1), store scope and
 *      the two time bases of the schedule.
 *   4. Lifecycle writes: idempotency key, optimistic concurrency on the
 *      draft, the OD-7 conflict body, the pause rules.
 *   5. The Offer Pack: ETag / 304, trusted time and freshness (OD-6, OD-8).
 *   6. The closed error set and the canonical envelopes.
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

const CONTRACT_ID = "offers.openapi";
const LIST: ApiPath = "/api/v1/offers";
const ONE: ApiPath = "/api/v1/offers/{offer_id}";
const DRAFT: ApiPath = "/api/v1/offers/{offer_id}/draft";
const PREVIEW: ApiPath = "/api/v1/offers/{offer_id}/preview";
const PUBLISH: ApiPath = "/api/v1/offers/{offer_id}/publish";
const PAUSE: ApiPath = "/api/v1/offers/{offer_id}/pause";
const RESUME: ApiPath = "/api/v1/offers/{offer_id}/resume";
const END: ApiPath = "/api/v1/offers/{offer_id}/end";
const ARCHIVE: ApiPath = "/api/v1/offers/{offer_id}/archive";
const VERSIONS: ApiPath = "/api/v1/offers/{offer_id}/versions";
const PACK: ApiPath = "/api/pos/v1/store/offer-pack";

type Method = "get" | "post" | "put";

/** [operationId, path, method, x-audit-action] of every Console operation. */
const CONSOLE_OPERATIONS: ReadonlyArray<readonly [string, ApiPath, Method, string]> = [
  ["consoleListOffers", LIST, "get", "offers.listed"],
  ["consoleCreateOfferDraft", LIST, "post", "offer.draft_created"],
  ["consoleGetOffer", ONE, "get", "offers.read"],
  ["consoleUpdateOfferDraft", DRAFT, "put", "offer.draft_updated"],
  ["consolePreviewOffer", PREVIEW, "post", "offers.previewed"],
  ["consolePublishOffer", PUBLISH, "post", "offer.published"],
  ["consolePauseOffer", PAUSE, "post", "offer.paused"],
  ["consoleResumeOffer", RESUME, "post", "offer.resumed"],
  ["consoleEndOffer", END, "post", "offer.ended"],
  ["consoleArchiveOffer", ARCHIVE, "post", "offer.archived"],
  ["consoleListOfferVersions", VERSIONS, "get", "offers.versions_listed"],
];

const WRITES = CONSOLE_OPERATIONS.filter(([id]) => id !== "consolePreviewOffer").filter(([, , m]) => m !== "get");

const ID = "0a000000-0000-7000-8000-000000000001";
const PRODUCT = "0a000000-0000-7000-8000-000000000002";
const CATEGORY = "0a000000-0000-7000-8000-000000000003";
const BRAND = "0a000000-0000-7000-8000-000000000004";
const STORE = "0a000000-0000-7000-8000-000000000005";
const USER = "0a000000-0000-7000-8000-000000000006";
const AT = "2026-12-01T10:00:00.000Z";

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

function op(path: ApiPath, method: Method): OperationObject {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} not declared`);
  return found;
}

const flat = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ");

const bodyOf = (r: unknown): unknown =>
  (r as { content?: Record<string, { schema?: unknown }> } | undefined)?.content?.["application/json"]?.schema;

/** Every property name declared anywhere inside a value. */
function propertyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => propertyNames(v, into));
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const props = record["properties"];
    if (props && typeof props === "object") Object.keys(props as object).forEach((k) => into.add(k));
    Object.values(record).forEach((v) => propertyNames(v, into));
  }
  return into;
}

const parameters = { buyQuantity: 1, getQuantity: 1, percentOff: "40", rewardSelection: "cheapest", maxApplicationsPerSale: null, priceBasis: "resolved_store_price" };

const definition = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nameAr: "القطعة التانية بخصم 40%",
  nameEn: "Second item 40% off",
  type: "buy_x_get_y_percent",
  parameters,
  eligibility: { include: { categoryIds: [CATEGORY], brandIds: [BRAND] }, exclude: { productIds: [PRODUCT] } },
  storeScope: { allStores: true },
  schedule: { timeBasis: "store_local", startsAt: "2026-12-01T00:00", endsAt: "2026-12-31T23:59:59" },
  offlinePolicy: "allow_cached",
  ...over,
});

const version = { version: 1, definition: definition(), publishedAt: AT, publishedByUserId: USER, eligibleSetCount: 120 };

const offer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  offerId: ID,
  state: "active",
  draft: null,
  currentVersion: version,
  pause: null,
  pausedStores: [],
  createdAt: AT,
  updatedAt: AT,
  endedAt: null,
  archivedAt: null,
  rematerialisationConflicts: [],
  ...over,
});

describe("offers — document and operations", () => {
  it("declares the eleven Console operations and the Pack read at the planned paths", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(
      [LIST, ONE, DRAFT, PREVIEW, PUBLISH, PAUSE, RESUME, END, ARCHIVE, VERSIONS, PACK].sort(),
    );
    expect(Object.keys(doc.paths![LIST]!).sort()).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths![DRAFT]!).filter((k) => k !== "parameters")).toEqual(["put"]);
    expect(Object.keys(doc.paths![PACK]!)).toEqual(["get"]);
  });

  it.each(CONSOLE_OPERATIONS)("%s is contract-only, with an RT-1335 note and its audit action", (id, path, method, audit) => {
    const o = op(path, method);
    expect(o.operationId).toBe(id);
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(flat(o["x-runtime-note"])).toEqual(expect.stringContaining("RT-1335"));
    expect(flat(o["x-runtime-note"])).toEqual(expect.stringContaining("RT-1336 schema and the RT-1337 runtime"));
    expect(o["x-audit-action"]).toBe(audit);
  });

  it("posGetOfferPack is contract-only with an RT-1335 note, and writes no audit row", () => {
    const o = op(PACK, "get");
    expect(o.operationId).toBe("posGetOfferPack");
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(flat(o["x-runtime-note"])).toEqual(expect.stringContaining("RT-1335"));
    expect(flat(o["x-runtime-note"])).toEqual(expect.stringContaining("the POS must not call it"));
    expect(o["x-audit-action"]).toBeUndefined();
    expect(flat(doc.info?.description)).toContain("A Pack read writes no audit row");
  });

  it("collides with no operationId in any other contract", () => {
    for (const [id] of CONSOLE_OPERATIONS) expect(otherOperationIds.has(id)).toBe(false);
    expect(otherOperationIds.has("posGetOfferPack")).toBe(false);
  });

  it("states the posture and the slices it waits on", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain("`[GATED: contract]` OpenAPI, and **contract-only**");
    expect(info).toContain("the schema is RT-1336 (S3) and the runtime is RT-1337 (S4)");
    expect(info).toContain("`pos-sales/sales.yaml` 1.22.0-draft");
  });

  it("declares its two tags at the top level", () => {
    expect((doc as { tags?: Array<{ name: string }> }).tags?.map((t) => t.name)).toEqual(["offers-console", "offers-pos"]);
  });
});

describe("offers — auth, roles and capabilities (OD-12)", () => {
  it("has no document-level security: cookieAuth on every Console operation, device on the Pack read", () => {
    expect(doc.security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {}).sort()).toEqual(["cookieAuth", "device"]);
    for (const [, path, method] of CONSOLE_OPERATIONS) expect(op(path, method).security).toEqual([{ cookieAuth: [] }]);
    expect(op(PACK, "get").security).toEqual([{ device: [] }]);
  });

  it("names the three capabilities, the Policy engine and the guard order", () => {
    const info = flat(doc.info?.description);
    for (const capability of ["`offers.manage`", "`offers.publish`", "`offers.pause`"]) expect(info).toContain(capability);
    expect(info).toContain("evaluated through the Policy engine (RT-284)");
    expect(info).toContain("`SessionOnlyAdminGuard`");
    expect(info).toContain("then `TenantContextGuard`, then `RolesGuard`");
  });

  it("gives store_manager the store-level pause and the reads, for their own stores only", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain("`store_manager` holds `offers.pause` for **their own stores only**");
    expect(info).toContain("A `store_manager` sees only the offers whose store scope includes at least one of their stores");
    const pause = flat(op(PAUSE, "post").description);
    expect(pause).toContain("Without `storeIds` the whole offer is paused");
    expect(pause).toContain("a `store_manager` is 403 `forbidden`");
    expect(pause).toContain("a `store_manager` only stores within their own store scope");
    expect(flat(op(RESUME, "post").description)).toContain("Capability `offers.publish` (OD-12)");
    for (const [, path, method] of CONSOLE_OPERATIONS) {
      expect(op(path, method).responses?.["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
    }
  });

  it("takes no tenant id from any request", () => {
    for (const [, path, method] of [...CONSOLE_OPERATIONS, ["posGetOfferPack", PACK, "get", ""] as const]) {
      const names = (op(path, method).parameters ?? []).map((p) => (p.$ref ? p.$ref.split("/").pop() : p.name));
      expect(names.join(",")).not.toMatch(/tenant/i);
    }
    const names = [...propertyNames(doc.components?.schemas)];
    expect(names).not.toContain("tenant_id");
    expect(names).not.toContain("tenantId");
  });

  it("answers 429 on every Console operation and none on the device read", () => {
    for (const [, path, method] of CONSOLE_OPERATIONS) {
      expect(op(path, method).responses?.["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
    }
    expect(op(PACK, "get").responses?.["429"]).toBeUndefined();
  });
});

describe("offers — the offer definition (spec 048 §5)", () => {
  it("closes every request and read schema", () => {
    for (const name of [
      "BuyXGetYPercentParameters",
      "EligibilitySet",
      "Eligibility",
      "OfferSchedule",
      "OfferDefinition",
      "OfferDraftCreateRequest",
      "OfferDraftUpdateRequest",
      "OfferPreviewRequest",
      "OfferSimulationRequest",
      "OfferSimulationLine",
      "OfferPublishRequest",
      "OfferPauseRequest",
      "OfferResumeRequest",
      "OfferDraft",
      "OfferVersion",
      "OfferPause",
      "OfferStorePause",
      "Offer",
      "OfferSummary",
      "OfferPage",
      "OfferVersionPage",
      "OfferConflict",
      "OfferPreviewIssue",
      "OfferEligibleProduct",
      "OfferSimulationResult",
      "OfferSimulationResultLine",
      "OfferPreview",
      "OfferPack",
      "PackOffer",
      "OfferRematerialisationConflict",
    ]) {
      expect([name, api.schema(name)["additionalProperties"]]).toEqual([name, false]);
    }
  });

  it("pins the V1 parameter domains", () => {
    const props = api.schema("BuyXGetYPercentParameters")["properties"] as Record<string, Record<string, unknown>>;
    expect(props["buyQuantity"]).toMatchObject({ type: "integer", minimum: 1 });
    expect(props["getQuantity"]).toMatchObject({ type: "integer", minimum: 1 });
    expect(props["percentOff"]).toEqual({ $ref: "#/components/schemas/WholePercent" });
    expect(api.schema("WholePercent")["pattern"]).toBe("^(100|[1-9][0-9]?)$");
    expect(props["rewardSelection"]).toMatchObject({ const: "cheapest" });
    expect(props["priceBasis"]).toMatchObject({ const: "resolved_store_price" });
    expect(props["maxApplicationsPerSale"]).toMatchObject({ type: ["integer", "null"], minimum: 1 });
    expect(api.schema("OfferType")["const"]).toBe("buy_x_get_y_percent");
    expect(api.schema("OfflinePolicy")).toMatchObject({ enum: ["allow_cached", "online_only"], default: "allow_cached" });
    expect(api.schema("OfferState")["enum"]).toEqual(["draft", "scheduled", "active", "paused", "ended", "archived"]);
  });

  it("states the eligibility rules: exclusion always wins (OD-1), brand ids wait for RT-1334", () => {
    expect(flat(api.schema("Eligibility")["description"])).toContain("exclusion always wins, whatever its dimension (OD-1)");
    expect(flat(api.schema("EligibilitySet")["description"])).toContain("RT-1334");
    expect(flat(api.schema("EligibilityInclude")["description"])).toContain("400 `validation_error`");
  });

  it.each([
    ["a category and brand offer with a product exclusion", definition()],
    ["a product-only offer with no exclusions and no English name", definition({ nameEn: undefined, eligibility: { include: { productIds: [PRODUCT] } } })],
    ["a store list and an absolute open-ended window", definition({ storeScope: { storeIds: [STORE] }, schedule: { timeBasis: "absolute", startsAt: "2026-12-01T00:00:00+02:00", endsAt: null } })],
    ["a capped, free-reward offer", definition({ parameters: { ...parameters, getQuantity: 2, percentOff: "100", maxApplicationsPerSale: 3 } })],
    ["the default offline policy", (({ offlinePolicy: _o, ...rest }) => rest)(definition())],
  ])("accepts %s", (_label, body) => {
    const clean = JSON.parse(JSON.stringify(body)) as unknown;
    const validate = validator("OfferDefinition");
    expect([validate(clean), validate.errors]).toEqual([true, null]);
  });

  it.each([
    ["an include that names nothing", definition({ eligibility: { include: {} } })],
    ["an include of empty lists", definition({ eligibility: { include: { productIds: [], categoryIds: [] } } })],
    ["a missing include", definition({ eligibility: { exclude: { productIds: [PRODUCT] } } })],
    ["another offer type", definition({ type: "spend_x_get_y" })],
    ["percent 0", definition({ parameters: { ...parameters, percentOff: "0" } })],
    ["percent 101", definition({ parameters: { ...parameters, percentOff: "101" } })],
    ["a fractional percent", definition({ parameters: { ...parameters, percentOff: "12.5" } })],
    ["a numeric percent", definition({ parameters: { ...parameters, percentOff: 40 } })],
    ["buyQuantity 0", definition({ parameters: { ...parameters, buyQuantity: 0 } })],
    ["getQuantity 0", definition({ parameters: { ...parameters, getQuantity: 0 } })],
    ["maxApplicationsPerSale 0", definition({ parameters: { ...parameters, maxApplicationsPerSale: 0 } })],
    ["another reward selection", definition({ parameters: { ...parameters, rewardSelection: "most_expensive" } })],
    ["another price basis", definition({ parameters: { ...parameters, priceBasis: "list_price" } })],
    ["allStores false", definition({ storeScope: { allStores: false } })],
    ["both allStores and storeIds", definition({ storeScope: { allStores: true, storeIds: [STORE] } })],
    ["an empty store list", definition({ storeScope: { storeIds: [] } })],
    ["a store_local start with an offset", definition({ schedule: { timeBasis: "store_local", startsAt: "2026-12-01T00:00:00+02:00" } })],
    ["an absolute start without an offset", definition({ schedule: { timeBasis: "absolute", startsAt: "2026-12-01T00:00:00" } })],
    ["an unknown time basis", definition({ schedule: { timeBasis: "utc", startsAt: AT } })],
    ["an unknown offline policy", definition({ offlinePolicy: "always" })],
    ["a missing Arabic name", (({ nameAr: _n, ...rest }) => rest)(definition())],
    ["a client-sent tenant id", definition({ tenantId: ID })],
    ["an unknown key in the parameters", definition({ parameters: { ...parameters, stacking: "exclusive" } })],
    ["an unknown eligibility dimension", definition({ eligibility: { include: { tagIds: [ID] } } })],
    ["a duplicate product", definition({ eligibility: { include: { productIds: [PRODUCT, PRODUCT] } } })],
  ])("refuses %s", (_label, body) => {
    expect(validator("OfferDefinition")(body)).toBe(false);
  });

  it("bounds the eligibility lists", () => {
    expect(api.schema("UuidList")).toMatchObject({ maxItems: 5000, uniqueItems: true });
    const many = Array.from({ length: 5001 }, (_, i) => `0a000000-0000-7000-8000-${String(i).padStart(12, "0")}`);
    expect(validator("OfferDefinition")(definition({ eligibility: { include: { productIds: many } } }))).toBe(false);
  });
});

describe("offers — lifecycle writes", () => {
  it.each(WRITES)("%s requires an idempotency key and documents the 425", (_id, path, method) => {
    const o = op(path, method);
    expect(o["x-idempotency" as keyof OperationObject]).toBe("required");
    expect(o.parameters).toEqual([{ $ref: "#/components/parameters/IdempotencyKey" }]);
    expect(o.responses?.["425"]).toEqual({ $ref: "#/components/responses/InProgress" });
  });

  it("the preview changes nothing and takes no idempotency key", () => {
    const preview = op(PREVIEW, "post");
    expect(preview["x-idempotency" as keyof OperationObject]).toBeUndefined();
    expect(preview.parameters).toBeUndefined();
    expect(flat(preview.description)).toContain("changes nothing: no state, no version, no Pack revision");
    expect(flat(preview.description)).toContain("a sample of up to 20 products");
    expect(api.schema("OfferPreview")["required"]).toEqual(
      expect.arrayContaining(["eligibleSet", "conflicts", "simulation", "issues", "publishable"]),
    );
  });

  it("guards the draft with an optimistic-concurrency token", () => {
    expect(api.schema("OfferDraftUpdateRequest")["required"]).toEqual(["expectedDraftRevision", "definition"]);
    expect(api.schema("OfferPublishRequest")["required"]).toEqual(["expectedDraftRevision"]);
    expect(op(DRAFT, "put").responses?.["409"]?.description).toEqual(expect.stringContaining("offer_draft_changed_concurrently"));
    const update = validator("OfferDraftUpdateRequest");
    expect(update({ expectedDraftRevision: 3, definition: definition() })).toBe(true);
    expect(update({ expectedDraftRevision: null, definition: definition() })).toBe(true);
    expect(update({ definition: definition() })).toBe(false);
    expect(update({ expectedDraftRevision: 0, definition: definition() })).toBe(false);
  });

  it("publish refuses overlaps (OD-7) with the conflicting offers in the body", () => {
    const publish = flat(op(PUBLISH, "post").description);
    expect(publish).toContain("409 `offer_conflict` (OD-7), whose body lists each conflicting offer and the number of shared products");
    expect(publish).toContain("immutable");
    const envelope = validator("OfferError");
    const conflict = { offerId: ID, offerVersion: 2, nameAr: "عرض", state: "active", sharedProductCount: 3, sharedProductSample: [PRODUCT] };
    expect(envelope({ error: { code: "offer_conflict", message: "overlap", request_id: ID, conflicts: [conflict] } })).toBe(true);
    expect(envelope({ error: { code: "offer_conflict", message: "overlap", conflicts: [{ ...conflict, sharedProductCount: 0 }] } })).toBe(false);
    expect(envelope({ error: { code: "offer_conflict", message: "overlap", conflicts: [{ ...conflict, state: "draft" }] } })).toBe(false);
  });

  it("pause needs a reason of 1 to 500 characters, with optional stores", () => {
    const pause = validator("OfferPauseRequest");
    expect(pause({ reason: "wrong eligible set" })).toBe(true);
    expect(pause({ reason: "x".repeat(500), storeIds: [STORE] })).toBe(true);
    expect(pause({})).toBe(false);
    expect(pause({ reason: "" })).toBe(false);
    expect(pause({ reason: "x".repeat(501) })).toBe(false);
    expect(pause({ reason: "r", storeIds: [] })).toBe(false);
    expect(pause({ reason: "r", storeIds: [STORE, STORE] })).toBe(false);
    expect(flat(op(PAUSE, "post").description)).toContain("Pausing never deletes history (§21)");
  });

  it("archives only an ended offer, and an ended offer cannot be resumed", () => {
    expect(flat(op(ARCHIVE, "post").description)).toContain("Only an `ended` offer can be archived");
    expect(flat(op(END, "post").description)).toContain("An `ended` offer cannot be resumed or published again");
  });

  it("validates an offer read, with its draft, version and pauses", () => {
    const read = validator("Offer");
    expect(read(offer())).toBe(true);
    expect(read(offer({ state: "draft", currentVersion: null, draft: { draftRevision: 1, definition: definition(), updatedAt: AT, updatedByUserId: USER } }))).toBe(true);
    expect(read(offer({ state: "paused", pause: { pausedAt: AT, pausedByUserId: USER, reason: "audit" } }))).toBe(true);
    expect(read(offer({ pausedStores: [{ storeId: STORE, pausedAt: AT, pausedByUserId: USER, reason: "stock" }] }))).toBe(true);
    expect(read(offer({ state: "expired" }))).toBe(false);
    expect(read(offer({ tenantId: ID }))).toBe(false);
    expect(read((({ draft: _d, ...rest }) => rest)(offer()))).toBe(false);
    const kept = { offerId: ID, offerVersion: 1, nameAr: "عرض", removedProductCount: 2, removedProductSample: [PRODUCT] };
    expect(read(offer({ rematerialisationConflicts: [kept] }))).toBe(true);
    expect(read(offer({ rematerialisationConflicts: [{ ...kept, removedProductCount: 0 }] }))).toBe(false);
    expect(read((({ rematerialisationConflicts: _r, ...rest }) => rest)(offer()))).toBe(false);
  });

  it("filters other stores out of what a store_manager reads", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain(
      "the server filters every `storeScope.storeIds` and `pausedStores` list to the caller's own stores, so another store's id, pause reason and pausing user are never returned; an all-stores offer reads `allStores: true`",
    );
    for (const name of ["Offer", "OfferSummary", "OfferVersion"]) {
      expect([name, flat(api.schema(name)["description"])]).toEqual([name, expect.stringContaining("to the caller's own stores")]);
    }
  });

  it("re-materialisation keeps a product in the earliest-published offer only (OD-7 clarification)", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain("keeps the product only in the offer published EARLIEST (tie: the lower `offerId`)");
    expect(info).toContain("`Offer.rematerialisationConflicts`");
    expect(info).toContain("a product id appears in at most one offer's `eligibleProductIds` in a Pack");
    expect(info).toContain("A paused offer counts, so that resuming it can never create an overlap");
    expect(flat(op(PACK, "get").description)).toContain("a product id appears in at most one offer's `eligibleProductIds` in a Pack");
    expect(flat(op(PACK, "get").description)).toContain("is omitted from the Pack");
    expect(api.schema("OfferSummary")["required"]).toContain("rematerialisationConflictCount");
  });

  it("refuses a publish or resume that would give a store more than 200 live offers", () => {
    expect(flat(doc.info?.description)).toContain("`offer_store_offer_limit_exceeded`");
    expect(flat(op(PUBLISH, "post").description)).toContain("`offer_store_offer_limit_exceeded`");
    expect(flat(op(RESUME, "post").description)).toContain("422 `offer_store_offer_limit_exceeded`");
    expect(api.schema("OfferPack")["properties"]).toMatchObject({ offers: { maxItems: 200 } });
  });

  it("validates a preview with a simulation", () => {
    const preview = validator("OfferPreview");
    const simulation = {
      currencyCode: "EGP",
      applications: 1,
      totalDiscount: "16.00",
      total: "184.00",
      lines: [
        { lineIndex: 0, unitPrice: "100.00", quantity: 1, eligible: true, discountAmount: "0.00", lineAmount: "100.00" },
        { lineIndex: 1, unitPrice: "60.00", quantity: 1, eligible: true, discountAmount: "0.00", lineAmount: "60.00" },
        { lineIndex: 2, unitPrice: "40.00", quantity: 1, eligible: true, discountAmount: "16.00", lineAmount: "24.00" },
      ],
    };
    const body = {
      offerId: ID,
      draftRevision: 2,
      publishable: true,
      issues: [],
      eligibleSet: { count: 1, sample: [{ productId: PRODUCT, sku: "SKU-1", name: "Runner" }] },
      conflicts: [],
      simulation,
    };
    expect(preview(body)).toBe(true);
    expect(preview({ ...body, simulation: null })).toBe(true);
    expect(preview({ ...body, issues: [{ code: "offer_eligible_set_empty", field: null, message: "empty" }], publishable: false })).toBe(true);
    expect(preview({ ...body, issues: [{ code: "forbidden", message: "no" }] })).toBe(false);
    expect(preview({ ...body, simulation: { ...simulation, totalDiscount: 16 } })).toBe(false);
    const request = validator("OfferPreviewRequest");
    expect(request({})).toBe(true);
    expect(request({ expectedDraftRevision: 2, simulation: { currencyCode: "EGP", lines: [{ unitPrice: "40.00" }, { unitPrice: "60.00", quantity: 2, productId: PRODUCT }] } })).toBe(true);
    expect(request({ simulation: { currencyCode: "EGP", lines: [] } })).toBe(false);
    expect(request({ simulation: { currencyCode: "EGP", lines: [{ unitPrice: -1 }] } })).toBe(false);
  });

  it("lists offers and versions with keyset pagination", () => {
    expect(api.params(LIST).map((p) => p.name)).toEqual(["state", "store_id", "cursor", "page_size"]);
    expect(api.params(VERSIONS).map((p) => p.name)).toEqual(["cursor", "page_size"]);
    expect(api.param(LIST, "page_size").schema).toMatchObject({ minimum: 1, maximum: 100, default: 50 });
    expect(api.param(LIST, "cursor").schema).toMatchObject({ type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" });
    const page = validator("OfferVersionPage");
    expect(page({ items: [version], nextCursor: null })).toBe(true);
    expect(page({ items: [{ ...version, version: 0 }], nextCursor: null })).toBe(false);
  });
});

describe("offers — the Offer Pack (spec 048 §7, OD-6, OD-8)", () => {
  const pack = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    packRevision: 118,
    issuedAt: AT,
    freshnessWindowHours: 24,
    storeTimezone: "Africa/Cairo",
    currencyCode: "EGP",
    offers: [
      {
        offerId: ID,
        offerVersion: 3,
        nameAr: "القطعة التانية بخصم 40%",
        nameEn: null,
        type: "buy_x_get_y_percent",
        parameters,
        startsAt: "2026-11-30T22:00:00Z",
        endsAt: null,
        offlinePolicy: "allow_cached",
        eligibleProductIds: [PRODUCT],
      },
    ],
    ...over,
  });

  it("is a conditional device read: 200 or 304, with ETag, no-cache and the server time", () => {
    const read = op(PACK, "get");
    expect(read.parameters).toEqual([{ $ref: "#/components/parameters/IfNoneMatch" }]);
    for (const status of ["200", "304"]) {
      expect(Object.keys(read.responses?.[status]?.headers ?? {}).sort()).toEqual(["Cache-Control", "ETag", "X-Server-Time"]);
    }
    expect(bodyOf(read.responses?.["304"])).toBeUndefined();
    expect(doc.components?.headers?.["ETag"]?.description).toEqual(expect.stringContaining("without `issuedAt`"));
    expect(doc.components?.headers?.["CacheControl"]?.schema).toEqual({ type: "string", const: "no-cache, private" });
  });

  it("states trusted time, freshness, the restart rule and revalidation by the cited revision", () => {
    const text = flat(op(PACK, "get").description);
    expect(text).toContain("plus the time elapsed since that read on a monotonic clock");
    expect(text).toContain("(a tenant setting, 1 to 72, default 24)");
    expect(text).toContain("A stale Pack applies no offer while the till is offline");
    expect(text).toContain("it treats the Pack as stale and applies no offer");
    expect(text).toContain("Backend-Core judges a sale against the Pack revision it cites");
    expect(text).toContain("matching product ids only");
  });

  it("validates a Pack and refuses a malformed one", () => {
    const validate = validator("OfferPack");
    expect(validate(pack())).toBe(true);
    expect(validate(pack({ packRevision: 0, offers: [] }))).toBe(true);
    expect(validate(pack({ freshnessWindowHours: 0 }))).toBe(false);
    expect(validate(pack({ freshnessWindowHours: 73 }))).toBe(false);
    const offers = pack()["offers"] as Array<Record<string, unknown>>;
    expect(validate(pack({ offers: [{ ...offers[0], eligibleProductIds: [] }] }))).toBe(false);
    expect(validate(pack({ offers: [{ ...offers[0], categoryIds: [CATEGORY] }] }))).toBe(false);
    expect(validate(pack({ offers: [{ ...offers[0], startsAt: "2026-12-01T00:00" }] }))).toBe(false);
    expect(api.schema("PackOffer")["properties"]).toMatchObject({ eligibleProductIds: { maxItems: 20000, uniqueItems: true } });
  });

  it("is not a build identity reporting or rotate-hint operation yet", () => {
    const read = op(PACK, "get");
    const names = (read.parameters ?? []).map((p) => p.$ref ?? p.name);
    expect(names.join(",")).not.toMatch(/PosBuildCommit|X-POS-/);
    expect(Object.keys(read.responses?.["200"]?.headers ?? {})).not.toContain("X-Device-Token-Rotate-After");
  });
});

describe("offers — the closed error set", () => {
  it("lists the offer and idempotency codes and the two platform codes", () => {
    expect(api.schema("OfferErrorCode")["enum"]).toEqual([
      "validation_error",
      "forbidden",
      "offer_not_found",
      "store_not_found",
      "offer_state_invalid",
      "offer_draft_changed_concurrently",
      "offer_conflict",
      "offer_reference_invalid",
      "offer_schedule_elapsed",
      "offer_eligible_set_empty",
      "offer_eligible_set_too_large",
      "offer_store_offer_limit_exceeded",
      "offer_store_not_in_scope",
      "idempotency_key_required",
      "idempotency_key_malformed",
      "idempotency_key_conflict",
      "origin_rejected",
      "rate_limited",
    ]);
  });

  it("types the offer-domain envelope's code with that set", () => {
    const envelope = validator("OfferError");
    expect(envelope({ error: { code: "offer_not_found", message: "no" } })).toBe(true);
    expect(envelope({ error: { code: "voucher_not_found", message: "no" } })).toBe(false);
    expect(envelope({ error: { code: "offer_not_found", message: "no", details: [] } })).toBe(false);
  });

  it("keeps the platform envelope's code a free string, so a real 401 or 403 still decodes", () => {
    const error = api.schema("Error")["properties"] as Record<string, { properties?: Record<string, unknown> }>;
    expect(error["error"]?.properties?.["code"]).toEqual({ type: "string" });
    expect(validator("Error")({ error: { code: "Unauthorized", message: "Unauthorized" } })).toBe(true);
  });

  it("uses the typed envelope on every offer-domain 400, 404, 409 and 422, and the free one on 401, 403, 429 and 500", () => {
    const typed = { $ref: "#/components/schemas/OfferError" };
    const resolve = (r: unknown): unknown => {
      const ref = (r as { $ref?: string } | undefined)?.$ref;
      return ref ? doc.components?.responses?.[ref.split("/").pop()!] : r;
    };
    for (const [id, path, method] of CONSOLE_OPERATIONS) {
      for (const status of ["400", "404", "409", "422"]) {
        const r = op(path, method).responses?.[status];
        if (r) expect([id, status, bodyOf(resolve(r))]).toEqual([id, status, typed]);
      }
    }
    for (const name of ["Unauthorized", "Forbidden", "TooManyRequests", "SystemFailure", "DeviceUnauthorized"]) {
      expect([name, bodyOf(doc.components?.responses?.[name])]).toEqual([name, { $ref: "#/components/schemas/Error" }]);
    }
  });

  it("limits origin_rejected to the POST and PUT operations", () => {
    expect(flat(doc.info?.description)).toContain("`origin_rejected` (RT-430) on the Console POST and PUT operations only");
    expect(api.responseDescription("Forbidden")).toEqual(expect.stringContaining("on the POST and PUT"));
  });

  it("declares the platform's 425 body, not the canonical envelope", () => {
    expect(bodyOf(doc.components?.responses?.["InProgress"])).toEqual({ $ref: "#/components/schemas/IdempotencyInProgress" });
    const body = validator("IdempotencyInProgress");
    expect(body({ error: "idempotency_in_progress", retryAfterSec: 2 })).toBe(true);
    expect(body({ error: "idempotency_in_progress" })).toBe(false);
  });
});
