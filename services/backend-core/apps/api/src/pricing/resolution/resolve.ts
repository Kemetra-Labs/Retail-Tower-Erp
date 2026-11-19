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

interface Interval {
  readonly from: number;
  /** Exclusive; null when open-ended. */
  readonly to: number | null;
}

interface Candidate {
  readonly event: ResolutionPriceEvent;
  readonly interval: Interval;
}

type LayerOutcome = { readonly kind: "none" } | { readonly kind: "one"; readonly candidate: Candidate } | PriceResolution;

const NONE: LayerOutcome = { kind: "none" };

function visibleAt(row: { publishedInRevision: number; endedInRevision: number | null }, revision: number): boolean {
  return row.publishedInRevision <= revision && (row.endedInRevision === null || row.endedInRevision > revision);
}

function contains(interval: Interval, instantMs: number): boolean {
  return interval.from <= instantMs && (interval.to === null || instantMs < interval.to);
}

/** The event's interval as instants for this Store, or null when it has no usable start. */
function eventInterval(event: ResolutionPriceEvent, zone: string): Interval | null {
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

const sortedIds = (rows: ReadonlyArray<{ id: string }>): string[] =>
  rows.map((r) => r.id).sort(compareCodeUnits);

function pickOne(candidates: ReadonlyArray<Candidate>): LayerOutcome {
  if (candidates.length === 0) return NONE;
  if (candidates.length === 1) return { kind: "one", candidate: candidates[0]! };
  return { status: "error", reason: "overlap_violation", eventIds: sortedIds(candidates.map((c) => c.event)) };
}

/** Step 4's Zone: the visible membership at the instant, else the default Zone. */
function zoneFor(
  memberships: ReadonlyArray<ResolutionZoneMembership>,
  store: ResolutionStore,
  book: ResolutionPriceBook,
  instantMs: number,
  asOfRevision: number,
): { readonly zoneId: string } | PriceResolution | null {
  const live = memberships.filter(
    (m) =>
      m.tenantId === store.tenantId &&
      m.priceBookId === book.id &&
      m.storeId === store.id &&
      visibleAt(m, asOfRevision) &&
      contains({ from: m.effectiveFrom.getTime(), to: m.effectiveTo?.getTime() ?? null }, instantMs),
  );
  if (live.length > 1) {
    return { status: "error", reason: "ambiguous_zone_membership", membershipIds: sortedIds(live) };
  }
  return live.length === 1 ? { zoneId: live[0]!.priceZoneId } : null;
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

interface CandidateKey {
  readonly productId: string;
  readonly sellUnit: string;
  readonly store: ResolutionStore;
  readonly bookId: string;
  readonly instantMs: number;
  readonly asOfRevision: number;
}

/** Step 2: the event as a candidate (in a one-element list), or an empty list. */
function candidateOf(event: ResolutionPriceEvent, key: CandidateKey): Candidate[] {
  const matches =
    event.tenantId === key.store.tenantId &&
    event.priceBookId === key.bookId &&
    event.productId === key.productId &&
    event.sellUnit === key.sellUnit &&
    event.priceKind === "regular" &&
    visibleAt(event, key.asOfRevision);
  if (!matches) return [];
  const interval = eventInterval(event, key.store.timezone);
  return interval !== null && contains(interval, key.instantMs) ? [{ event, interval }] : [];
}

/**
 * Resolve the regular price of `productId` in `sellUnit` at `store` and
 * `instant`, as known at `asOfRevision` (spec 041 §4). Throws RangeError
 * for a Store zone that is not a known canonical IANA name, or an invalid
 * instant; every data condition is a `PriceResolution`.
 */
export function resolvePrice(
  productId: string,
  sellUnit: string,
  store: ResolutionStore,
  instant: Date,
  asOfRevision: number,
  data: ResolutionData,
): PriceResolution {
  // Inputs, not data: a bad zone or instant is the caller's defect, so it
  // throws whatever rows are present instead of depending on them.
  assertTimeZone(store.timezone);
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid instant");
  const book = data.book;
  if (book === null || book.tenantId !== store.tenantId) return { status: "unpriced", reason: "no_price_book" };
  const instantMs = instant.getTime();
  const key = { productId, sellUnit, store, bookId: book.id, instantMs, asOfRevision };
  const candidates = data.events.flatMap((event) => candidateOf(event, key));

  const layers: ReadonlyArray<() => LayerOutcome> = [
    () => pickOne(candidates.filter((c) => c.event.scope === "store" && c.event.storeId === store.id)),
    () => {
      const zone = zoneFor(data.memberships, store, book, instantMs, asOfRevision);
      if (zone !== null && "status" in zone) return zone;
      const zoneId = zone?.zoneId ?? data.defaultZoneId;
      if (zoneId === null) return NONE;
      return pickOne(candidates.filter((c) => c.event.scope === "zone" && c.event.priceZoneId === zoneId));
    },
    () => pickOne(candidates.filter((c) => c.event.scope === "book")),
  ];

  for (const layer of layers) {
    const outcome = layer();
    if ("status" in outcome) return outcome;
    if (outcome.kind === "one") return priced(outcome.candidate, book, store, sellUnit, asOfRevision);
  }
  return { status: "unpriced", reason: "no_price" };
}
