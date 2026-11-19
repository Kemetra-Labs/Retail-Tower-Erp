/**
 * RT-1484 PR-1 (RT-282 PR-08a) — the pure pricing resolver, spec 041 §4.2-4.4:
 * Store > Zone (membership visible at asOfRevision; none = default Zone; more
 * than one = ambiguous_zone_membership) > Book; overlaps are errors; no_price,
 * no_price_book, not_representable; Store-local time. No database.
 */
import { resolve as resolvePath } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";
import { resolvePrice } from "../../../src/pricing/resolution/resolve";
import type { ResolutionData } from "../../../src/pricing/resolution/types";
import {
  BOOK,
  DEFAULT_ZONE,
  OTHER_PRODUCT,
  OTHER_STORE,
  OTHER_TENANT,
  PRODUCT,
  STORE,
  ZONE_A,
  ZONE_B,
  at,
  book,
  bookEvent,
  data,
  event,
  membership,
  store,
  storeEvent,
  wall,
  zoneEvent,
} from "./fixtures";

const NOW = at("2026-06-01T10:00:00Z");
const HEAD = 10;

const resolve = (d: ResolutionData, instant: Date = NOW, asOf: number = HEAD, s = store()) =>
  resolvePrice(PRODUCT, "each", s, instant, asOf, d);

describe("resolvePrice — precedence (spec 041 §4.2 steps 3-5)", () => {
  const b = bookEvent({ id: "00000000-0000-7000-8000-000000000b0b", price: "130.0000" });
  const z = zoneEvent(DEFAULT_ZONE, { id: "00000000-0000-7000-8000-000000000a0e", price: "125.5000" });
  const s = storeEvent({ id: "00000000-0000-7000-8000-0000000005fe", price: "119.9900" });

  it("Book only → the Book price", () => {
    const r = resolve(data({ events: [b] }));
    expect(r).toEqual({
      status: "priced",
      price: "130.0000",
      currencyCode: "EGP",
      taxPriceBasis: "inclusive",
      sellUnit: "each",
      provenance: {
        origin: "pricing",
        sourceScope: "book",
        priceEventId: b.id,
        priceKind: "regular",
        pricingRevision: HEAD,
        priceBookId: BOOK,
        priceZoneId: null,
        effectiveFrom: "2026-01-01T02:00:00+02:00",
        effectiveTo: null,
      },
    });
  });

  it("Zone beats Book; provenance names the Zone", () => {
    const r = resolve(data({ events: [b, z] }));
    expect(r).toMatchObject({ status: "priced", price: "125.5000" });
    expect(r.status === "priced" && r.provenance).toMatchObject({
      sourceScope: "zone",
      priceEventId: z.id,
      priceZoneId: DEFAULT_ZONE,
    });
  });

  it("Store beats Zone and Book", () => {
    const r = resolve(data({ events: [b, z, s] }));
    expect(r).toMatchObject({ status: "priced", price: "119.9900" });
    expect(r.status === "priced" && r.provenance).toMatchObject({
      sourceScope: "store",
      priceEventId: s.id,
      priceZoneId: null,
    });
  });

  it("an expired Store event falls back to the Zone (reset, 491)", () => {
    const ended = storeEvent({ effectiveTo: at("2026-05-01T00:00:00Z") });
    const r = resolve(data({ events: [b, z, ended] }));
    expect(r.status === "priced" && r.provenance.sourceScope).toBe("zone");
  });

  it("ignores another Store's event, another product, another sell unit and another tenant", () => {
    const r = resolve(
      data({
        events: [
          b,
          storeEvent({ storeId: OTHER_STORE, price: "1.0000" }),
          storeEvent({ productId: OTHER_PRODUCT, price: "2.0000" }),
          storeEvent({ sellUnit: "case", price: "3.0000" }),
          storeEvent({ tenantId: OTHER_TENANT, price: "4.0000" }),
          storeEvent({ priceBookId: "00000000-0000-7000-8000-0000000000b2", price: "5.0000" }),
        ],
      }),
    );
    expect(r).toMatchObject({ status: "priced", price: "130.0000" });
  });

  it("ignores a non-regular price kind", () => {
    const r = resolve(data({ events: [b, storeEvent({ priceKind: "clearance", price: "1.0000" })] }));
    expect(r).toMatchObject({ status: "priced", price: "130.0000" });
  });

  it("creation order and revision numbers play no part (499-500)", () => {
    const older = storeEvent({ publishedInRevision: 9, price: "10.0000" });
    const bookNewer = bookEvent({ publishedInRevision: 10, price: "20.0000" });
    expect(resolve(data({ events: [bookNewer, older] }))).toMatchObject({ price: "10.0000" });
  });
});

