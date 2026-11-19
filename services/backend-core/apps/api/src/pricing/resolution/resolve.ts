/**
 * The Retail Pricing resolver (spec 041 §4.1-4.4; RT-1484 PR-1, RT-282 PR-08a).
 *
 *   resolve(item, sellUnit, store, instant, asOfRevision) -> PriceResolution
 *
 * A pure, deterministic function of its inputs and the pricing rows passed in
 * `data`: no I/O, no clock, no ordering by creation time or priority
 * (496, 499-500). A row is visible at revision R when it was published in a
 * revision <= R and not ended by one (data-model §2.3, §2.4).
 *
 *   1. Book: the tenant's retail Book, else `unpriced(no_price_book)`.
 *   2. Candidates: visible `regular` events of that Book, item and Sell Unit
 *      whose `[effectiveFrom, effectiveTo)` contains the instant. `store_local`
 *      bounds are read in the Store's zone (§4.3).
 *   3. Store layer: one → it; more than one → `error(overlap_violation)`.
 *   4. Zone layer: the Store's visible membership at the instant (none → the
 *      Book's default Zone; more than one → `error(ambiguous_zone_membership)`),
 *      then one event of that Zone → it; more than one → overlap error.
 *   5. Book layer: one → it; more than one → overlap error.
 *   6. Nothing → `unpriced(no_price)`. No ERP lookup, no legacy fallback.
 *   7. The selected price must be exact at the currency's minor unit, else
 *      `unpriced(not_representable)`.
 *
 * RT-1484 PR-3 (RT-282 PR-08b): `traceResolution` evaluates every layer on its
 * own and derives the same result, so "why this price" (§8) can show what the
 * selected layer shadows. `resolvePrice` is its result.
 */
import { compareCodeUnits } from "../../common/compare-code-units";
import { assertTimeZone, formatInstantInZone, localWallClockToInstant } from "./store-local-time";
import { representablePrice } from "./representable-price";
import type {
  PriceResolution,
  PriceScope,
  ResolutionData,
  ResolutionPriceBook,
  ResolutionPriceEvent,
  ResolutionStore,
  ResolutionZoneMembership,
} from "./types";

/** An interval as instants (ms since the epoch). */
export interface Interval {
  readonly from: number;
  /** Exclusive; null when open-ended. */
  readonly to: number | null;
}

/** A visible event of the key whose interval contains the instant, with that interval for this Store. */
interface Candidate {
  readonly event: ResolutionPriceEvent;
  readonly interval: Interval;
}

/** What one precedence layer holds at the instant: nothing, one event, or an overlap (a data defect). */
export type LayerEval =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly candidate: Candidate }
  | { readonly kind: "overlap"; readonly eventIds: ReadonlyArray<string> };

/**
 * The Zone step: the Store's visible membership at the instant (`explicit`), none (`default`:
 * the Book's default Zone) or more than one (`ambiguous`, a data defect: no Zone, no layer).
 */
type ZoneTrace =
  | {
      readonly membership: "explicit" | "default";
      readonly zoneId: string;
      readonly membershipIds: ReadonlyArray<string>;
      readonly layer: LayerEval;
    }
  | {
      readonly membership: "ambiguous";
      readonly zoneId: null;
      readonly membershipIds: ReadonlyArray<string>;
      readonly layer: { readonly kind: "none" };
    };

/**
 * Every layer of one resolution, evaluated independently, and the result spec 041 §4.2 derives
 * from them in precedence order (Store, Zone, Book). `bookRow` and `zone` are null when the
 * tenant has no retail Book (`no_price_book`).
 */
export interface ResolutionTrace {
  readonly bookRow: ResolutionPriceBook | null;
  readonly store: LayerEval;
  readonly zone: ZoneTrace | null;
  readonly book: LayerEval;
  readonly result: PriceResolution;
}

const NONE = { kind: "none" } as const;

/** The 0121 visibility rule at revision R (data-model §2.3, §2.4). */
export function visibleAt(row: { publishedInRevision: number; endedInRevision: number | null }, revision: number): boolean {
  return row.publishedInRevision <= revision && (row.endedInRevision === null || row.endedInRevision > revision);
}

function contains(interval: Interval, instantMs: number): boolean {
  return interval.from <= instantMs && (interval.to === null || instantMs < interval.to);
}

