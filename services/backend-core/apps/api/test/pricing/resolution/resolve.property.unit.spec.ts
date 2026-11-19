/**
 * RT-1484 PR-1 (RT-282 PR-08a) — property tests for the pricing resolver and
 * Store-local time. fast-check is not a dependency, so the cases come from a
 * seeded PRNG (mulberry32): every run checks the same cases, and a failure
 * prints its seed and case index so it can be replayed. No database.
 */
import { resolvePrice } from "../../../src/pricing/resolution/resolve";
import { formatInstantInZone, localWallClockToInstant } from "../../../src/pricing/resolution/store-local-time";
import type { PriceResolution, ResolutionData, ResolutionPriceEvent } from "../../../src/pricing/resolution/types";
import {
  DEFAULT_ZONE,
  OTHER_STORE,
  PRODUCT,
  ZONE_A,
  ZONE_B,
  data,
  event,
  id,
  membership,
  store,
} from "./fixtures";

const SEED = 0x1484_0801;
const CASES = 400;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: ReadonlyArray<T>): T => xs[int(rng, 0, xs.length - 1)]!;
const shuffle = <T>(rng: Rng, xs: ReadonlyArray<T>): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rng, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const ZONES = ["UTC", "Africa/Cairo", "America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe"];
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);
/** Day-granular bounds over two years, so DST edges are crossed often. */
const randomInstant = (rng: Rng): Date => new Date(BASE + int(rng, 0, 730) * DAY + int(rng, 0, 47) * 1_800_000);

function randomEvent(rng: Rng): ResolutionPriceEvent {
  const scope = pick(rng, ["book", "zone", "store"] as const);
  const from = randomInstant(rng);
  const to = rng() < 0.4 ? null : new Date(from.getTime() + int(rng, 1, 120) * DAY);
  const local = rng() < 0.4;
  const published = int(rng, 1, 12);
  const ended = rng() < 0.3 ? published + int(rng, 1, 5) : null;
  const toWall = (d: Date | null) => (d === null ? null : new Date(d.getTime()));
  return event({
    id: id("e", int(rng, 1, 1_000_000_000)),
    scope,
    priceZoneId: scope === "zone" ? pick(rng, [ZONE_A, ZONE_B, DEFAULT_ZONE]) : null,
    storeId: scope === "store" ? pick(rng, [store().id, OTHER_STORE]) : null,
    price: `${int(rng, 0, 99999)}.${pick(rng, ["0000", "5000", "9900", "0050"])}`,
    timeBasis: local ? "store_local" : "absolute",
    effectiveFrom: local ? null : from,
    effectiveTo: local ? null : to,
    effectiveFromLocal: local ? toWall(from) : null,
    effectiveToLocal: local ? toWall(to) : null,
    publishedInRevision: published,
    endedInRevision: ended,
  });
}

function randomData(rng: Rng): ResolutionData {
  const events = Array.from({ length: int(rng, 0, 8) }, () => randomEvent(rng));
  const memberships = Array.from({ length: int(rng, 0, 2) }, () => {
    const from = randomInstant(rng);
    const published = int(rng, 1, 12);
    return membership(pick(rng, [ZONE_A, ZONE_B]), {
      id: id("m", int(rng, 1, 1_000_000_000)),
      storeId: rng() < 0.85 ? store().id : OTHER_STORE,
      effectiveFrom: from,
      effectiveTo: rng() < 0.5 ? null : new Date(from.getTime() + int(rng, 1, 200) * DAY),
      publishedInRevision: published,
      endedInRevision: rng() < 0.3 ? published + int(rng, 1, 5) : null,
    });
  });
  return data({ events, memberships });
}

interface Case {
  readonly d: ResolutionData;
  readonly s: ReturnType<typeof store>;
  readonly instant: Date;
  readonly asOf: number;
}

function forEachCase(seed: number, check: (c: Case, rng: Rng) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < CASES; i++) {
    const c: Case = {
      d: randomData(rng),
      s: store({ timezone: pick(rng, ZONES) }),
      instant: randomInstant(rng),
      asOf: int(rng, 0, 14),
    };
    try {
      check(c, rng);
    } catch (err) {
      throw new Error(`seed ${seed} case ${i}: ${(err as Error).message}`);
    }
  }
}

