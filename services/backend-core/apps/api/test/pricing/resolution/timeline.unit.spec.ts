/**
 * RT-1484 PR-3 (RT-282 PR-08b) — the pure layer trace, timeline and next change built on the
 * resolver (spec 041 §4, §8; price-inquiry.yaml `PriceTimeline`, `PriceExplanation`). No database.
 */
import { resolvePrice, traceResolution } from "../../../src/pricing/resolution/resolve";
import { nextChange, resolveTimeline } from "../../../src/pricing/resolution/timeline";
import type { ResolutionData } from "../../../src/pricing/resolution/types";
import {
  DEFAULT_ZONE,
  PRODUCT,
  ZONE_A,
  at,
  bookEvent,
  data,
  membership,
  store,
  storeEvent,
  wall,
  zoneEvent,
} from "./fixtures";

const HEAD = 10;
const ms = (iso: string): number => at(iso).getTime();

const timeline = (d: ResolutionData, from: string, to: string, asOf = HEAD, s = store()) =>
  resolveTimeline(PRODUCT, "each", s, ms(from), ms(to), asOf, d).map((seg) => ({
    from: new Date(seg.fromMs).toISOString(),
    to: new Date(seg.toMs).toISOString(),
    status: seg.result.status,
    price: seg.result.status === "priced" ? seg.result.price : null,
  }));

describe("traceResolution — every layer is evaluated (spec 041 §8)", () => {
  const b = bookEvent({ price: "130.0000" });
  const z = zoneEvent(ZONE_A, { price: "125.5000" });
  const s = storeEvent({ price: "119.9900" });
  const m = membership(ZONE_A);

  it("reports the selected Store event and the Zone and Book events it shadows", () => {
    const t = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, data({ events: [b, z, s], memberships: [m] }));
    expect(t.result).toEqual(resolvePrice(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, data({ events: [b, z, s], memberships: [m] })));
    expect(t.store).toMatchObject({ kind: "one", candidate: { event: { id: s.id } } });
    expect(t.zone).toMatchObject({ membership: "explicit", zoneId: ZONE_A, membershipIds: [m.id], layer: { kind: "one" } });
    expect(t.book).toMatchObject({ kind: "one", candidate: { event: { id: b.id } } });
  });

  it("falls back to the default Zone with no membership, and reports an ambiguous one", () => {
    const none = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, data({ events: [b] }));
    expect(none.zone).toMatchObject({ membership: "default", zoneId: DEFAULT_ZONE, membershipIds: [], layer: { kind: "none" } });
    const twice = traceResolution(
      PRODUCT,
      "each",
      store(),
      at("2026-06-01T00:00:00Z"),
      HEAD,
      data({ events: [b, s], memberships: [membership(ZONE_A), membership(DEFAULT_ZONE)] }),
    );
    expect(twice.zone).toMatchObject({ membership: "ambiguous", zoneId: null });
    expect(twice.result.status).toBe("priced");
  });

  it("reports an overlap per layer without picking one", () => {
    const b2 = bookEvent({ price: "140.0000" });
    const t = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, data({ events: [b, b2, s] }));
    expect(t.book).toMatchObject({ kind: "overlap" });
    expect(t.result.status).toBe("priced");
  });

  it("has no layers without a Book", () => {
    const t = traceResolution(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, data({ book: null }));
    expect(t.result).toEqual({ status: "unpriced", reason: "no_price_book" });
    expect(t.bookRow).toBeNull();
  });
});

