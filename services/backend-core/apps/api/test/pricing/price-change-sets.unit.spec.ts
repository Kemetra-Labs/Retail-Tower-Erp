/**
 * RT-1484 (RT-282 PR-09b) — the pure parts of the Price Change Set authoring runtime: the
 * authoring allowlist, the request DTOs (contract `PriceChangeItem` rules, the `TimeBasisRule`,
 * `effectiveTo` after `effectiveFrom`, emergency needs a reason) and the header projection and
 * list cursor. Every accepted item and every projected body is also validated against the
 * contract with AJV. No database, no HTTP.
 */
import "reflect-metadata";

import { HttpException, RequestMethod, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { RolesGuard } from "../../src/auth";
import { PricingAuthoringGuard } from "../../src/pricing/change-sets/price-authoring.guard";
import {
  bindPreviewCursor,
  decodePreviewCursor,
  encodePreviewCursor,
  parsePreviewCursor,
  PreviewCursorError,
} from "../../src/pricing/change-sets/price-change-set-preview";
import { PriceChangeSetsController } from "../../src/pricing/change-sets/price-change-sets.controller";

import {
  isPricingAuthoringAllowed,
  resolvePricingAuthoringConfig,
} from "../../src/pricing/change-sets/price-authoring.config";
import {
  isSelfApproval,
  missingAcknowledgements,
  requiredAcknowledgements,
} from "../../src/pricing/change-sets/price-change-set-approval";
import { instantText, localText } from "../../src/pricing/change-sets/price-change-set-rollback";
import {
  ApprovePriceChangeSetBodySchema,
  CreatePriceChangeSetBodySchema,
  ListChangeSetsQuerySchema,
  RejectPriceChangeSetBodySchema,
  RollbackPriceChangeSetBodySchema,
  SubmitPriceChangeSetBodySchema,
  UpdatePriceChangeSetBodySchema,
  VersionedBodySchema,
  isAfter,
} from "../../src/pricing/change-sets/price-change-sets.dto";
import {
  ChangeSetListCursorError,
  decodeChangeSetListCursor,
  encodeChangeSetListCursor,
  toHeaderBody,
  type ChangeSetRow,
} from "../../src/pricing/change-sets/price-change-sets.projections";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";

const CONTRACT = "price-change-sets";
const T1 = "0192f000-0000-7000-8000-0000000000a1";
const T2 = "0192f000-0000-7000-8000-0000000000a2";
const ID = "0192f000-0000-7000-8000-0000000000b1";
const STORE = "0192f000-0000-7000-8000-0000000000c1";
const ZONE = "0192f000-0000-7000-8000-0000000000d1";
const PRODUCT = "0192f000-0000-7000-8000-0000000000e1";
const USER = "0192f000-0000-7000-8000-0000000000f1";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let schema: (name: string) => ValidateFunction;

beforeAll(() => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT) as object, CONTRACT);
  schema = (name) => {
    const v = ajv.getSchema(`${CONTRACT}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
});

describe("the authoring allowlist (owner decision 1, RT-1484 comment 17829)", () => {
  it("unset or blank allows nobody", () => {
    expect(resolvePricingAuthoringConfig({}).tenantIds.size).toBe(0);
    expect(resolvePricingAuthoringConfig({ PRICING_AUTHORING_TENANT_ALLOWLIST: "  " }).tenantIds.size).toBe(0);
    expect(isPricingAuthoringAllowed(resolvePricingAuthoringConfig({}), T1)).toBe(false);
  });

  it("allows exactly the listed tenants, in any case, around spaces", () => {
    const config = resolvePricingAuthoringConfig({ PRICING_AUTHORING_TENANT_ALLOWLIST: ` ${T1.toUpperCase()} , ` });
    expect(isPricingAuthoringAllowed(config, T1)).toBe(true);
    expect(isPricingAuthoringAllowed(config, T1.toUpperCase())).toBe(true);
    expect(isPricingAuthoringAllowed(config, T2)).toBe(false);
  });

  it("ignores an entry that is not a UUID (fail closed: never widened)", () => {
    const config = resolvePricingAuthoringConfig({ PRICING_AUTHORING_TENANT_ALLOWLIST: `*,${T2},lab` });
    expect([...config.tenantIds]).toEqual([T2]);
    expect(config.ignored).toEqual(["*", "lab"]);
  });
});

const helper = {
  scope: { kind: "zone", zoneId: ZONE },
  products: { kind: "items", productIds: [PRODUCT] },
  effectiveFrom: "2026-12-01T00:00",
};
const setPrice = { op: "set_price", ...helper, price: "125.5000" };

/** Parses with the DTO and asserts the contract agrees. */
function accepts(item: Record<string, unknown>): void {
  const body = { kind: "standard", title: "t", items: [item] };
  expect(CreatePriceChangeSetBodySchema.safeParse(body).success).toBe(true);
  const v = schema("CreatePriceChangeSetRequest");
  if (!v(body)) throw new Error(JSON.stringify(v.errors));
}

function refuses(item: Record<string, unknown>): void {
  expect(CreatePriceChangeSetBodySchema.safeParse({ kind: "standard", title: "t", items: [item] }).success).toBe(false);
}

describe("PriceChangeItem request rules", () => {
  it("accepts each of the six operations", () => {
    accepts(setPrice);
    accepts({ op: "adjust_amount", ...helper, amount: "-5.25" });
    accepts({ op: "adjust_percent", ...helper, percent: "-12.50" });
    accepts({ op: "end_price", scope: { kind: "book" }, products: { kind: "category", categoryId: PRODUCT }, effectiveFrom: "2027-01-01T00:00:00" });
    accepts({ op: "reset_store_override", scope: { kind: "stores", storeIds: [STORE] }, products: setPrice.products, effectiveFrom: "2027-01-01T00:00" });
    accepts({ op: "move_store_zone", storeId: STORE, zoneId: ZONE, effectiveFrom: "2027-01-01T00:00:00Z", effectiveTo: "2027-02-01T00:00:00+02:00" });
  });

  it("refuses an unknown key, a float price, an over-precise price and a missing operation field", () => {
    refuses({ ...setPrice, note: "x" });
    refuses({ ...setPrice, price: 125.5 });
    refuses({ ...setPrice, price: "1.23456" });
    refuses({ op: "set_price", ...helper });
    refuses({ ...setPrice, op: "set_discount" });
  });

  it("the timeBasis rule: no offset for store_local, an offset for absolute", () => {
    refuses({ ...setPrice, effectiveFrom: "2026-12-01T00:00:00+02:00" });
    accepts({ ...setPrice, timeBasis: "absolute", effectiveFrom: "2026-12-01T00:00:00+02:00" });
    refuses({ ...setPrice, timeBasis: "absolute", effectiveFrom: "2026-12-01T00:00" });
    refuses({ op: "move_store_zone", storeId: STORE, zoneId: ZONE, effectiveFrom: "2027-01-01T00:00" });
    refuses({ op: "move_store_zone", storeId: STORE, zoneId: ZONE, timeBasis: "store_local", effectiveFrom: "2027-01-01T00:00:00Z" });
  });

  it("refuses a date-time that is not a calendar value", () => {
    refuses({ ...setPrice, effectiveFrom: "2026-02-30T00:00" });
    refuses({ ...setPrice, effectiveFrom: "2026-12-01T24:00" });
  });

  it("effectiveTo must be after effectiveFrom (400, WriteValidationFailure)", () => {
    accepts({ ...setPrice, effectiveTo: "2026-12-01T00:01" });
    refuses({ ...setPrice, effectiveTo: "2026-12-01T00:00:00" });
    refuses({ ...setPrice, effectiveTo: "2026-11-30T23:59" });
    expect(isAfter("2026-12-01T00:00:00.000001Z", "2026-12-01T00:00:00.000002Z", "absolute")).toBe(true);
    expect(isAfter("2026-12-01T02:00:00+02:00", "2026-12-01T00:00:00Z", "absolute")).toBe(false);
    refuses({ op: "move_store_zone", storeId: STORE, zoneId: ZONE, effectiveFrom: "2027-01-01T00:00:00Z", effectiveTo: "2027-01-01T02:00:00+02:00" });
  });

  it("a reset targets Stores only; an end has no effectiveTo; selector ids do not repeat", () => {
    refuses({ op: "reset_store_override", scope: { kind: "book" }, products: setPrice.products, effectiveFrom: "2027-01-01T00:00" });
    refuses({ op: "end_price", scope: { kind: "book" }, products: setPrice.products, effectiveFrom: "2027-01-01T00:00", effectiveTo: "2027-02-01T00:00" });
    refuses({ ...setPrice, products: { kind: "items", productIds: [PRODUCT, PRODUCT.toUpperCase()] } });
    refuses({ ...setPrice, scope: { kind: "stores", storeIds: [] } });
  });
});

describe("set-level request bodies", () => {
  it("create: emergency needs a reason; rollback is never created here; items default to none", () => {
    expect(CreatePriceChangeSetBodySchema.safeParse({ kind: "standard", title: "t" }).success).toBe(true);
    expect(CreatePriceChangeSetBodySchema.safeParse({ kind: "emergency", title: "t" }).success).toBe(false);
    expect(CreatePriceChangeSetBodySchema.safeParse({ kind: "emergency", title: "t", reason: "r" }).success).toBe(true);
    expect(CreatePriceChangeSetBodySchema.safeParse({ kind: "rollback", title: "t", reason: "r" }).success).toBe(false);
    expect(CreatePriceChangeSetBodySchema.safeParse({ kind: "standard", title: "" }).success).toBe(false);
    expect(CreatePriceChangeSetBodySchema.safeParse({ kind: "standard", title: "t", items: Array(501).fill(setPrice) }).success).toBe(false);
  });

  it("update: expectedVersion and at least one change; reason cannot be removed", () => {
    expect(UpdatePriceChangeSetBodySchema.safeParse({ expectedVersion: 1, title: "n" }).success).toBe(true);
    expect(UpdatePriceChangeSetBodySchema.safeParse({ expectedVersion: 1, items: [] }).success).toBe(true);
    expect(UpdatePriceChangeSetBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(UpdatePriceChangeSetBodySchema.safeParse({ title: "n" }).success).toBe(false);
    expect(UpdatePriceChangeSetBodySchema.safeParse({ expectedVersion: 1, reason: null }).success).toBe(false);
    expect(UpdatePriceChangeSetBodySchema.safeParse({ expectedVersion: 0, title: "n" }).success).toBe(false);
  });

  it("cancel: only expectedVersion", () => {
    expect(VersionedBodySchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
    expect(VersionedBodySchema.safeParse({ expectedVersion: 3, reason: "x" }).success).toBe(false);
    expect(VersionedBodySchema.safeParse({ expectedVersion: "3" }).success).toBe(false);
  });

  it("list query: state, kind, cursor and page_size", () => {
    expect(ListChangeSetsQuerySchema.parse({ state: "draft", page_size: "20" })).toEqual({ state: "draft", page_size: 20 });
    expect(ListChangeSetsQuerySchema.safeParse({ page_size: "0" }).success).toBe(false);
    expect(ListChangeSetsQuerySchema.safeParse({ state: "open" }).success).toBe(false);
  });
});

const row = (over: Partial<ChangeSetRow> = {}): ChangeSetRow => ({
  id: ID,
  kind: "standard",
  title: "Winter prices",
  reason: null,
  state: "draft",
  version: 1,
  validated_at_revision: null,
  preview_hash: null,
  sensitive: null,
  sensitivity_reasons: [],
  revision_no: null,
  rolls_back_change_set_id: null,
  rolled_back_by_change_set_id: null,
  created_by_user_id: USER,
  created_at: new Date("2026-11-20T10:00:00Z"),
  submitted_by_user_id: null,
  submitted_at: null,
  approved_by_user_id: null,
  approved_at: null,
  published_by_user_id: null,
  published_at: null,
  cancelled_by_user_id: null,
  cancelled_at: null,
  rejected_by_user_id: null,
  rejected_at: null,
  rejection_reason: null,
  publication_status: null,
  created_key: "2026-11-20T10:00:00.123456Z",
  ...over,
});

describe("header projection and list cursor", () => {
  it("projects a draft, a cancelled and a rejected-then-edited set to the contract header", () => {
    const v = schema("PriceChangeSetHeader");
    const at = new Date("2026-11-20T11:00:00Z");
    for (const r of [
      row(),
      row({ state: "cancelled", cancelled_by_user_id: USER, cancelled_at: at }),
      row({ version: 3, rejected_by_user_id: USER, rejected_at: at, rejection_reason: "too deep" }),
      row({ state: "validated", validated_at_revision: "0", preview_hash: `sha256:${"a".repeat(64)}`, sensitive: true, sensitivity_reasons: ["approval_mode_always"] }),
    ]) {
      const body = toHeaderBody(r);
      if (!v(body)) throw new Error(`${JSON.stringify(v.errors)} in ${JSON.stringify(body)}`);
    }
    expect(toHeaderBody(row({ validated_at_revision: "0", preview_hash: `sha256:${"a".repeat(64)}`, sensitive: false })).validatedAtRevision).toBe(0);
    expect(toHeaderBody(row({ rejected_by_user_id: USER, rejected_at: at, rejection_reason: "r" })).lastRejection).toEqual({
      userId: USER,
      at: at.toISOString(),
      reason: "r",
    });
  });

  it("the cursor round-trips and is bound to the filters", () => {
    const filters = { state: "draft" as const, kind: null };
    const raw = encodeChangeSetListCursor({ createdKey: "2026-11-20T10:00:00.123456Z", id: ID, ...filters });
    expect(decodeChangeSetListCursor(raw, filters)).toEqual({ createdKey: "2026-11-20T10:00:00.123456Z", id: ID, ...filters });
    expect(() => decodeChangeSetListCursor(raw, { state: null, kind: null })).toThrow(ChangeSetListCursorError);
    expect(() => decodeChangeSetListCursor("not-a-cursor", filters)).toThrow(ChangeSetListCursorError);
  });

  // RT-1484 comment 17881, follow-up 1: an impossible date is a 400, never a Postgres 500.
  it("refuses a cursor whose instant is not a calendar value (02-31)", () => {
    const filters = { state: null, kind: null };
    const raw = encodeChangeSetListCursor({ createdKey: "2026-02-31T10:00:00.000000Z", id: ID, ...filters });
    expect(() => decodeChangeSetListCursor(raw, filters)).toThrow(ChangeSetListCursorError);
  });
});

describe("the preview cursor", () => {
  const HASH_A = `sha256:${"a".repeat(64)}`;
  it("round-trips and is bound to the class filter and the stored preview", () => {
    const raw = encodePreviewCursor({ rowNo: 7, cls: "replaces", previewHash: HASH_A });
    expect(decodePreviewCursor(raw, "replaces", HASH_A)).toBe(7);
    expect(() => decodePreviewCursor(raw, null, HASH_A)).toThrow(PreviewCursorError);
    expect(() => decodePreviewCursor(raw, "replaces", `sha256:${"b".repeat(64)}`)).toThrow(PreviewCursorError);
    expect(() => decodePreviewCursor("bm90", null, HASH_A)).toThrow(PreviewCursorError);
  });

  // Round 4: the structure is checked before any read; the binding after the stored preview is known.
  it("parses the structure first and binds to the preview second", () => {
    const raw = encodePreviewCursor({ rowNo: 3, cls: null, previewHash: HASH_A });
    const parsed = parsePreviewCursor(raw);
    expect(parsed).toEqual({ rowNo: 3, cls: null, previewHash: HASH_A });
    expect(bindPreviewCursor(parsed, null, HASH_A)).toBe(3);
    expect(() => bindPreviewCursor(parsed, "new", HASH_A)).toThrow(PreviewCursorError);
    expect(() => parsePreviewCursor("not-a-cursor")).toThrow(PreviewCursorError);
  });
});

/**
 * RT-1484 comment 17881, follow-up 5: the authoring gate is structural. `PricingAuthoringGuard` is
 * a controller guard after the role check, and every non-GET route of the controller, found by
 * walking its route metadata (so a new write route is covered without editing this spec), is
 * refused for a tenant off the allowlist; every GET route stays open.
 */
describe("the authoring gate is structural (PricingAuthoringGuard)", () => {
  const guard = new PricingAuthoringGuard(resolvePricingAuthoringConfig({ PRICING_AUTHORING_TENANT_ALLOWLIST: T1 }));
  const contextFor = (method: string, tenantId: string | null): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ method, context: tenantId === null ? undefined : { tenantId } }) }),
    }) as unknown as ExecutionContext;

  const routes = Object.getOwnPropertyNames(PriceChangeSetsController.prototype)
    .filter((name) => name !== "constructor")
    .map((name) => {
      const handler = (PriceChangeSetsController.prototype as unknown as Record<string, object>)[name]!;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      return { name, method, path: Reflect.getMetadata(PATH_METADATA, handler) as string | undefined };
    })
    .filter((r) => r.method !== undefined);

  it("runs on the controller after the session, tenant and role guards", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PriceChangeSetsController) as unknown[];
    expect(guards[guards.length - 1]).toBe(PricingAuthoringGuard);
    expect(guards.indexOf(PricingAuthoringGuard)).toBeGreaterThan(guards.indexOf(RolesGuard));
    for (const r of routes) {
      const own = (Reflect.getMetadata(GUARDS_METADATA, (PriceChangeSetsController.prototype as unknown as Record<string, object>)[r.name]!) ?? []) as unknown[];
      expect({ route: r.name, ownGuards: own }).toEqual({ route: r.name, ownGuards: [] });
    }
  });

  it("refuses every non-GET route of a tenant off the allowlist, and lets every GET through", () => {
    const writes = routes.filter((r) => r.method !== RequestMethod.GET);
    expect(writes.map((r) => r.name).sort()).toEqual(["approve", "cancel", "create", "publish", "reject", "rollback", "submit", "update", "validate"]);
    for (const r of routes) {
      const verb = RequestMethod[r.method!];
      if (r.method === RequestMethod.GET) {
        expect(guard.canActivate(contextFor(verb, T2))).toBe(true);
        continue;
      }
      let refusal: unknown;
      try {
        guard.canActivate(contextFor(verb, T2));
      } catch (err) {
        refusal = err;
      }
      expect({ route: r.name, status: (refusal as HttpException | undefined)?.getStatus() }).toEqual({ route: r.name, status: 409 });
      expect((refusal as HttpException).getResponse()).toEqual({ code: "pricing_authority_legacy", message: expect.any(String) });
      expect(guard.canActivate(contextFor(verb, T1.toUpperCase()))).toBe(true);
    }
    expect(() => guard.canActivate(contextFor("POST", null))).toThrow(UnauthorizedException);
  });

  it("validate answers 200 (the contract documents 200 only)", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PriceChangeSetsController.prototype.validate)).toBe(200);
  });

  // RT-1484 PR-5: submit, approve, reject and publish document 200 only.
  it.each(["submit", "approve", "reject", "publish"] as const)("%s answers 200", (handler) => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PriceChangeSetsController.prototype[handler])).toBe(200);
  });

  // RT-1484 PR-6: rollback creates a set (the contract documents 201).
  it("rollback answers 201", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PriceChangeSetsController.prototype.rollback)).toBe(201);
  });
});

// RT-1484 PR-6 (RT-282 PR-10c): the rollback request and the generator's exact time text.
describe("rollback", () => {
  it("takes a reason and an optional strict RFC 3339 `from`; nothing else", () => {
    expect(RollbackPriceChangeSetBodySchema.safeParse({ reason: "Undo" }).success).toBe(true);
    expect(RollbackPriceChangeSetBodySchema.safeParse({ reason: "Undo", from: "2031-03-01T00:00:00.123456+02:00" }).success).toBe(true);
    expect(RollbackPriceChangeSetBodySchema.safeParse({}).success).toBe(false);
    expect(RollbackPriceChangeSetBodySchema.safeParse({ reason: "" }).success).toBe(false);
    expect(RollbackPriceChangeSetBodySchema.safeParse({ reason: "Undo", from: "2031-03-01T00:00" }).success).toBe(false);
    expect(RollbackPriceChangeSetBodySchema.safeParse({ reason: "Undo", from: "2031-02-30T00:00:00Z" }).success).toBe(false);
    expect(RollbackPriceChangeSetBodySchema.safeParse({ reason: "Undo", expectedVersion: 1 }).success).toBe(false);
  });

  it("writes microsecond instants exactly and refuses a sub-second local bound", () => {
    expect(instantText(1_924_992_000_000_001n)).toBe("2031-01-01T00:00:00.000001Z");
    expect(instantText(-1n)).toBe("1969-12-31T23:59:59.999999Z");
    expect(localText(1_924_992_000_000_000n)).toBe("2031-01-01T00:00:00");
    expect(() => localText(1_924_992_000_500_000n)).toThrow(/sub-second/);
  });
});

// RT-1484 PR-5 (RT-282 PR-10b): the approval rules (spec 042 §5, §7; contract AcknowledgedFindings).
describe("approval rules", () => {
  const all = { replaces: true, invalidates_dependent: true, rounded_price: true };
  const none = { replaces: false, invalidates_dependent: false, rounded_price: false };

  it("submit needs rounded_price; straight to approved it also needs replaces and invalidates_dependent", () => {
    expect(requiredAcknowledgements({ kind: "submit", straightToApproved: false }, all)).toEqual(["rounded_price"]);
    expect(requiredAcknowledgements({ kind: "submit", straightToApproved: true }, all)).toEqual(["replaces", "invalidates_dependent", "rounded_price"]);
    expect(requiredAcknowledgements({ kind: "submit", straightToApproved: true }, none)).toEqual([]);
  });

  it("approve needs replaces and invalidates_dependent, never rounded_price", () => {
    expect(requiredAcknowledgements({ kind: "approve" }, all)).toEqual(["replaces", "invalidates_dependent"]);
    expect(requiredAcknowledgements({ kind: "approve" }, { ...none, invalidates_dependent: true })).toEqual(["invalidates_dependent"]);
  });

  it("names every missing acknowledgement; an extra kind is allowed", () => {
    expect(missingAcknowledgements(["replaces", "rounded_price"], undefined)).toEqual(["replaces", "rounded_price"]);
    expect(missingAcknowledgements(["replaces"], ["replaces", "invalidates_dependent"])).toEqual([]);
  });

  it("four eyes: a sensitive (or unknown) set is not approved by its author or submitter", () => {
    const set = { sensitive: true, createdBy: USER, submittedBy: T1 };
    expect(isSelfApproval(set, USER)).toBe(true);
    expect(isSelfApproval(set, T1)).toBe(true);
    expect(isSelfApproval(set, T2)).toBe(false);
    expect(isSelfApproval({ ...set, sensitive: null }, USER)).toBe(true);
    expect(isSelfApproval({ ...set, sensitive: false }, USER)).toBe(false);
  });

  it("request bodies: approve needs the previewHash, reject a reason, findings never repeat", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    expect(SubmitPriceChangeSetBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    expect(SubmitPriceChangeSetBodySchema.safeParse({ expectedVersion: 1, acknowledgedFindings: ["rounded_price", "rounded_price"] }).success).toBe(false);
    expect(SubmitPriceChangeSetBodySchema.safeParse({ expectedVersion: 1, acknowledgedFindings: ["shadowed"] }).success).toBe(false);
    expect(ApprovePriceChangeSetBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(ApprovePriceChangeSetBodySchema.safeParse({ expectedVersion: 1, previewHash: hash, acknowledgedFindings: ["replaces"] }).success).toBe(true);
    expect(ApprovePriceChangeSetBodySchema.safeParse({ expectedVersion: 1, previewHash: "sha256:XYZ" }).success).toBe(false);
    expect(RejectPriceChangeSetBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(RejectPriceChangeSetBodySchema.safeParse({ expectedVersion: 1, reason: "too deep", extra: 1 }).success).toBe(false);
    for (const [name, body] of [
      ["SubmitPriceChangeSetRequest", { expectedVersion: 1, acknowledgedFindings: ["rounded_price"] }],
      ["ApprovePriceChangeSetRequest", { expectedVersion: 1, previewHash: hash }],
      ["RejectPriceChangeSetRequest", { expectedVersion: 1, reason: "too deep" }],
    ] as const) {
      expect({ name, ok: schema(name)(body) }).toEqual({ name, ok: true });
    }
  });

  it("a published set projects its publicationStatus", () => {
    const at = new Date("2026-11-20T11:00:00Z");
    const published = toHeaderBody(
      row({
        state: "published", validated_at_revision: "2", preview_hash: `sha256:${"a".repeat(64)}`, sensitive: true, revision_no: "3",
        submitted_by_user_id: USER, submitted_at: at, approved_by_user_id: T1, approved_at: at, published_by_user_id: USER, published_at: at,
        publication_status: "scheduled",
      }),
    );
    expect(published.publicationStatus).toBe("scheduled");
    if (!schema("PriceChangeSetHeader")(published)) throw new Error("PriceChangeSetHeader contract violation");
  });
});
