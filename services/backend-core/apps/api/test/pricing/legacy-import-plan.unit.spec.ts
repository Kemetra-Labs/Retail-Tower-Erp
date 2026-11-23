/**
 * RT-1485 PR-16a-2a — the pure legacy import planner (spec 044 §4.1, §4.2, §4.4, MC-1, MC-2, MC-10).
 */
import { earliestEffectiveAt, planLegacyImport, type ImportInputs, type LegacyPrices, type PlannedEvent } from "../../src/pricing/legacy-import/legacy-import-plan";
import { instantToWallClock } from "../../src/pricing/resolution/store-local-time";

const P1 = "0a000000-0000-7000-8000-000000000a01";
const P2 = "0a000000-0000-7000-8000-000000000a02";
const P3 = "0a000000-0000-7000-8000-000000000a03";
const S_CAIRO = "0a000000-0000-7000-8000-000000000501";
const S_NY = "0a000000-0000-7000-8000-000000000502";
const S_LONDON = "0a000000-0000-7000-8000-000000000503";

const T = new Date("2026-11-23T10:15:30.000Z");
const EGP: ImportInputs = { currencyCode: "EGP", taxPriceBasis: "inclusive", referenceZone: null };

const legacy = (over: Partial<LegacyPrices> = {}): LegacyPrices => ({ book: [], store: [], ...over });
const wall = (iso: string): string => new Date(iso).toISOString();

describe("planLegacyImport — mapping (§4.2)", () => {
  it("maps a priced tenant product to a book event and a priced override to a store event, normalised to numeric(19,4)", () => {
    const plan = planLegacyImport(
      legacy({
        book: [{ productId: P1, price: "12.5", currencyCode: "EGP" }],
        store: [{ storeId: S_CAIRO, productId: P1, price: "11.00", currencyCode: "EGP" }],
      }),
      EGP,
      [{ id: S_CAIRO, timezone: "Africa/Cairo" }],
      T,
    );
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.events).toEqual([
      { scope: "book", storeId: null, productId: P1, price: "12.5000", fromLocal: instantToWallClock(T, "Africa/Cairo") },
      { scope: "store", storeId: S_CAIRO, productId: P1, price: "11.0000", fromLocal: instantToWallClock(T, "Africa/Cairo") },
    ]);
    expect(plan.exceptions).toEqual([]);
    expect(plan.currencyCode).toBe("EGP");
    expect(plan.bookZone).toBe("Africa/Cairo");
  });

  it("Cairo wall clock of T is T + 2h (winter)", () => {
    expect(instantToWallClock(T, "Africa/Cairo").toISOString()).toBe(wall("2026-11-23T12:15:30.000Z"));
  });

  it("a tenant with no priced rows plans no events but still succeeds (the Book comes from the declared currency)", () => {
    const plan = planLegacyImport(legacy(), EGP, [{ id: S_CAIRO, timezone: "Africa/Cairo" }], T);
    expect(plan).toEqual({ kind: "ok", events: [], exceptions: [], currencyCode: "EGP", bookZone: "Africa/Cairo" });
  });
});

describe("planLegacyImport — exceptions (§4.4, MC-2)", () => {
  it("does not import zero or sub-minor prices and reports each with its class", () => {
    const plan = planLegacyImport(
      legacy({
        book: [
          { productId: P1, price: "0.0000", currencyCode: "EGP" },
          { productId: P2, price: "12.345", currencyCode: "EGP" },
          { productId: P3, price: "12.3400", currencyCode: "EGP" },
        ],
        store: [
          { storeId: S_CAIRO, productId: P1, price: "0", currencyCode: "EGP" },
          { storeId: S_CAIRO, productId: P2, price: "0.0001", currencyCode: "EGP" },
        ],
      }),
      EGP,
      [{ id: S_CAIRO, timezone: "Africa/Cairo" }],
      T,
    );
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.events.map((e) => [e.scope, e.productId, e.price])).toEqual([["book", P3, "12.3400"]]);
    expect(plan.exceptions).toEqual([
      { cls: "zero_price", scope: "book", storeId: null, productId: P1 },
      { cls: "not_representable", scope: "book", storeId: null, productId: P2 },
      { cls: "zero_price", scope: "store", storeId: S_CAIRO, productId: P1 },
      { cls: "not_representable", scope: "store", storeId: S_CAIRO, productId: P2 },
    ]);
  });

  it("refuses the whole tenant when the legacy rows hold more than one currency", () => {
    const plan = planLegacyImport(
      legacy({
        book: [{ productId: P1, price: "1.00", currencyCode: "EGP" }],
        store: [{ storeId: S_CAIRO, productId: P1, price: "1.00", currencyCode: "USD" }],
      }),
      EGP,
      [{ id: S_CAIRO, timezone: "Africa/Cairo" }],
      T,
    );
    expect(plan).toEqual({ kind: "refused", reason: "multi_currency_tenant", currencies: ["EGP", "USD"] });
  });

  it("refuses when the declared Book currency differs from the single legacy currency (MC-10)", () => {
    const plan = planLegacyImport(legacy({ book: [{ productId: P1, price: "1.00", currencyCode: "USD" }] }), EGP, [], T);
    expect(plan).toEqual({ kind: "refused", reason: "currency_mismatch", currencies: ["USD"] });
  });
});