/** The event's interval as instants for a Store in `zone`, or null when it has no usable start. */
export function eventInterval(event: ResolutionPriceEvent, zone: string): Interval | null {
  if (event.timeBasis === "store_local") {
    if (event.effectiveFromLocal === null) return null;
    return {
      from: localWallClockToInstant(event.effectiveFromLocal, zone).getTime(),
      to: event.effectiveToLocal === null ? null : localWallClockToInstant(event.effectiveToLocal, zone).getTime(),
    };
  }
  if (event.effectiveFrom === null) return null;
  return { from: event.effectiveFrom.getTime(), to: event.effectiveTo?.getTime() ?? null };
}

/** A membership's interval as instants (memberships are always absolute). */
export function membershipInterval(m: ResolutionZoneMembership): Interval {
  return { from: m.effectiveFrom.getTime(), to: m.effectiveTo?.getTime() ?? null };
}

const sortedIds = (rows: ReadonlyArray<{ id: string }>): string[] =>
  rows.map((r) => r.id).sort(compareCodeUnits);

function evaluateLayer(candidates: ReadonlyArray<Candidate>): LayerEval {
  if (candidates.length === 0) return NONE;
  if (candidates.length === 1) return { kind: "one", candidate: candidates[0]! };
  return { kind: "overlap", eventIds: sortedIds(candidates.map((c) => c.event)) };
}

/** Whether a membership row is the Store's, in this Book, as known at the revision. */
export function isStoreMembership(
  m: ResolutionZoneMembership,
  store: ResolutionStore,
  bookId: string,
  asOfRevision: number,
): boolean {
  return m.tenantId === store.tenantId && m.priceBookId === bookId && m.storeId === store.id && visibleAt(m, asOfRevision);
}

/** Step 4: the Zone (the visible membership at the instant, else the default Zone) and its layer. */
function traceZone(
  memberships: ReadonlyArray<ResolutionZoneMembership>,
  candidates: ReadonlyArray<Candidate>,
  store: ResolutionStore,
  book: ResolutionPriceBook,
  instantMs: number,
  asOfRevision: number,
): ZoneTrace {
  const live = memberships.filter(
    (m) => isStoreMembership(m, store, book.id, asOfRevision) && contains(membershipInterval(m), instantMs),
  );
  if (live.length > 1) return { membership: "ambiguous", zoneId: null, membershipIds: sortedIds(live), layer: NONE };
  const zoneId = live.length === 1 ? live[0]!.priceZoneId : book.defaultZoneId;
  return {
    membership: live.length === 1 ? "explicit" : "default",
    zoneId,
    membershipIds: sortedIds(live),
    layer: evaluateLayer(candidates.filter((c) => c.event.scope === "zone" && c.event.priceZoneId === zoneId)),
  };
}

function priced(
  candidate: Candidate,
  book: ResolutionPriceBook,
  store: ResolutionStore,
  sellUnit: string,
  asOfRevision: number,
): PriceResolution {
  const { event, interval } = candidate;
  const price = representablePrice(event.price, book.currencyCode);
  if (price === null) return { status: "unpriced", reason: "not_representable" };
  const sourceScope = event.scope as PriceScope;
  return {
    status: "priced",
    price,
    currencyCode: book.currencyCode,
    taxPriceBasis: book.taxPriceBasis as "inclusive" | "exclusive",
    sellUnit,
    provenance: {
      origin: "pricing",
      sourceScope,
      priceEventId: event.id,
      priceKind: "regular",
      pricingRevision: asOfRevision,
      priceBookId: book.id,
      priceZoneId: sourceScope === "zone" ? event.priceZoneId : null,
      effectiveFrom: formatInstantInZone(new Date(interval.from), store.timezone),
      effectiveTo: interval.to === null ? null : formatInstantInZone(new Date(interval.to), store.timezone),
    },
  };
}

/** The price key and the Book of a resolution. */
export interface ResolutionKey {
  readonly productId: string;
  readonly sellUnit: string;
  readonly store: ResolutionStore;
  readonly bookId: string;
  readonly asOfRevision: number;
}

/** Whether the event is of the key (tenant, Book, product, Sell Unit, `regular`) and visible at the revision. */
export function isKeyEvent(event: ResolutionPriceEvent, key: ResolutionKey): boolean {
  return (
    event.tenantId === key.store.tenantId &&
    event.priceBookId === key.bookId &&
    event.productId === key.productId &&
    event.sellUnit === key.sellUnit &&
    event.priceKind === "regular" &&
    visibleAt(event, key.asOfRevision)
  );
}