describe("resolvePrice — intervals", () => {
  it("is [effectiveFrom, effectiveTo): inclusive start, exclusive end", () => {
    const e = bookEvent({ effectiveFrom: at("2026-06-01T00:00:00Z"), effectiveTo: at("2026-07-01T00:00:00Z") });
    const d = data({ events: [e] });
    expect(resolve(d, at("2026-06-01T00:00:00Z")).status).toBe("priced");
    expect(resolve(d, at("2026-06-30T23:59:59.999Z")).status).toBe("priced");
    expect(resolve(d, at("2026-07-01T00:00:00Z"))).toEqual({ status: "unpriced", reason: "no_price" });
    expect(resolve(d, at("2026-05-31T23:59:59.999Z"))).toEqual({ status: "unpriced", reason: "no_price" });
  });

  it("returns the provenance interval in the Store's time zone", () => {
    const e = bookEvent({ effectiveFrom: at("2026-05-31T21:00:00Z"), effectiveTo: at("2026-07-01T21:00:00Z") });
    const r = resolve(data({ events: [e] }));
    expect(r.status === "priced" && r.provenance).toMatchObject({
      effectiveFrom: "2026-06-01T00:00:00+03:00", // Cairo summer time
      effectiveTo: "2026-07-02T00:00:00+03:00",
    });
  });

  it("a future instant uses an already-published scheduled event (512)", () => {
    const now = bookEvent({ price: "100.0000", effectiveTo: at("2026-12-01T00:00:00Z") });
    const later = bookEvent({ price: "90.0000", effectiveFrom: at("2026-12-01T00:00:00Z") });
    const d = data({ events: [now, later] });
    expect(resolve(d)).toMatchObject({ price: "100.0000" });
    expect(resolve(d, at("2027-01-01T00:00:00Z"))).toMatchObject({ price: "90.0000" });
  });
});

describe("resolvePrice — store_local time basis (spec 041 §4.3)", () => {
  const local = (from: string, to: string | null = null) =>
    bookEvent({
      timeBasis: "store_local",
      effectiveFrom: null,
      effectiveTo: null,
      effectiveFromLocal: wall(from),
      effectiveToLocal: to === null ? null : wall(to),
    });

  it("activates at local midnight in each Store's own zone", () => {
    const e = local("2026-11-01T00:00:00");
    const d = data({ events: [e] });
    const cairo = store({ timezone: "Africa/Cairo" }); // UTC+2 in November
    const ny = store({ timezone: "America/New_York" }); // UTC-4 on 2026-11-01 00:00
    expect(resolve(d, at("2026-10-31T21:59:59Z"), HEAD, cairo).status).toBe("unpriced");
    expect(resolve(d, at("2026-10-31T22:00:00Z"), HEAD, cairo).status).toBe("priced");
    expect(resolve(d, at("2026-11-01T03:59:59Z"), HEAD, ny).status).toBe("unpriced");
    expect(resolve(d, at("2026-11-01T04:00:00Z"), HEAD, ny).status).toBe("priced");
    const r = resolve(d, at("2026-11-02T00:00:00Z"), HEAD, cairo);
    expect(r.status === "priced" && r.provenance.effectiveFrom).toBe("2026-11-01T00:00:00+02:00");
  });

  it("a start inside the spring-forward gap activates at the transition", () => {
    const d = data({ events: [local("2026-03-08T02:30:00")] });
    const ny = store({ timezone: "America/New_York" });
    expect(resolve(d, at("2026-03-08T06:59:59.999Z"), HEAD, ny).status).toBe("unpriced");
    expect(resolve(d, at("2026-03-08T07:00:00Z"), HEAD, ny).status).toBe("priced");
  });

  it("a start in the repeated fall-back hour activates at the earlier occurrence", () => {
    const d = data({ events: [local("2026-11-01T01:30:00")] });
    const ny = store({ timezone: "America/New_York" });
    expect(resolve(d, at("2026-11-01T05:29:59Z"), HEAD, ny).status).toBe("unpriced");
    expect(resolve(d, at("2026-11-01T05:30:00Z"), HEAD, ny).status).toBe("priced");
  });

  it("converts the local end too (exclusive)", () => {
    const d = data({ events: [local("2026-06-01T00:00:00", "2026-06-02T00:00:00")] });
    expect(resolve(d, at("2026-06-01T20:59:59Z")).status).toBe("priced");
    expect(resolve(d, at("2026-06-01T21:00:00Z")).status).toBe("unpriced");
  });

  it("an event with no usable start bound never applies", () => {
    const broken = bookEvent({ timeBasis: "store_local", effectiveFrom: null, effectiveFromLocal: null });
    const absoluteBroken = bookEvent({ timeBasis: "absolute", effectiveFrom: null });
    expect(resolve(data({ events: [broken, absoluteBroken] }))).toEqual({ status: "unpriced", reason: "no_price" });
  });
});