describe("planLegacyImport — bounds (MC-1)", () => {
  it("book events start at T in the westernmost Store zone (smallest offset), store events in their own zone", () => {
    const plan = planLegacyImport(
      legacy({
        book: [{ productId: P1, price: "5.00", currencyCode: "EGP" }],
        store: [
          { storeId: S_CAIRO, productId: P1, price: "4.00", currencyCode: "EGP" },
          { storeId: S_NY, productId: P1, price: "6.00", currencyCode: "EGP" },
        ],
      }),
      EGP,
      [
        { id: S_CAIRO, timezone: "Africa/Cairo" },
        { id: S_LONDON, timezone: "Europe/London" },
        { id: S_NY, timezone: "America/New_York" },
      ],
      T,
    );
    if (plan.kind !== "ok") throw new Error("expected ok");
    const [book, cairo, ny] = plan.events;
    expect(book!.fromLocal.toISOString()).toBe(wall("2026-11-23T05:15:30.000Z")); // New York, UTC-5
    expect(cairo!.fromLocal.toISOString()).toBe(wall("2026-11-23T12:15:30.000Z"));
    expect(ny!.fromLocal.toISOString()).toBe(wall("2026-11-23T05:15:30.000Z"));
  });

  it("a tenant with no Stores uses the declared reference zone for book events", () => {
    const plan = planLegacyImport(
      legacy({ book: [{ productId: P1, price: "5.00", currencyCode: "EGP" }] }),
      { ...EGP, referenceZone: "Europe/London" },
      [],
      T,
    );
    if (plan.kind !== "ok") throw new Error("expected ok");
    expect(plan.events[0]!.fromLocal.toISOString()).toBe(wall("2026-11-23T10:15:30.000Z"));
  });

  it("refuses a tenant with no Stores and no reference zone", () => {
    expect(planLegacyImport(legacy(), EGP, [], T)).toEqual({ kind: "refused", reason: "reference_zone_required", currencies: [] });
  });

  it("an import instant in the repeated fall-back hour still starts the event at or before T (Q-2 earlier occurrence)", () => {
    // 2026-11-01 06:30Z is 01:30 EST, the second occurrence of 01:30 in New York.
    const at = new Date("2026-11-01T06:30:00.000Z");
    const plan = planLegacyImport(
      legacy({ store: [{ storeId: S_NY, productId: P1, price: "6.00", currencyCode: "EGP" }] }),
      EGP,
      [{ id: S_NY, timezone: "America/New_York" }],
      at,
    );
    if (plan.kind !== "ok") throw new Error("expected ok");
    expect(plan.events[0]!.fromLocal.toISOString()).toBe(wall("2026-11-01T01:30:00.000Z"));
  });
});

describe("earliestEffectiveAt", () => {
  it("is the earliest start minus 14 hours, and handles far more events than a call can take as arguments", () => {
    const base = Date.UTC(2026, 10, 23, 12, 0, 0);
    const events: PlannedEvent[] = Array.from({ length: 200_000 }, (_, i) => ({
      scope: "store",
      storeId: S_CAIRO,
      productId: P1,
      price: "1.0000",
      fromLocal: new Date(base + (i === 123_456 ? -60_000 : i)),
    }));
    expect(earliestEffectiveAt(events).toISOString()).toBe(new Date(base - 60_000 - 14 * 3_600_000).toISOString());
  });

  it("refuses an empty event list", () => {
    expect(() => earliestEffectiveAt([])).toThrow("no event");
  });
});

describe("instantToWallClock", () => {
  it("rejects an unknown zone", () => {
    expect(() => instantToWallClock(T, "Mars/Olympus")).toThrow(RangeError);
  });
});
