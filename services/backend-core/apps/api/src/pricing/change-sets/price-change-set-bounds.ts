/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — a Change Set line's bounds and the interval arithmetic
 * `validate` needs (spec 041 §4.3, Q-1, Q-2). Pure. A line's bounds are kept in the price-event
 * shape, so the resolver's `eventInterval` converts them per Store time zone exactly as it converts
 * a published event.
 */
import { eventInterval, type Interval } from "../resolution/resolve";
import type { ResolutionPriceEvent } from "../resolution/types";
import type { MaterializedLine } from "./price-change-set-validation.types";
import type { PriceChangeItem } from "./price-change-sets.dto";

export type PricedItem = Exclude<PriceChangeItem, { op: "move_store_zone" }>;

/** A line's bounds in the event shape. */
export type Bounds = Pick<ResolutionPriceEvent, "timeBasis" | "effectiveFrom" | "effectiveTo" | "effectiveFromLocal" | "effectiveToLocal">;
type BoundsText = Pick<MaterializedLine, "timeBasis" | "effectiveFrom" | "effectiveTo" | "effectiveFromLocal" | "effectiveToLocal">;

/** `2026-11-01T00:00` → `2026-11-01T00:00:00` (seconds always present). */
const withSeconds = (v: string): string => (v.length === 16 ? `${v}:00` : v);
/** A wall-clock value in the resolver's convention (a Date whose UTC fields are local). */
const wallClock = (v: string): Date => new Date(`${withSeconds(v)}Z`);

/** The item's bounds (for interval arithmetic) and their stored text (for the line row). */
export function boundsOf(item: PricedItem): { readonly bounds: Bounds; readonly text: BoundsText } {
  const basis = item.timeBasis ?? "store_local";
  const to = "effectiveTo" in item ? (item.effectiveTo ?? null) : null;
  if (basis === "absolute") {
    return {
      bounds: { timeBasis: basis, effectiveFrom: new Date(item.effectiveFrom), effectiveTo: to === null ? null : new Date(to), effectiveFromLocal: null, effectiveToLocal: null },
      text: { timeBasis: basis, effectiveFrom: item.effectiveFrom, effectiveTo: to, effectiveFromLocal: null, effectiveToLocal: null },
    };
  }
  return {
    bounds: { timeBasis: basis, effectiveFrom: null, effectiveTo: null, effectiveFromLocal: wallClock(item.effectiveFrom), effectiveToLocal: to === null ? null : wallClock(to) },
    text: { timeBasis: basis, effectiveFrom: null, effectiveTo: null, effectiveFromLocal: withSeconds(item.effectiveFrom), effectiveToLocal: to === null ? null : withSeconds(to) },
  };
}

/** Bounds (or a pending line) as instants in `zone`; null when they have no usable start. */
export const intervalIn = (b: Bounds, zone: string): Interval | null => eventInterval(b as ResolutionPriceEvent, zone);

/** Whether `outer` covers `inner` (both raw: same time basis). */
export function covers(outer: Interval, inner: Interval): boolean {
  return outer.from <= inner.from && (outer.to === null || (inner.to !== null && outer.to >= inner.to));
}

/** The raw interval of same-basis bounds (absolute ms, or wall-clock ms for store_local). */
export function rawInterval(b: Bounds): Interval | null {
  const from = b.timeBasis === "store_local" ? b.effectiveFromLocal : b.effectiveFrom;
  const to = b.timeBasis === "store_local" ? b.effectiveToLocal : b.effectiveTo;
  return from === null ? null : { from: from.getTime(), to: to?.getTime() ?? null };
}

/** The interval clipped to `within`, or null when they do not meet. */
export function clip(i: Interval, within: Interval): Interval | null {
  const from = Math.max(i.from, within.from);
  const to = i.to === null ? within.to : within.to === null ? i.to : Math.min(i.to, within.to);
  return to !== null && to <= from ? null : { from, to };
}

/** An interval with no instant (a `store_local` line whose bounds fall in one DST gap). */
export const isEmpty = (i: Interval): boolean => i.to !== null && i.to <= i.from;