describe("resolvePrice — Zone membership (step 4)", () => {
  const zoneA = zoneEvent(ZONE_A, { price: "111.0000" });
  const zoneB = zoneEvent(ZONE_B, { price: "222.0000" });
  const deflt = zoneEvent(DEFAULT_ZONE, { price: "333.0000" });

  it("no membership → the Book's default Zone", () => {
    expect(resolve(data({ events: [zoneA, zoneB, deflt] }))).toMatchObject({ price: "333.0000" });
  });

  it("one membership → that Zone, not the default", () => {
    const r = resolve(data({ events: [zoneA, zoneB, deflt], memberships: [membership(ZONE_A)] }));
    expect(r).toMatchObject({ price: "111.0000" });
    expect(r.status === "priced" && r.provenance.priceZoneId).toBe(ZONE_A);
  });

  it("a membership not covering the instant is a gap → default Zone", () => {
    const m = membership(ZONE_A, { effectiveFrom: at("2026-07-01T00:00:00Z") });
    expect(resolve(data({ events: [zoneA, deflt], memberships: [m] }))).toMatchObject({ price: "333.0000" });
  });

  it("a member Zone with no event falls through to the Book, not to the default Zone", () => {
    const b = bookEvent({ price: "999.0000" });
    const r = resolve(data({ events: [b, deflt], memberships: [membership(ZONE_A)] }));
    expect(r).toMatchObject({ price: "999.0000" });
  });

  it("ignores memberships of another Store, Book or tenant", () => {
    const r = resolve(
      data({
        events: [zoneA, zoneB, deflt],
        memberships: [
          membership(ZONE_A, { storeId: OTHER_STORE }),
          membership(ZONE_B, { priceBookId: "00000000-0000-7000-8000-0000000000b2" }),
          membership(ZONE_A, { tenantId: OTHER_TENANT }),
        ],
      }),
    );
    expect(r).toMatchObject({ price: "333.0000" });
  });

  it("two memberships at the instant → ambiguous_zone_membership with both ids, sorted", () => {
    const m1 = membership(ZONE_B, { id: "00000000-0000-7000-8000-00000000000f" });
    const m2 = membership(ZONE_A, { id: "00000000-0000-7000-8000-00000000000a" });
    expect(resolve(data({ events: [zoneA, zoneB], memberships: [m1, m2] }))).toEqual({
      status: "error",
      reason: "ambiguous_zone_membership",
      membershipIds: [m2.id, m1.id],
    });
  });

  it("a Store-layer price wins before the Zone layer is examined (step order)", () => {
    const m1 = membership(ZONE_A);
    const m2 = membership(ZONE_B);
    const r = resolve(data({ events: [storeEvent({ price: "1.0000" })], memberships: [m1, m2] }));
    expect(r).toMatchObject({ status: "priced", price: "1.0000" });
  });

  it("with no default Zone known and no membership, skips the Zone layer", () => {
    const r = resolve(data({ defaultZoneId: null, events: [deflt, bookEvent({ price: "5.0000" })] }));
    expect(r).toMatchObject({ price: "5.0000" });
  });
});

