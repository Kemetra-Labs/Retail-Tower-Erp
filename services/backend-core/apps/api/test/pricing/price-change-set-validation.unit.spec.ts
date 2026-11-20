/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the pure parts of `validate`: exact helper arithmetic and
 * `deltaPct`, the lead-time rule, the two hashes and the materialization / classification engine
 * (spec 042 §4.3, §5, §6; RT-1484 comments 17881 and 17882). No database, no HTTP.
 */
import {
  canonicalJson,
  previewHash,
  targetStoreSetHash,
} from "../../src/pricing/change-sets/price-change-set-hashes";
import { DEFAULT_MIN_LEAD_TIME_MS, violatesLeadTime } from "../../src/pricing/change-sets/price-change-set-lead-time";
import {
  comparePrices,
  deltaPercent,
  helperPrice,
  normalizePrice,
} from "../../src/pricing/change-sets/price-change-set-money";
import { checkBudget, referencedIds, validateChangeSet } from "../../src/pricing/change-sets/price-change-set-validation";
import {
  CLASS_SEVERITY,
  isBlocking,
  MAX_LINES,
  MAX_PREVIEW_ROWS,
  type PendingLine,
  type PositionedItem,
  type ValidationContext,
  type ValidationRefusal,
  type ValidationResult,
} from "../../src/pricing/change-sets/price-change-set-validation.types";
import type { PriceChangeItem } from "../../src/pricing/change-sets/price-change-sets.dto";
import type { ResolutionPriceEvent, ResolutionZoneMembership } from "../../src/pricing/resolution/types";

const id = (tag: string): string => `0192f000-0000-7000-8000-${tag.padStart(12, "0")}`;
const TENANT = id("a1");
const BOOK = id("b1");
const ZONE_DEFAULT = id("d1");
const ZONE_NORTH = id("d2");
const S_UTC = id("c1");
const S_NY = id("c2");
const S_GONE = id("c3");
const P1 = id("e1");
const P2 = id("e2");
const P_RETIRED = id("e3");
const NOW = Date.parse("2030-06-01T00:00:00Z");

describe("exact money (spec 041 §6, decisions 515–517)", () => {
  it("adds an amount and applies a percent exactly", () => {
    expect(helperPrice("100.0000", { amount: "-12.5" }, 2)).toEqual({ kind: "price", price: "87.5000", roundedFrom: null });
    expect(helperPrice("100.0000", { percent: "10" }, 2)).toEqual({ kind: "price", price: "110.0000", roundedFrom: null });
    expect(helperPrice("100", { percent: "-12.50" }, 2)).toEqual({ kind: "price", price: "87.5000", roundedFrom: null });
  });

  it("rounds half-up at the minor unit and keeps the exact value", () => {
    expect(helperPrice("10.0000", { percent: "3.33" }, 2)).toEqual({ kind: "price", price: "10.3300", roundedFrom: "10.33300000" });
    expect(helperPrice("10.0000", { percent: "0.05" }, 2)).toEqual({ kind: "price", price: "10.0100", roundedFrom: "10.00500000" });
    expect(helperPrice("10.0000", { amount: "0.0050" }, 2)).toEqual({ kind: "price", price: "10.0100", roundedFrom: "10.00500000" });
    expect(helperPrice("10.0000", { amount: "0.004" }, 0)).toEqual({ kind: "price", price: "10.0000", roundedFrom: "10.00400000" });
  });

  it("refuses a result that is not above 0, before or after rounding (Q-4)", () => {
    expect(helperPrice("10.0000", { amount: "-10" }, 2)).toEqual({ kind: "not_positive" });
    expect(helperPrice("10.0000", { percent: "-100" }, 2)).toEqual({ kind: "not_positive" });
    expect(helperPrice("0.0040", { amount: "0" }, 2)).toEqual({ kind: "not_positive" });
  });

  it("refuses a result beyond numeric(19,4)", () => {
    expect(helperPrice("999999999999999.0000", { percent: "10" }, 2)).toEqual({ kind: "not_representable" });
  });

  it("normalizes, compares and computes deltaPct half away from zero", () => {
    expect(normalizePrice("12.5")).toBe("12.5000");
    expect(normalizePrice("1.23456")).toBeNull();
    expect(comparePrices("10.5", "10.5000")).toBe(0);
    expect(comparePrices("10.4999", "10.5")).toBe(-1);
    expect(deltaPercent("130.0000", "125.5000")).toBe("-3.46");
    expect(deltaPercent("3.0000", "4.0000")).toBe("33.33");
    expect(deltaPercent("3.0000", "2.0000")).toBe("-33.33");
    expect(deltaPercent("0.0001", "999999999999999.9999")).toBe("999999999999999999800.00");
    expect(deltaPercent("0", "1")).toBeNull();
  });
});