describe("resolveTimeline — contiguous segments over [from, to) (decision 511)", () => {
  it("covers the window exactly, with unpriced gaps and merged equal neighbours", () => {
    const d = data({
      events: [
        bookEvent({ price: "100.0000", effectiveFrom: at("2026-03-01T00:00:00Z"), effectiveTo: at("2026-04-01T00:00:00Z") }),
        storeEvent({ price: "90.0000", effectiveFrom: at("2026-03-10T00:00:00Z"), effectiveTo: at("2026-03-20T00:00:00Z") }),
        // An event of another product adds no boundary.
        bookEvent({ productId: "00000000-0000-7000-8000-0000000000e9", effectiveFrom: at("2026-03-15T00:00:00Z") }),
      ],
    });
    expect(timeline(d, "2026-02-01T00:00:00Z", "2026-05-01T00:00:00Z")).toEqual([
      { from: "2026-02-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z", status: "unpriced", price: null },
      { from: "2026-03-01T00:00:00.000Z", to: "2026-03-10T00:00:00.000Z", status: "priced", price: "100.0000" },
      { from: "2026-03-10T00:00:00.000Z", to: "2026-03-20T00:00:00.000Z", status: "priced", price: "90.0000" },
      { from: "2026-03-20T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z", status: "priced", price: "100.0000" },
      { from: "2026-04-01T00:00:00.000Z", to: "2026-05-01T00:00:00.000Z", status: "unpriced", price: null },
    ]);
  });

  it("is one segment when nothing changes inside the window", () => {
    const d = data({ events: [bookEvent({ effectiveFrom: at("2026-01-01T00:00:00Z") })] });
    expect(timeline(d, "2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z")).toHaveLength(1);
  });

  it("merges two adjacent events of the same price only when the resolution is identical", () => {
    // A zone membership change that keeps the Book price is not a change of resolution.
    const d = data({
      events: [bookEvent({ price: "100.0000", effectiveFrom: at("2026-01-01T00:00:00Z") })],
      memberships: [membership(ZONE_A, { effectiveFrom: at("2026-03-01T00:00:00Z") })],
    });
    expect(timeline(d, "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z")).toHaveLength(1);
  });

  it("splits at a Zone move that changes the price", () => {
    const d = data({
      events: [bookEvent({ price: "100.0000" }), zoneEvent(ZONE_A, { price: "80.0000" })],
      memberships: [membership(ZONE_A, { effectiveFrom: at("2026-03-01T00:00:00Z") })],
    });
    expect(timeline(d, "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z").map((s) => s.price)).toEqual(["100.0000", "80.0000"]);
  });

  it("reads the timeline as known at asOfRevision", () => {
    const d = data({
      events: [
        bookEvent({ price: "100.0000", publishedInRevision: 1, endedInRevision: 2, effectiveTo: null }),
        bookEvent({ price: "100.0000", publishedInRevision: 2, effectiveTo: at("2026-03-01T00:00:00Z") }),
        bookEvent({ price: "120.0000", publishedInRevision: 2, effectiveFrom: at("2026-03-01T00:00:00Z") }),
      ],
    });
    expect(timeline(d, "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z", 1).map((s) => s.price)).toEqual(["100.0000"]);
    expect(timeline(d, "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z", 2).map((s) => s.price)).toEqual(["100.0000", "120.0000"]);
  });

  it("puts a store_local boundary at the Store-local instant (DST gap → the transition)", () => {
    const ny = store({ timezone: "America/New_York" });
    const d = data({
      events: [
        bookEvent({ price: "100.0000" }),
        storeEvent({ price: "90.0000", timeBasis: "store_local", effectiveFrom: null, effectiveFromLocal: wall("2026-03-08T02:30:00") }),
      ],
    });
    expect(timeline(d, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z", HEAD, ny)).toEqual([
      { from: "2026-03-08T00:00:00.000Z", to: "2026-03-08T07:00:00.000Z", status: "priced", price: "100.0000" },
      { from: "2026-03-08T07:00:00.000Z", to: "2026-03-09T00:00:00.000Z", status: "priced", price: "90.0000" },
    ]);
  });

  it("refuses an empty or reversed window", () => {
    expect(() => resolveTimeline(PRODUCT, "each", store(), 10, 10, HEAD, data())).toThrow(RangeError);
  });
});

describe("nextChange — the next published change after an instant (decisions 502-505)", () => {
  it("returns the first boundary whose resolution differs, skipping no-op boundaries", () => {
    const d = data({
      events: [
        bookEvent({ price: "100.0000" }),
        storeEvent({ price: "90.0000", effectiveFrom: at("2026-07-01T00:00:00Z") }),
      ],
      memberships: [membership(ZONE_A, { effectiveFrom: at("2026-06-15T00:00:00Z") })],
    });
    const n = nextChange(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, d);
    expect(n?.at.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(n?.result).toMatchObject({ status: "priced", price: "90.0000" });
  });

  it("is null when nothing later is published", () => {
    expect(nextChange(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, data({ events: [bookEvent()] }))).toBeNull();
  });

  it("reports the end of a price as a change to unpriced", () => {
    const d = data({ events: [bookEvent({ effectiveTo: at("2026-08-01T00:00:00Z") })] });
    expect(nextChange(PRODUCT, "each", store(), at("2026-06-01T00:00:00Z"), HEAD, d)).toEqual({
      at: at("2026-08-01T00:00:00Z"),
      result: { status: "unpriced", reason: "no_price" },
    });
  });
});