describe("resolvePrice — as-of-revision visibility (bitemporal, §4.1)", () => {
  it("an event published after asOfRevision is invisible", () => {
    const e = bookEvent({ publishedInRevision: 11 });
    expect(resolve(data({ events: [e] }), NOW, 10)).toEqual({ status: "unpriced", reason: "no_price" });
    expect(resolve(data({ events: [e] }), NOW, 11).status).toBe("priced");
  });

  it("an event ended at or before asOfRevision is invisible; before its end it is visible", () => {
    const old = bookEvent({ price: "100.0000", publishedInRevision: 3, endedInRevision: 7 });
    const replacement = bookEvent({ price: "80.0000", publishedInRevision: 7 });
    const d = data({ events: [old, replacement] });
    expect(resolve(d, NOW, 6)).toMatchObject({ price: "100.0000" });
    expect(resolve(d, NOW, 7)).toMatchObject({ price: "80.0000" });
    expect(resolve(d, NOW, 2)).toEqual({ status: "unpriced", reason: "no_price" });
  });

  it("superseded events that overlapped their replacement are not an overlap at a later revision", () => {
    const old = storeEvent({ publishedInRevision: 3, endedInRevision: 5 });
    const replacement = storeEvent({ publishedInRevision: 5, price: "50.0000" });
    expect(resolve(data({ events: [old, replacement] }), NOW, 5)).toMatchObject({ price: "50.0000" });
  });

  it("reads memberships as known at asOfRevision, not by current state", () => {
    const deflt = zoneEvent(DEFAULT_ZONE, { price: "333.0000" });
    const zoneA = zoneEvent(ZONE_A, { price: "111.0000" });
    const zoneB = zoneEvent(ZONE_B, { price: "222.0000" });
    // Revision 4 put the Store in A; revision 8 moved it to B (ending the A row).
    const inA = membership(ZONE_A, { publishedInRevision: 4, endedInRevision: 8 });
    const inB = membership(ZONE_B, { publishedInRevision: 8 });
    const d = data({ events: [deflt, zoneA, zoneB], memberships: [inA, inB] });
    expect(resolve(d, NOW, 3)).toMatchObject({ price: "333.0000" });
    expect(resolve(d, NOW, 4)).toMatchObject({ price: "111.0000" });
    expect(resolve(d, NOW, 7)).toMatchObject({ price: "111.0000" });
    expect(resolve(d, NOW, 8)).toMatchObject({ price: "222.0000" });
  });

  it("pricingRevision is the revision the resolution was evaluated at", () => {
    const r = resolve(data({ events: [bookEvent({ publishedInRevision: 2 })] }), NOW, 9);
    expect(r.status === "priced" && r.provenance.pricingRevision).toBe(9);
  });
});

describe("resolvePrice — overlaps are errors, never picked (498-500, Q-7)", () => {
  const ids = ["00000000-0000-7000-8000-0000000000f2", "00000000-0000-7000-8000-0000000000f1"] as const;

  it.each([
    ["store", () => [storeEvent({ id: ids[0] }), storeEvent({ id: ids[1] })]],
    ["zone", () => [zoneEvent(DEFAULT_ZONE, { id: ids[0] }), zoneEvent(DEFAULT_ZONE, { id: ids[1] })]],
    ["book", () => [bookEvent({ id: ids[0] }), bookEvent({ id: ids[1] })]],
  ] as const)("two %s-scope events at the instant → overlap_violation with sorted ids", (_scope, events) => {
    expect(resolve(data({ events: events() }))).toEqual({
      status: "error",
      reason: "overlap_violation",
      eventIds: [ids[1], ids[0]],
    });
  });

  it("an overlap in a less specific layer is shadowed by a more specific price", () => {
    const r = resolve(data({ events: [bookEvent(), bookEvent(), storeEvent({ price: "7.0000" })] }));
    expect(r).toMatchObject({ status: "priced", price: "7.0000" });
  });

  it("adjacent intervals are not an overlap", () => {
    const first = bookEvent({ effectiveTo: at("2026-06-01T10:00:00Z"), price: "1.0000" });
    const second = bookEvent({ effectiveFrom: at("2026-06-01T10:00:00Z"), price: "2.0000" });
    expect(resolve(data({ events: [first, second] }))).toMatchObject({ price: "2.0000" });
  });
});