describe("lead time (spec 042 §7, comment 17875 decision 2)", () => {
  const base = { nowMs: NOW, effectiveMs: [NOW + 30 * 60_000] };
  it("defaults to none in v1", () => {
    expect(DEFAULT_MIN_LEAD_TIME_MS).toBe(0);
    expect(violatesLeadTime({ ...base, kind: "standard", minLeadTimeMs: DEFAULT_MIN_LEAD_TIME_MS })).toBe(false);
  });
  it("refuses a standard set inside the lead time; emergency and rollback are exempt; past instants are past_dated", () => {
    expect(violatesLeadTime({ ...base, kind: "standard", minLeadTimeMs: 60 * 60_000 })).toBe(true);
    expect(violatesLeadTime({ ...base, kind: "standard", minLeadTimeMs: 10 * 60_000 })).toBe(false);
    expect(violatesLeadTime({ ...base, kind: "emergency", minLeadTimeMs: 60 * 60_000 })).toBe(false);
    expect(violatesLeadTime({ ...base, kind: "rollback", minLeadTimeMs: 60 * 60_000 })).toBe(false);
    expect(violatesLeadTime({ kind: "standard", nowMs: NOW, minLeadTimeMs: 60 * 60_000, effectiveMs: [NOW - 1] })).toBe(false);
  });
});

