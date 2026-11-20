/**
 * Price timeline and next change (spec 041 §8; decisions 502-505, 511; RT-1484 PR-3,
 * RT-282 PR-08b). Pure, on top of the resolver.
 *
 * The resolution of a key can only change at an instant where a visible event of the key or a
 * visible Zone membership of the Store starts or ends (its interval converted for this Store).
 * Between two such boundaries every interval either contains the whole stretch or none of it, so
 * resolving once at each boundary is exact: no sampling, no clock.
 */
import { isDeepStrictEqual } from "node:util";

import {
  eventInterval,
  isKeyEvent,
  isStoreMembership,
  membershipInterval,
  resolvePrice,
  usableBook,
  type Interval,
} from "./resolve";
import type { PriceResolution, ResolutionData, ResolutionStore } from "./types";

/** One stretch `[fromMs, toMs)` with the resolution that holds through it. */
export interface TimelineSegment {
  readonly fromMs: number;
  readonly toMs: number;
  readonly result: PriceResolution;
}

/** Every instant (ms, ascending, unique) at which the key's resolution can change for this Store. */
function boundaries(
  productId: string,
  sellUnit: string,
  store: ResolutionStore,
  asOfRevision: number,
  data: ResolutionData,
): number[] {
  const book = usableBook(store, new Date(0), data);
  if (book === null) return [];
  const key = { productId, sellUnit, store, bookId: book.id, asOfRevision };
  const points = new Set<number>();
  const add = (interval: Interval | null): void => {
    if (interval === null) return;
    points.add(interval.from);
    if (interval.to !== null) points.add(interval.to);
  };
  for (const event of data.events) if (isKeyEvent(event, key)) add(eventInterval(event, store.timezone));
  for (const m of data.memberships) if (isStoreMembership(m, store, book.id, asOfRevision)) add(membershipInterval(m));
  return [...points].sort((x, y) => x - y);
}

/** Two resolutions are the same when every field is, whatever the key order. */
const sameResolution = (x: PriceResolution, y: PriceResolution): boolean => isDeepStrictEqual(x, y);

/**
 * The ordered, contiguous segments covering exactly `[fromMs, toMs)`, adjacent equal resolutions
 * merged (decision 511). Throws RangeError unless `fromMs < toMs`, and as `resolvePrice` does.
 */
export function resolveTimeline(
  productId: string,
  sellUnit: string,
  store: ResolutionStore,
  fromMs: number,
  toMs: number,
  asOfRevision: number,
  data: ResolutionData,
): TimelineSegment[] {
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs)) throw new RangeError("Empty window");
  const starts = [fromMs, ...boundaries(productId, sellUnit, store, asOfRevision, data).filter((b) => b > fromMs && b < toMs)];
  const segments: TimelineSegment[] = [];
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1] ?? toMs;
    const result = resolvePrice(productId, sellUnit, store, new Date(start), asOfRevision, data);
    const last = segments[segments.length - 1];
    if (last !== undefined && sameResolution(last.result, result)) segments[segments.length - 1] = { ...last, toMs: end };
    else segments.push({ fromMs: start, toMs: end, result });
  }
  return segments;
}

/**
 * The first instant after `instant` at which the resolution differs from the one at `instant`,
 * with that resolution, as known at `asOfRevision`; null when no later change is published.
 */
export function nextChange(
  productId: string,
  sellUnit: string,
  store: ResolutionStore,
  instant: Date,
  asOfRevision: number,
  data: ResolutionData,
): { readonly at: Date; readonly result: PriceResolution } | null {
  const current = resolvePrice(productId, sellUnit, store, instant, asOfRevision, data);
  for (const b of boundaries(productId, sellUnit, store, asOfRevision, data)) {
    if (b <= instant.getTime()) continue;
    const result = resolvePrice(productId, sellUnit, store, new Date(b), asOfRevision, data);
    if (!sameResolution(current, result)) return { at: new Date(b), result };
  }
  return null;
}