describe("resolvePrice — unpriced outcomes (steps 1, 6, 7)", () => {
  it("no Book → no_price_book", () => {
    expect(resolve(data({ book: null, events: [bookEvent()] }))).toEqual({
      status: "unpriced",
      reason: "no_price_book",
    });
  });

  it("a Book of another tenant is no Book", () => {
    expect(resolve(data({ book: book({ tenantId: OTHER_TENANT }), events: [bookEvent()] }))).toEqual({
      status: "unpriced",
      reason: "no_price_book",
    });
  });

  it("nothing found → no_price", () => {
    expect(resolve(data())).toEqual({ status: "unpriced", reason: "no_price" });
  });

  it.each([
    ["EGP", "125.5050"],
    ["EGP", "0.0010"],
    ["JPY", "100.5000"],
    ["KWD", "1.2345"],
  ])("%s %s is not exact at the minor unit → not_representable", (currencyCode, price) => {
    const r = resolve(data({ book: book({ currencyCode }), events: [bookEvent({ price })] }));
    expect(r).toEqual({ status: "unpriced", reason: "not_representable" });
  });

  it("a currency with no ISO-4217 minor unit is not_representable (fail closed)", () => {
    const r = resolve(data({ book: book({ currencyCode: "XAU" }), events: [bookEvent({ price: "1.0000" })] }));
    expect(r).toEqual({ status: "unpriced", reason: "not_representable" });
  });

  it.each(["", "abc", "-1.0000", "1.00001", "1e3", "12345678901234567.0000", " 1.00"])(
    "a malformed price string %p is not_representable",
    (price) => {
      expect(resolve(data({ events: [bookEvent({ price })] }))).toEqual({
        status: "unpriced",
        reason: "not_representable",
      });
    },
  );

  it.each([
    ["EGP", "125.5", "125.5000"],
    ["EGP", "125.50", "125.5000"],
    ["JPY", "100", "100.0000"],
    ["KWD", "1.234", "1.2340"],
    ["CLF", "1.2345", "1.2345"],
  ])("%s %s is exact and is returned at numeric(19,4) scale", (currencyCode, price, expected) => {
    const r = resolve(data({ book: book({ currencyCode }), events: [bookEvent({ price })] }));
    expect(r).toMatchObject({ status: "priced", price: expected, currencyCode });
  });

  it("a zero price resolves as priced: Q-4's > 0 rule is an authoring check (spec 041 §5)", () => {
    const r = resolve(data({ events: [bookEvent({ price: "0.0000" })] }));
    expect(r).toMatchObject({ status: "priced", price: "0.0000" });
  });

  it("a non-representable Store price does not fall back to the Zone or Book", () => {
    const r = resolve(data({ events: [bookEvent(), storeEvent({ price: "1.0050" })] }));
    expect(r).toEqual({ status: "unpriced", reason: "not_representable" });
  });
});

describe("resolvePrice — the result shape matches price-inquiry.yaml", () => {
  type Schema = { required?: string[]; properties?: Record<string, { enum?: string[] }> };
  const schemas = (): Record<string, Schema> => {
    const dir = resolvePath(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pricing");
    const contract = loadOpenApiContracts({ dir }).find((c) => c.id === "price-inquiry");
    return (contract?.document as { components: { schemas: Record<string, Schema> } }).components.schemas;
  };

  it("PricedResolution and ResolvedPriceProvenance carry exactly the contract's required fields", () => {
    const r = resolve(data({ events: [zoneEvent(DEFAULT_ZONE)] }));
    if (r.status !== "priced") throw new Error("expected priced");
    const s = schemas();
    expect(Object.keys(r).sort()).toEqual([...(s["PricedResolution"]?.required ?? [])].sort());
    expect(Object.keys(r.provenance).sort()).toEqual([...(s["ResolvedPriceProvenance"]?.required ?? [])].sort());
  });

  it("every unpriced and error reason the resolver emits is in the contract enums", () => {
    const s = schemas();
    expect(s["UnpricedResolution"]?.properties?.["reason"]?.enum).toEqual(
      expect.arrayContaining(["no_price", "no_price_book", "not_representable"]),
    );
    expect(s["ErrorResolution"]?.properties?.["reason"]?.enum).toEqual(
      expect.arrayContaining(["overlap_violation", "ambiguous_zone_membership"]),
    );
  });

  it("throws RangeError for a bad Store zone or instant whatever rows are present", () => {
    for (const d of [data(), data({ book: null }), data({ events: [bookEvent()] })]) {
      expect(() => resolve(d, NOW, HEAD, store({ timezone: "Africa/Nowhere" }))).toThrow(RangeError);
      expect(() => resolve(d, NOW, HEAD, store({ timezone: "EET" }))).toThrow(RangeError);
      expect(() => resolve(d, new Date(Number.NaN))).toThrow(RangeError);
    }
  });

  it("does not mutate its inputs", () => {
    const d = data({ events: [bookEvent(), storeEvent()], memberships: [membership(ZONE_A)] });
    const snapshot = JSON.stringify(d);
    resolve(d);
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it("ignores a Store-scope event with the wrong Store even if its tenant matches", () => {
    expect(resolve(data({ events: [event({ scope: "store", storeId: OTHER_STORE })] }))).toEqual({
      status: "unpriced",
      reason: "no_price",
    });
    expect(STORE).not.toBe(OTHER_STORE);
  });
});