describe("hashes (spec 042 §6, comment 17882 decision 3)", () => {
  it("canonical JSON sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  });
  it("targetStoreSetHash is order-free and changes with a time zone (Q-B8)", () => {
    const one = targetStoreSetHash([{ storeId: S_NY, timezone: "America/New_York" }, { storeId: S_UTC, timezone: "UTC" }]);
    const two = targetStoreSetHash([{ storeId: S_UTC, timezone: "UTC" }, { storeId: S_NY, timezone: "America/New_York" }]);
    expect(one).toBe(two);
    expect(one).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(targetStoreSetHash([{ storeId: S_UTC, timezone: "Africa/Cairo" }, { storeId: S_NY, timezone: "America/New_York" }])).not.toBe(one);
  });
  it("previewHash binds the revision", () => {
    const input = { validatedAtRevision: 3, targetStoreSetHash: "sha256:x", lines: [], previewRows: [], membershipChanges: [] };
    expect(previewHash(input)).toBe(previewHash({ ...input }));
    expect(previewHash({ ...input, validatedAtRevision: 4 })).not.toBe(previewHash(input));
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function event(e: Partial<ResolutionPriceEvent> & Pick<ResolutionPriceEvent, "id" | "scope" | "productId" | "price">): ResolutionPriceEvent {
  return {
    tenantId: TENANT,
    priceBookId: BOOK,
    priceZoneId: null,
    storeId: null,
    sellUnit: "each",
    priceKind: "regular",
    timeBasis: "absolute",
    effectiveFrom: new Date("2030-01-01T00:00:00Z"),
    effectiveTo: null,
    effectiveFromLocal: null,
    effectiveToLocal: null,
    publishedInRevision: 1,
    endedInRevision: null,
    ...e,
  };
}

function membership(m: Partial<ResolutionZoneMembership> & Pick<ResolutionZoneMembership, "id" | "storeId" | "priceZoneId" | "effectiveFrom">): ResolutionZoneMembership {
  return { tenantId: TENANT, priceBookId: BOOK, effectiveTo: null, publishedInRevision: 1, endedInRevision: null, ...m };
}

function context(over: Partial<ValidationContext> = {}): ValidationContext {
  return {
    tenantId: TENANT,
    kind: "standard",
    nowMs: NOW,
    headRevision: 2,
    book: { id: BOOK, tenantId: TENANT, currencyCode: "EGP", taxPriceBasis: "inclusive", defaultZoneId: ZONE_DEFAULT },
    zones: new Map([[ZONE_DEFAULT, { live: true }], [ZONE_NORTH, { live: true }]]),
    stores: new Map([
      [S_UTC, { id: S_UTC, timezone: "UTC", live: true }],
      [S_NY, { id: S_NY, timezone: "America/New_York", live: true }],
      [S_GONE, { id: S_GONE, timezone: "UTC", live: false }],
    ]),
    products: new Map([[P1, { live: true }], [P2, { live: true }], [P_RETIRED, { live: false }]]),
    categoryProducts: new Map(),
    memberships: [],
    events: [],
    pendingLines: [],
    helperEventIds: new Set(),
    devices: new Map([[S_UTC, 2], [S_NY, 1]]),
    ...over,
  };
}

const items = (...list: PriceChangeItem[]): PositionedItem[] => list.map((item, i) => ({ position: i + 1, item }));
const bookPrice = (price: string, from = "2031-01-01T00:00:00Z", extra: Partial<PriceChangeItem> = {}): PriceChangeItem =>
  ({ op: "set_price", scope: { kind: "book" }, products: { kind: "items", productIds: [P1] }, price, timeBasis: "absolute", effectiveFrom: from, ...extra }) as PriceChangeItem;

function ok(r: ValidationResult | ValidationRefusal): ValidationResult {
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.message}`);
  return r;
}

describe("validate engine — classes (spec 042 §5, comment 17882)", () => {
  it("orders the classes most severe first", () => {
    expect(CLASS_SEVERITY).toEqual(["invalid", "past_dated", "replaces", "conflicts_pending", "shadowed", "invalidates_dependent", "new"]);
    expect(isBlocking("past_dated", "standard")).toBe(true);
    expect(isBlocking("past_dated", "emergency")).toBe(false);
    expect(isBlocking("past_dated", "rollback")).toBe(false);
    expect(isBlocking("invalid", "emergency")).toBe(true);
  });

  it("new: a Book line reaches every live Store, in id order, with its old and new price", () => {
    const r = ok(validateChangeSet(context(), items(bookPrice("120"))));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ class: "new", scope: "book", newPrice: "120.0000", replacedIds: [], messages: [] });
    expect(r.previewRows.map((p) => [p.storeId, p.oldPrice, p.newPrice, p.newSourceScope, p.devices])).toEqual([
      [S_UTC, null, "120.0000", "book", 2],
      [S_NY, null, "120.0000", "book", 1],
    ]);
    expect(r.previewRows.map((p) => p.rowNo)).toEqual([1, 2]);
    expect(r.previewRows[1]!.effectiveFrom).toBe("2030-12-31T19:00:00-05:00");
    expect(r.summary).toMatchObject({ lines: 1, stores: 2, devices: 3, products: 1, increases: 0, unchanged: 0, blocking: false });
    expect(r.summary.earliestEffectiveAt).toBe("2031-01-01T00:00:00.000Z");
    expect(r.sensitive).toBe(true);
    expect(r.sensitivityReasons).toEqual(["approval_mode_always"]);
  });

  it("replaces: an overlapping active event of the same key and scope; deltaPct and the max increase", () => {
    const old = event({ id: id("f1"), scope: "book", productId: P1, price: "100.0000" });
    const r = ok(validateChangeSet(context({ events: [old] }), items(bookPrice("125.5"))));
    expect(r.lines[0]).toMatchObject({ class: "replaces", replacedIds: [old.id] });
    expect(r.previewRows[0]).toMatchObject({ oldPrice: "100.0000", oldSourceScope: "book", newPrice: "125.5000", deltaPct: "25.50" });
    expect(r.summary).toMatchObject({ increases: 2, decreases: 0, maxIncreasePct: "25.50", maxDecreasePct: null });
    expect(r.summary.findings.replaces).toBe(1);
  });

  it("unchanged: the same price, scope and basis already covering the line is dropped and counted", () => {
    const old = event({ id: id("f1"), scope: "book", productId: P1, price: "100.0000" });
    const r = ok(
      validateChangeSet(
        context({ events: [old] }),
        items(bookPrice("100", "2031-01-01T00:00:00Z", { effectiveTo: "2031-06-01T00:00:00Z" } as Partial<PriceChangeItem>), bookPrice("101", "2031-06-01T00:00:00Z")),
      ),
    );
    expect(r.lines.map((l) => [l.lineNo, l.itemPosition, l.newPrice])).toEqual([[1, 2, "101.0000"]]);
    expect(r.summary.unchanged).toBe(1);
    // An interval the event does not cover is not unchanged.
    const bounded = event({ ...old, effectiveTo: new Date("2032-01-01T00:00:00Z") });
    expect(ok(validateChangeSet(context({ events: [bounded] }), items(bookPrice("100")))).lines[0]!.class).toBe("replaces");
  });

  it("shadowed: a more specific scope already prices a Store, which sees no change", () => {
    const store = event({ id: id("f2"), scope: "store", storeId: S_UTC, productId: P1, price: "90.0000" });
    const r = ok(validateChangeSet(context({ events: [store] }), items(bookPrice("120"))));
    expect(r.lines[0]!.class).toBe("shadowed");
    const utc = r.previewRows.find((p) => p.storeId === S_UTC)!;
    expect(utc).toMatchObject({ oldPrice: "90.0000", newPrice: "90.0000", newSourceScope: "store", class: "shadowed" });
    expect(utc.messages).toContain("shadowed");
    expect(r.previewRows.find((p) => p.storeId === S_NY)!.messages).not.toContain("shadowed");
  });

  it("past_dated: an instant before now blocks a standard set and not an emergency one", () => {
    const r = ok(validateChangeSet(context(), items(bookPrice("120", "2020-01-01T00:00:00Z"))));
    expect(r.lines[0]!.class).toBe("past_dated");
    expect(r.summary.blocking).toBe(true);
    expect(r.sensitivityReasons).toEqual(["approval_mode_always", "past_dated"]);
    const e = ok(validateChangeSet(context({ kind: "emergency" }), items(bookPrice("120", "2020-01-01T00:00:00Z"))));
    expect(e.summary.blocking).toBe(false);
    expect(e.sensitivityReasons).toEqual(["approval_mode_always", "past_dated", "emergency"]);
  });

  it("invalid: price_not_positive, not representable, a retired product, a deleted Store, mixed time basis", () => {
    const zero = ok(validateChangeSet(context(), items(bookPrice("0"))));
    expect(zero.lines[0]).toMatchObject({ class: "invalid", newPrice: null, messages: ["price_not_positive"] });
    expect(zero.previewRows[0]).toMatchObject({ newPrice: null, class: "invalid" });
    expect(zero.summary).toMatchObject({ blocking: true, findings: { invalid: 1 } });

    const odd = ok(validateChangeSet(context(), items(bookPrice("10.005"))));
    expect(odd.lines[0]).toMatchObject({ class: "invalid", newPrice: "10.0050", messages: ["price_not_representable"] });

    const retired = ok(validateChangeSet(context(), items({ ...bookPrice("10"), products: { kind: "items", productIds: [P_RETIRED] } } as PriceChangeItem)));
    expect(retired.lines[0]).toMatchObject({ class: "invalid", messages: ["product_not_live"] });

    const gone = ok(
      validateChangeSet(context(), items({ ...bookPrice("10"), scope: { kind: "stores", storeIds: [S_GONE.toUpperCase()] } } as PriceChangeItem)),
    );
    expect(gone.lines[0]).toMatchObject({ class: "invalid", storeId: S_GONE, messages: ["store_not_live"] });
    expect(gone.previewRows.map((p) => p.storeId)).toEqual([S_GONE]);

    const local = event({
      id: id("f3"), scope: "book", productId: P1, price: "100.0000", timeBasis: "store_local",
      effectiveFrom: null, effectiveFromLocal: new Date("2030-01-01T00:00:00Z"),
    });
    const mixed = ok(validateChangeSet(context({ events: [local] }), items(bookPrice("120"))));
    expect(mixed.lines[0]).toMatchObject({ class: "invalid", messages: ["mixed_time_basis"] });
  });

  it("conflicts_pending: a line of another validated set on the same target and product overlaps", () => {
    const pending: PendingLine = {
      changeSetId: id("aa"), op: "set_price", scope: "book", priceZoneId: null, storeId: null, productId: P1,
      timeBasis: "absolute", effectiveFrom: new Date("2031-06-01T00:00:00Z"), effectiveTo: null,
      effectiveFromLocal: null, effectiveToLocal: null,
    };
    expect(ok(validateChangeSet(context({ pendingLines: [pending] }), items(bookPrice("120")))).lines[0]!.class).toBe("conflicts_pending");
    const other = { ...pending, productId: P2 };
    expect(ok(validateChangeSet(context({ pendingLines: [other] }), items(bookPrice("120")))).lines[0]!.class).toBe("new");
  });

  it("invalidates_dependent: a later published helper event at a more specific scope loses its base (518)", () => {
    const helper = event({ id: id("f4"), scope: "store", storeId: S_UTC, productId: P1, price: "99.0000", effectiveFrom: new Date("2031-06-01T00:00:00Z") });
    const r = ok(validateChangeSet(context({ events: [helper], helperEventIds: new Set([helper.id]) }), items(bookPrice("120"))));
    expect(r.lines[0]!.class).toBe("invalidates_dependent");
    expect(r.previewRows.find((p) => p.storeId === S_UTC)!.messages).toContain("invalidates_dependent");
    // Not a helper event: no finding.
    expect(ok(validateChangeSet(context({ events: [helper] }), items(bookPrice("120")))).lines[0]!.class).toBe("new");
  });

  // PR #746 review: a Zone helper event serves only Stores in its Zone; a base that does not change is no finding.
  it("invalidates_dependent needs the helper to serve the Store and its inherited base to change", () => {
    const north = membership({ id: id("9f"), storeId: S_NY, priceZoneId: ZONE_NORTH, effectiveFrom: new Date("2030-01-01T00:00:00Z") });
    const zoneHelper = event({ id: id("f5"), scope: "zone", priceZoneId: ZONE_NORTH, productId: P1, price: "99.0000", effectiveFrom: new Date("2031-06-01T00:00:00Z") });
    const r = ok(validateChangeSet(context({ events: [zoneHelper], memberships: [north], helperEventIds: new Set([zoneHelper.id]) }), items(bookPrice("120"))));
    expect(r.lines[0]!.class).toBe("invalidates_dependent");
    expect(r.previewRows.find((p) => p.storeId === S_NY)!.messages).toContain("invalidates_dependent");
    expect(r.previewRows.find((p) => p.storeId === S_UTC)!.messages).not.toContain("invalidates_dependent");

    // A Store helper whose base is a Zone price: a Book line does not change that base.
    const zonePrice = event({ id: id("f6"), scope: "zone", priceZoneId: ZONE_NORTH, productId: P1, price: "80.0000" });
    const storeHelper = event({ id: id("f7"), scope: "store", storeId: S_NY, productId: P1, price: "85.0000", effectiveFrom: new Date("2031-06-01T00:00:00Z") });
    const same = ok(
      validateChangeSet(
        context({ events: [zonePrice, storeHelper], memberships: [north], helperEventIds: new Set([storeHelper.id]) }),
        items(bookPrice("120")),
      ),
    );
    // NY's Zone price hides the Book line there (shadowed), and the helper's base stays the Zone price.
    expect(same.lines[0]!.class).toBe("shadowed");
    expect(same.previewRows.some((p) => p.messages.includes("invalidates_dependent"))).toBe(false);
  });

  it("a line takes its most severe class (past_dated over replaces)", () => {
    const old = event({ id: id("f1"), scope: "book", productId: P1, price: "100.0000", effectiveFrom: new Date("2019-01-01T00:00:00Z") });
    const r = ok(validateChangeSet(context({ events: [old] }), items(bookPrice("120", "2020-01-01T00:00:00Z"))));
    expect(r.lines[0]).toMatchObject({ class: "past_dated", replacedIds: [old.id] });
  });
});

describe("validate engine — Store reach (comment 17882, decisions 2 and 3)", () => {
  const zoneLine = (zoneId: string, from = "2031-01-01T00:00:00Z", to?: string): PriceChangeItem =>
    ({
      op: "set_price", scope: { kind: "zone", zoneId }, products: { kind: "items", productIds: [P1] }, price: "50",
      timeBasis: "absolute", effectiveFrom: from, ...(to === undefined ? {} : { effectiveTo: to }),
    }) as PriceChangeItem;

  it("a Zone line reaches members from the later of the line and membership starts; the default Zone holds the rest", () => {
    const m = membership({ id: id("9a"), storeId: S_UTC, priceZoneId: ZONE_NORTH, effectiveFrom: new Date("2031-06-01T00:00:00Z") });
    const north = ok(validateChangeSet(context({ memberships: [m] }), items(zoneLine(ZONE_NORTH))));
    expect(north.previewRows.map((p) => [p.storeId, p.effectiveFrom])).toEqual([[S_UTC, "2031-06-01T00:00:00Z"]]);
    const fallback = ok(validateChangeSet(context({ memberships: [m] }), items(zoneLine(ZONE_DEFAULT))));
    expect(fallback.previewRows.map((p) => [p.storeId, p.effectiveFrom])).toEqual([
      [S_UTC, "2031-01-01T00:00:00Z"],
      [S_NY, "2030-12-31T19:00:00-05:00"],
    ]);
    // After the move the UTC Store is no longer in the default Zone.
    const later = ok(validateChangeSet(context({ memberships: [m] }), items(zoneLine(ZONE_DEFAULT, "2031-07-01T00:00:00Z"))));
    expect(later.previewRows.map((p) => p.storeId)).toEqual([S_NY]);
  });

  it("a membership ended at the head, or not yet visible, does not count (head timeline only)", () => {
    const ended = membership({ id: id("9b"), storeId: S_UTC, priceZoneId: ZONE_NORTH, effectiveFrom: new Date("2030-01-01T00:00:00Z"), endedInRevision: 2 });
    const future = membership({ id: id("9c"), storeId: S_NY, priceZoneId: ZONE_NORTH, effectiveFrom: new Date("2030-01-01T00:00:00Z"), publishedInRevision: 3 });
    const r = validateChangeSet(context({ memberships: [ended, future] }), items(zoneLine(ZONE_NORTH)));
    expect(r).toEqual({ ok: false, code: "change_set_no_target_store", message: "Item 1 reaches no live Store." });
  });

  it("an ambiguous membership makes the line invalid; only that Store's row carries the finding", () => {
    const a = membership({ id: id("9d"), storeId: S_UTC, priceZoneId: ZONE_NORTH, effectiveFrom: new Date("2030-01-01T00:00:00Z") });
    const b = membership({ id: id("9e"), storeId: S_UTC, priceZoneId: ZONE_DEFAULT, effectiveFrom: new Date("2030-06-01T00:00:00Z") });
    const r = ok(validateChangeSet(context({ memberships: [a, b] }), items(zoneLine(ZONE_NORTH))));
    expect(r.lines[0]).toMatchObject({ class: "invalid", messages: ["ambiguous_zone_membership"] });
    const fallback = ok(validateChangeSet(context({ memberships: [a, b] }), items(zoneLine(ZONE_DEFAULT))));
    expect(fallback.lines[0]!.class).toBe("invalid");
    expect(fallback.previewRows.find((p) => p.storeId === S_UTC)!.messages).toEqual(["ambiguous_zone_membership"]);
    expect(fallback.previewRows.find((p) => p.storeId === S_NY)!.messages).toEqual([]);
    expect(fallback.previewRows.every((p) => p.class === "invalid")).toBe(true);
  });

  it("a retired Zone makes a price line invalid (zone_not_live)", () => {
    const m = membership({ id: id("9a"), storeId: S_UTC, priceZoneId: ZONE_NORTH, effectiveFrom: new Date("2030-01-01T00:00:00Z") });
    const r = ok(validateChangeSet(context({ memberships: [m], zones: new Map([[ZONE_DEFAULT, { live: true }], [ZONE_NORTH, { live: false }]]) }), items(zoneLine(ZONE_NORTH))));
    expect(r.lines[0]).toMatchObject({ class: "invalid", messages: ["zone_not_live"] });
  });

  it("a store_local interval inside one DST gap is empty at that Store: invalid there only", () => {
    const gap = { ...bookPrice("1"), timeBasis: "store_local", effectiveFrom: "2031-03-09T02:15", effectiveTo: "2031-03-09T02:45" } as PriceChangeItem;
    const r = ok(validateChangeSet(context(), items(gap)));
    expect(r.lines[0]).toMatchObject({ class: "invalid", messages: ["empty_interval"] });
    expect(r.previewRows.find((p) => p.storeId === S_NY)!.messages).toEqual(["empty_interval"]);
    expect(r.previewRows.find((p) => p.storeId === S_UTC)!.messages).toEqual([]);
  });

  it("a category with no live product refuses the set (it reaches no live Store)", () => {
    const cat = id("cb");
    const r = validateChangeSet(context({ categoryProducts: new Map([[cat, []]]) }), items({ ...bookPrice("5"), products: { kind: "category", categoryId: cat } } as PriceChangeItem));
    expect(r).toEqual({ ok: false, code: "change_set_no_target_store", message: "Item 1 names a category with no live product, so it reaches no live Store." });
  });

  it("422 change_set_no_target_store names the item's position; unknown ids refuse too", () => {
    const bad = validateChangeSet(context(), items(bookPrice("1"), zoneLine(ZONE_NORTH)));
    expect(bad).toMatchObject({ ok: false, code: "change_set_no_target_store" });
    expect((bad as ValidationRefusal).message).toMatch(/^Item 2 /);
    expect(validateChangeSet(context(), items(zoneLine(id("ff"))))).toMatchObject({ ok: false, code: "change_set_no_target_store" });
    expect(validateChangeSet(context(), items({ ...bookPrice("1"), products: { kind: "items", productIds: [id("fe")] } } as PriceChangeItem)))
      .toMatchObject({ ok: false, code: "change_set_no_target_store" });
    expect(validateChangeSet(context({ stores: new Map() }), items(bookPrice("1")))).toMatchObject({ ok: false, code: "change_set_no_target_store" });
  });

  it("store_local lines activate per Store time zone", () => {
    const r = ok(validateChangeSet(context(), items({ ...bookPrice("1"), timeBasis: "store_local", effectiveFrom: "2031-03-09T02:30" } as PriceChangeItem)));
    expect(r.lines[0]).toMatchObject({ timeBasis: "store_local", effectiveFromLocal: "2031-03-09T02:30:00", effectiveFrom: null });
    // The New York gap (2031-03-09 02:30 does not exist) resolves to the transition (Q-2).
    expect(r.previewRows.map((p) => [p.storeId, p.effectiveFrom])).toEqual([
      [S_UTC, "2031-03-09T02:30:00Z"],
      [S_NY, "2031-03-09T03:00:00-04:00"],
    ]);
  });

  it("a category selector freezes its live products; selector ids are matched in any case", () => {
    const cat = id("ca");
    const r = ok(
      validateChangeSet(
        context({ categoryProducts: new Map([[cat, [P1, P2]]]) }),
        items({ ...bookPrice("5"), products: { kind: "category", categoryId: cat.toUpperCase() } } as PriceChangeItem),
      ),
    );
    expect(r.lines.map((l) => l.productId)).toEqual([P1, P2]);
    expect(referencedIds(items({ ...bookPrice("5"), products: { kind: "items", productIds: [P1.toUpperCase()] } } as PriceChangeItem)).productIds).toEqual([P1]);
  });

  it("more than 50 000 lines is change_set_too_large", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `0192f000-0000-7000-8000-${(0x100000 + i).toString(16).padStart(12, "0")}`);
    const products = new Map(many.map((p) => [p, { live: true }]));
    const list = Array.from({ length: Math.ceil(MAX_LINES / 5000) + 1 }, () =>
      ({ ...bookPrice("1"), products: { kind: "items", productIds: many } }) as PriceChangeItem,
    );
    expect(validateChangeSet(context({ products }), items(...list))).toMatchObject({ ok: false, code: "change_set_too_large" });
  });
});

describe("validate engine — review round 1 (lead decisions M1, M2, m2, m3)", () => {
  it("M1: two lines of one set on the same key that overlap are both invalid (overlaps_line_in_set)", () => {
    const cat = id("cc");
    const r = ok(
      validateChangeSet(
        context({ categoryProducts: new Map([[cat, [P1]]]), events: [event({ id: id("f1"), scope: "book", productId: P1, price: "10.0000" })] }),
        items(
          bookPrice("12", "2034-01-01T00:00:00Z"),
          { op: "adjust_percent", scope: { kind: "book" }, products: { kind: "category", categoryId: cat }, percent: "5", timeBasis: "absolute", effectiveFrom: "2034-06-01T00:00:00Z" },
          bookPrice("13", "2031-01-01T00:00:00Z", { effectiveTo: "2032-01-01T00:00:00Z" } as Partial<PriceChangeItem>),
        ),
      ),
    );
    expect(r.lines.map((l) => [l.itemPosition, l.class, l.messages.includes("overlaps_line_in_set")])).toEqual([
      [1, "invalid", true],
      [2, "invalid", true],
      [3, "replaces", false],
    ]);
    expect(r.summary.blocking).toBe(true);
  });

  it("M1: an in-set overlap across time bases is also mixed_time_basis; two overlapping moves of one Store are invalid", () => {
    const r = ok(
      validateChangeSet(context(), items(bookPrice("12", "2034-01-01T00:00:00Z"), { ...bookPrice("13"), timeBasis: "store_local", effectiveFrom: "2035-01-01T00:00" } as PriceChangeItem)),
    );
    expect(r.lines.map((l) => l.messages)).toEqual([
      ["mixed_time_basis", "overlaps_line_in_set"],
      ["mixed_time_basis", "overlaps_line_in_set"],
    ]);
    const move = (from: string): PriceChangeItem => ({ op: "move_store_zone", storeId: S_UTC, zoneId: ZONE_NORTH, effectiveFrom: from });
    const moves = ok(validateChangeSet(context(), items(move("2033-01-01T00:00:00Z"), move("2034-01-01T00:00:00Z"))));
    expect(moves.lines.map((l) => [l.class, l.messages])).toEqual([
      ["invalid", ["overlaps_line_in_set"]],
      ["invalid", ["overlaps_line_in_set"]],
    ]);
    const apart = ok(validateChangeSet(context(), items({ ...move("2033-01-01T00:00:00Z"), effectiveTo: "2034-01-01T00:00:00Z" } as PriceChangeItem, move("2034-01-01T00:00:00Z"))));
    expect(apart.lines.map((l) => l.class)).toEqual(["new", "new"]);
  });

  it("M2: the preview-row budget refuses before any event is read; the line budget before expansion", () => {
    const stores = new Map(
      Array.from({ length: 5 }, (_, i) => {
        const sid = id(`5${i}`);
        return [sid, { id: sid, timezone: "UTC", live: true }] as const;
      }),
    );
    const many = Array.from({ length: 5000 }, (_, i) => `0192f000-0000-7000-8000-${(0x200000 + i).toString(16).padStart(12, "0")}`);
    const products = new Map(many.map((p) => [p, { live: true }]));
    const list = Array.from({ length: 10 }, () => ({ ...bookPrice("1"), products: { kind: "items", productIds: many } }) as PriceChangeItem);
    const refusal = checkBudget(context({ stores, products }), items(...list));
    expect(refusal).toEqual({ ok: false, code: "change_set_too_large", message: `The Change Set materializes more than ${MAX_PREVIEW_ROWS} preview rows (Stores × lines); split it.` });
    expect(checkBudget(context({ stores, products }), items(...list.slice(0, 8)))).toBeNull();
    expect(checkBudget(context({ products }), items(...list, list[0]!))).toMatchObject({ code: "change_set_too_large" });
  });

  it("m2: an end that ends nothing is invalid", () => {
    const end: PriceChangeItem = { op: "end_price", scope: { kind: "book" }, products: { kind: "items", productIds: [P1] }, timeBasis: "absolute", effectiveFrom: "2031-01-01T00:00:00Z" };
    expect(ok(validateChangeSet(context(), items(end))).lines[0]).toMatchObject({ class: "invalid", messages: ["nothing_to_end"] });
  });

  it("m3: a helper resolves its base per Store, at the line start in that Store's zone", () => {
    // The Book price changes at 02:00Z: midnight is 00:00Z in UTC and 05:00Z in New York.
    const early = event({ id: id("f8"), scope: "book", productId: P1, price: "10.0000", effectiveTo: new Date("2031-01-01T02:00:00Z") });
    const late = event({ id: id("f9"), scope: "book", productId: P1, price: "20.0000", effectiveFrom: new Date("2031-01-01T02:00:00Z") });
    const helper: PriceChangeItem = {
      op: "adjust_percent", scope: { kind: "zone", zoneId: ZONE_DEFAULT }, products: { kind: "items", productIds: [P1] }, percent: "10",
      timeBasis: "store_local", effectiveFrom: "2031-01-01T00:00",
    };
    const r = ok(validateChangeSet(context({ events: [early, late] }), items(helper)));
    expect(r.lines[0]).toMatchObject({ class: "new", newPrice: "11.0000" });
    expect(r.previewRows.map((p) => [p.storeId, p.oldPrice, p.newPrice])).toEqual([
      [S_UTC, "10.0000", "11.0000"],
      [S_NY, "20.0000", "22.0000"],
    ]);
  });
});

describe("validate engine — helpers, ends, moves and hashes", () => {
  const old = event({ id: id("f1"), scope: "book", productId: P1, price: "10.0000" });

  it("a helper resolves from the inherited price and rounds half-up (rounded_price)", () => {
    const r = ok(
      validateChangeSet(
        context({ events: [old] }),
        items({ op: "adjust_percent", scope: { kind: "book" }, products: { kind: "items", productIds: [P1] }, percent: "3.33", timeBasis: "absolute", effectiveFrom: "2031-01-01T00:00:00Z" }),
      ),
    );
    expect(r.lines[0]).toMatchObject({ newPrice: "10.3300", roundedFrom: "10.33300000", class: "replaces" });
    expect(r.lines[0]!.messages).toContain("rounded_price");
    expect(r.previewRows[0]).toMatchObject({ newPrice: "10.3300", roundedFrom: "10.33300000", deltaPct: "3.30" });
    const none = ok(
      validateChangeSet(
        context(),
        items({ op: "adjust_amount", scope: { kind: "book" }, products: { kind: "items", productIds: [P1] }, amount: "1", timeBasis: "absolute", effectiveFrom: "2031-01-01T00:00:00Z" }),
      ),
    );
    expect(none.lines[0]).toMatchObject({ class: "invalid", newPrice: null, messages: ["no_base_price"] });
  });

  it("end_price ends the target scope's event; with nothing to end it says so", () => {
    const end: PriceChangeItem = { op: "end_price", scope: { kind: "book" }, products: { kind: "items", productIds: [P1] }, timeBasis: "absolute", effectiveFrom: "2031-01-01T00:00:00Z" };
    const r = ok(validateChangeSet(context({ events: [old] }), items(end)));
    expect(r.lines[0]).toMatchObject({ class: "replaces", newPrice: null, replacedIds: [old.id] });
    expect(r.previewRows[0]).toMatchObject({ oldPrice: "10.0000", newPrice: null });
    expect(ok(validateChangeSet(context(), items(end))).lines[0]!.messages).toEqual(["nothing_to_end"]);
  });

  it("a Zone move records its membership change and supersedes what it overlaps", () => {
    const m = membership({ id: id("9a"), storeId: S_UTC, priceZoneId: ZONE_NORTH, effectiveFrom: new Date("2030-01-01T00:00:00Z") });
    const move: PriceChangeItem = { op: "move_store_zone", storeId: S_UTC, zoneId: ZONE_DEFAULT, effectiveFrom: "2031-01-01T00:00:00Z" };
    const r = ok(validateChangeSet(context({ memberships: [m] }), items(move, bookPrice("1"))));
    expect(r.lines.map((l) => [l.lineNo, l.op, l.class])).toEqual([[1, "move_store_zone", "replaces"], [2, "set_price", "new"]]);
    expect(r.membershipChanges).toEqual([
      { lineNo: 1, storeId: S_UTC, fromZoneId: ZONE_NORTH, toZoneId: ZONE_DEFAULT, effectiveFrom: "2031-01-01T00:00:00Z", effectiveTo: null, supersededMembershipIds: [m.id] },
    ]);
    expect(r.sensitivityReasons).toEqual(["approval_mode_always", "zone_move"]);
    expect(r.previewRows.every((p) => p.lineNo === 2)).toBe(true);
  });

  it("the previewHash is stable for the same inputs and moves with a price or the revision", () => {
    const a = ok(validateChangeSet(context({ events: [old] }), items(bookPrice("12"))));
    const b = ok(validateChangeSet(context({ events: [old] }), items(bookPrice("12.00"))));
    expect(a.previewHash).toBe(b.previewHash);
    expect(a.targetStoreSetHash).toBe(b.targetStoreSetHash);
    expect(ok(validateChangeSet(context({ events: [old] }), items(bookPrice("13")))).previewHash).not.toBe(a.previewHash);
    expect(ok(validateChangeSet(context({ events: [old], headRevision: 3 }), items(bookPrice("12")))).previewHash).not.toBe(a.previewHash);
    // The approver sees each row's device count: it is part of the hash (PR #746 review).
    expect(ok(validateChangeSet(context({ events: [old], devices: new Map([[S_UTC, 5]]) }), items(bookPrice("12")))).previewHash).not.toBe(a.previewHash);
  });
});
