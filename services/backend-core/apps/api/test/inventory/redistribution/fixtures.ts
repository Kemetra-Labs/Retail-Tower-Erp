/**
 * RT-1598 — builders for the W9 redistribution engine and validator specs. No database, no clock.
 */
import { DEFAULT_LIMITS_V1 } from "../../../src/inventory/redistribution/policy";
import type {
  RedistributionMoveV1,
  RedistributionProblemV1,
  RedistributionRowV1,
  RedistributionStoreV1,
} from "../../../src/inventory/redistribution/types";

export const TENANT = "0e170000-0000-4000-8000-00000015980a";
export const OTHER_TENANT = "0e170000-0000-4000-8000-00000015980b";

/** Store ids sort in their numeric order, so "store 1" < "store 2" as strings too. */
export const storeId = (n: number): string => `0e170000-0000-4000-8000-0000159${String(n).padStart(5, "0")}`;
export const productId = (n: number): string => `0e170000-0000-4000-8001-0000159${String(n).padStart(5, "0")}`;

export const S1 = storeId(1);
export const S2 = storeId(2);
export const S3 = storeId(3);
export const S4 = storeId(4);
export const P1 = productId(1);
export const P2 = productId(2);

export function store(id: string, over: Partial<RedistributionStoreV1> = {}): RedistributionStoreV1 {
  return { storeId: id, tenantId: TENANT, readAt: "2026-11-25T10:00:00.000Z", eligibleAsSource: true, ...over };
}

export function row(
  sid: string,
  pid: string,
  ats: string,
  level: string | null,
  over: Partial<RedistributionRowV1> = {},
): RedistributionRowV1 {
  return {
    storeId: sid,
    productId: pid,
    stockingUnit: "each",
    tracked: false,
    availableToSell: ats,
    reorderLevel: level,
    openOutboundDraft: "0.0000",
    openInbound: "0.0000",
    ...over,
  };
}

export function problem(
  stores: ReadonlyArray<RedistributionStoreV1>,
  rows: ReadonlyArray<RedistributionRowV1>,
  over: Partial<RedistributionProblemV1> = {},
): RedistributionProblemV1 {
  return {
    kind: "store_redistribution",
    version: 1,
    tenantId: TENANT,
    computedAt: "2026-11-25T10:00:01.000Z",
    stores,
    rows,
    limits: { ...DEFAULT_LIMITS_V1 },
    ...over,
  };
}

export function move(
  pid: string,
  src: string,
  dst: string,
  quantity: string,
  stockingUnit = "each",
): RedistributionMoveV1 {
  return { productId: pid, sourceStoreId: src, destinationStoreId: dst, quantity, stockingUnit, warnings: [] };
}

/** mulberry32, as in `pricing/resolution/resolve.property.unit.spec.ts`: a seeded, replayable PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;
export const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
export const pick = <T>(rng: Rng, xs: ReadonlyArray<T>): T => xs[int(rng, 0, xs.length - 1)]!;
export const shuffle = <T>(rng: Rng, xs: ReadonlyArray<T>): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rng, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** A decimal string with up to 4 fractional digits; mostly whole units, like real stock. */
export function qty(rng: Rng, lo: number, hi: number): string {
  const whole = int(rng, lo, hi);
  const frac = rng() < 0.8 ? 0 : int(rng, 0, 9999);
  if (whole < 0) return `-${String(-whole)}.${String(frac).padStart(4, "0")}`;
  return `${String(whole)}.${String(frac).padStart(4, "0")}`;
}

export interface SyntheticOptions {
  readonly stores: number;
  readonly products: number;
  /** Share of rows that are present (product sellable at that store). */
  readonly density?: number;
  readonly withEdgeCases?: boolean;
}

/** A seeded synthetic tenant: some stores long, some short, with drafts, inbound, exclusions and edge rows. */
export function syntheticProblem(rng: Rng, o: SyntheticOptions): RedistributionProblemV1 {
  const density = o.density ?? 1;
  const edges = o.withEdgeCases ?? true;
  const stores = Array.from({ length: o.stores }, (_, i) => {
    const excluded = edges && rng() < 0.1;
    return store(storeId(i + 1), {
      eligibleAsSource: !excluded,
      ...(excluded ? { exclusion: pick(rng, ["pos_queue_unknown", "device_heartbeat_stale", "inactive"] as const) } : {}),
    });
  });
  const rows: RedistributionRowV1[] = [];
  for (let p = 1; p <= o.products; p++) {
    const unit = edges && rng() < 0.02 ? "kg" : "each";
    for (const s of stores) {
      if (rng() > density) continue;
      const level = edges && rng() < 0.05 ? null : qty(rng, 0, 40);
      rows.push(
        row(s.storeId, productId(p), qty(rng, edges ? -5 : 0, 120), level, {
          stockingUnit: edges && rng() < 0.02 ? "box" : unit,
          tracked: edges && rng() < 0.03,
          openOutboundDraft: rng() < 0.2 ? qty(rng, 0, 15) : "0.0000",
          openInbound: rng() < 0.2 ? qty(rng, 0, 15) : "0.0000",
        }),
      );
    }
  }
  return problem(stores, rows);
}