const run = (c: Case, d: ResolutionData = c.d): PriceResolution =>
  resolvePrice(PRODUCT, "each", c.s, c.instant, c.asOf, d);

describe("resolvePrice properties", () => {
  it("is deterministic: the same inputs in any row order give the same result", () => {
    forEachCase(SEED, (c, rng) => {
      const first = run(c);
      expect(run(c)).toEqual(first);
      const shuffled = { ...c.d, events: shuffle(rng, c.d.events), memberships: shuffle(rng, c.d.memberships) };
      expect(run(c, shuffled)).toEqual(first);
    });
  });

  it("rows published after asOfRevision, or ended at or before it, change nothing", () => {
    forEachCase(SEED + 1, (c) => {
      const visible = <T extends { publishedInRevision: number; endedInRevision: number | null }>(r: T) =>
        r.publishedInRevision <= c.asOf && (r.endedInRevision === null || r.endedInRevision > c.asOf);
      const pruned = { ...c.d, events: c.d.events.filter(visible), memberships: c.d.memberships.filter(visible) };
      expect(run(c, pruned)).toEqual(run(c));
    });
  });

  it("a priced result's provenance names a visible event of that scope whose interval contains the instant", () => {
    forEachCase(SEED + 2, (c) => {
      const r = run(c);
      if (r.status !== "priced") return;
      const e = c.d.events.find((x) => x.id === r.provenance.priceEventId)!;
      expect(e.scope).toBe(r.provenance.sourceScope);
      expect(e.publishedInRevision).toBeLessThanOrEqual(c.asOf);
      expect(e.endedInRevision === null || e.endedInRevision > c.asOf).toBe(true);
      const from = Date.parse(r.provenance.effectiveFrom);
      const to = r.provenance.effectiveTo === null ? Infinity : Date.parse(r.provenance.effectiveTo);
      expect(from).toBeLessThanOrEqual(c.instant.getTime());
      expect(c.instant.getTime()).toBeLessThan(to);
      expect(r.provenance.pricingRevision).toBe(c.asOf);
    });
  });

  it("adding a Book-scope event never changes a Store- or Zone-scope result (precedence by scope alone)", () => {
    forEachCase(SEED + 3, (c, rng) => {
      const before = run(c);
      if (before.status !== "priced" || before.provenance.sourceScope === "book") return;
      const extra = event({
        id: id("e", int(rng, 1, 1_000_000_000)),
        scope: "book",
        effectiveFrom: new Date(c.instant.getTime() - DAY),
        publishedInRevision: Math.max(1, c.asOf),
      });
      expect(run(c, { ...c.d, events: [...c.d.events, extra] })).toEqual(before);
    });
  });

  it("a Store event covering the instant always wins over Book prices", () => {
    forEachCase(SEED + 4, (c, rng) => {
      const asOf = Math.max(1, c.asOf);
      const storeLevel = event({
        id: id("e", int(rng, 1, 1_000_000_000)),
        scope: "store",
        storeId: c.s.id,
        price: "1.0000",
        effectiveFrom: new Date(c.instant.getTime() - DAY),
        publishedInRevision: asOf,
      });
      const bookOnly = { ...c.d, events: [...c.d.events.filter((e) => e.scope === "book"), storeLevel] };
      expect(run({ ...c, asOf }, bookOnly)).toMatchObject({
        status: "priced",
        price: "1.0000",
        provenance: { sourceScope: "store", priceEventId: storeLevel.id },
      });
    });
  });

  it("a default-Zone event covering the instant always wins over Book prices (no membership)", () => {
    forEachCase(SEED + 8, (c, rng) => {
      const asOf = Math.max(1, c.asOf);
      const zoneLevel = event({
        id: id("e", int(rng, 1, 1_000_000_000)),
        scope: "zone",
        priceZoneId: DEFAULT_ZONE,
        price: "2.0000",
        effectiveFrom: new Date(c.instant.getTime() - DAY),
        publishedInRevision: asOf,
      });
      const bookOnly = {
        ...c.d,
        memberships: [],
        events: [...c.d.events.filter((e) => e.scope === "book"), zoneLevel],
      };
      expect(run({ ...c, asOf }, bookOnly)).toMatchObject({
        status: "priced",
        price: "2.0000",
        provenance: { sourceScope: "zone", priceEventId: zoneLevel.id, priceZoneId: DEFAULT_ZONE },
      });
    });
  });

  it("error results list at least two ids, sorted and unique", () => {
    forEachCase(SEED + 5, (c) => {
      const r = run(c);
      if (r.status !== "error") return;
      const ids = r.reason === "overlap_violation" ? r.eventIds : r.membershipIds;
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect([...ids].sort()).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});

describe("store-local time properties", () => {
  /** The wall-clock fields of `instant` in `zone`, in Drizzle's UTC-fields convention. */
  const wallOf = (instant: Date, zone: string): Date => {
    const printed = formatInstantInZone(instant, zone);
    return new Date(`${printed.slice(0, 19)}Z`);
  };

  /** The offset suffix of an RFC 3339 string printed by formatInstantInZone. */
  const offsetOf = (printed: string): string => printed.slice(19);
  /** Start (UTC midnight) of each day in 2026-2027 on which `zone` changes offset. */
  const transitionDays = (zone: string): number[] => {
    const days: number[] = [];
    for (let d = 0; d <= 730; d++) {
      const start = BASE + d * DAY;
      if (offsetOf(formatInstantInZone(new Date(start), zone)) !== offsetOf(formatInstantInZone(new Date(start + DAY), zone))) {
        days.push(start);
      }
    }
    return days;
  };
  const DST_ZONES = ZONES.filter((z) => z !== "UTC" && z !== "Asia/Kolkata");
  const TRANSITIONS = new Map(DST_ZONES.map((z) => [z, transitionDays(z)] as const));
  /** Half the cases fall on a DST transition day, so gaps and repeats are exercised. */
  const quarterHour = (rng: Rng, zone: string): number => {
    const days = TRANSITIONS.get(zone) ?? [];
    const day = days.length > 0 && rng() < 0.5 ? pick(rng, days) : BASE + int(rng, 0, 730) * DAY;
    return day + int(rng, -8, 4 * 24 + 8) * 900_000;
  };

  it("finds the DST transitions it relies on", () => {
    for (const zone of DST_ZONES) expect(TRANSITIONS.get(zone)?.length).toBe(4);
  });

  it("converting an instant's own local time gives that instant, or the earlier occurrence of a repeated time", () => {
    const rng = mulberry32(SEED + 6);
    for (let i = 0; i < CASES; i++) {
      const zone = pick(rng, DST_ZONES);
      const t = new Date(quarterHour(rng, zone));
      const back = localWallClockToInstant(wallOf(t, zone), zone);
      expect(back.getTime()).toBeLessThanOrEqual(t.getTime());
      expect(wallOf(back, zone).getTime()).toBe(wallOf(t, zone).getTime());
      if (back.getTime() !== t.getTime()) {
        // A repeat: t must be within one DST shift (at most 1 h; Lord Howe 30 min) of the earlier occurrence.
        expect(t.getTime() - back.getTime()).toBeLessThanOrEqual(3_600_000);
      }
    }
  });

  it("any local time maps to an instant whose local time is the same, or the first instant after a gap", () => {
    const rng = mulberry32(SEED + 7);
    for (let i = 0; i < CASES; i++) {
      const zone = pick(rng, DST_ZONES);
      const local = new Date(quarterHour(rng, zone));
      const t = localWallClockToInstant(local, zone);
      const seen = wallOf(t, zone).getTime();
      if (seen !== local.getTime()) {
        // A gap: the result is the transition. Its local time is after the requested one,
        // and one second earlier the local time is before it.
        expect(seen).toBeGreaterThan(local.getTime());
        const justBefore = new Date(t.getTime() - 1000);
        expect(wallOf(justBefore, zone).getTime()).toBeLessThan(local.getTime());
      }
    }
  });
});