/** Step 2: the event as a candidate (in a one-element list), or an empty list. */
function candidateOf(event: ResolutionPriceEvent, key: ResolutionKey, instantMs: number): Candidate[] {
  if (!isKeyEvent(event, key)) return [];
  const interval = eventInterval(event, key.store.timezone);
  return interval !== null && contains(interval, instantMs) ? [{ event, interval }] : [];
}

/** The result of one layer, or null when the layer holds nothing and resolution goes on. */
function layerResult(
  layer: LayerEval,
  book: ResolutionPriceBook,
  store: ResolutionStore,
  sellUnit: string,
  asOfRevision: number,
): PriceResolution | null {
  if (layer.kind === "overlap") return { status: "error", reason: "overlap_violation", eventIds: layer.eventIds };
  if (layer.kind === "one") return priced(layer.candidate, book, store, sellUnit, asOfRevision);
  return null;
}

/**
 * Validates the inputs and returns the tenant's Book when it is usable for this Store, else null.
 * Throws RangeError for a bad Store zone or instant and TypeError for a Book without a default Zone.
 */
export function usableBook(store: ResolutionStore, instant: Date, data: ResolutionData): ResolutionPriceBook | null {
  // Inputs, not data: a bad zone or instant is the caller's defect, so it
  // throws whatever rows are present instead of depending on them.
  assertTimeZone(store.timezone);
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid instant");
  const book = data.book;
  if (book === null || book.tenantId !== store.tenantId) return null;
  // Q-8: every Book has a default Zone. A Book without one is a loader defect;
  // fail closed rather than silently skipping the Zone layer.
  if (typeof book.defaultZoneId !== "string" || book.defaultZoneId === "") {
    throw new TypeError("Price Book has no default Zone (Q-8)");
  }
  return book;
}

/**
 * Every layer of the resolution of `productId` in `sellUnit` at `store` and `instant`, as known
 * at `asOfRevision`, and its result (spec 041 §4.2, §8). Each layer is evaluated on its own so
 * "why this price" can show what a selected layer shadows; `result` is what `resolvePrice`
 * returns. Throws as `resolvePrice` does.
 */
export function traceResolution(
  productId: string,
  sellUnit: string,
  store: ResolutionStore,
  instant: Date,
  asOfRevision: number,
  data: ResolutionData,
): ResolutionTrace {
  const book = usableBook(store, instant, data);
  if (book === null) {
    return { bookRow: null, store: NONE, zone: null, book: NONE, result: { status: "unpriced", reason: "no_price_book" } };
  }
  const instantMs = instant.getTime();
  const key = { productId, sellUnit, store, bookId: book.id, asOfRevision };
  const candidates = data.events.flatMap((event) => candidateOf(event, key, instantMs));
  const storeLayer = evaluateLayer(candidates.filter((c) => c.event.scope === "store" && c.event.storeId === store.id));
  const zone = traceZone(data.memberships, candidates, store, book, instantMs, asOfRevision);
  const bookLayer = evaluateLayer(candidates.filter((c) => c.event.scope === "book"));

  const zoneResult: PriceResolution | null =
    zone.membership === "ambiguous"
      ? { status: "error", reason: "ambiguous_zone_membership", membershipIds: zone.membershipIds }
      : layerResult(zone.layer, book, store, sellUnit, asOfRevision);
  const result =
    layerResult(storeLayer, book, store, sellUnit, asOfRevision) ??
    zoneResult ??
    layerResult(bookLayer, book, store, sellUnit, asOfRevision) ?? { status: "unpriced", reason: "no_price" };
  return { bookRow: book, store: storeLayer, zone, book: bookLayer, result };
}

/**
 * Resolve the regular price of `productId` in `sellUnit` at `store` and
 * `instant`, as known at `asOfRevision` (spec 041 §4). Throws RangeError
 * for a Store zone that is not a known canonical IANA name or an invalid
 * instant, and TypeError for a Book with no `defaultZoneId` (Q-8: a loader
 * defect, never resolved past). Every data condition is a `PriceResolution`.
 */
export function resolvePrice(
  productId: string,
  sellUnit: string,
  store: ResolutionStore,
  instant: Date,
  asOfRevision: number,
  data: ResolutionData,
): PriceResolution {
  return traceResolution(productId, sellUnit, store, instant, asOfRevision, data).result;
}
