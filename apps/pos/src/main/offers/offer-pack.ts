/**
 * RT-1339 (RT-286 S7) — the Offer Pack as the till reads it
 * (`offers.openapi.yaml` `OfferPack`, `posGetOfferPack`).
 *
 * `readOfferPack` is a strict reader: any field off-contract makes the whole body
 * unreadable (null) and the till applies no offer from it (fail safe: the customer
 * pays the regular price). It builds the lookup the plan needs: lower-cased
 * product id → the one offer that owns it.
 *
 * The contract promises a product id appears in at most one offer per Pack (OD-7).
 * The till does not rely on it for money: a product id found in two offers is
 * ineligible for both, so a malformed Pack can never discount a unit twice.
 *
 * Pure. No I/O, no clock.
 */

interface PackOfferParameters {
  readonly buyQuantity: number;
  readonly getQuantity: number;
  /** A whole percent "1".."100". */
  readonly percentOff: string;
  readonly maxApplicationsPerSale: number | null;
}

export interface PackOffer {
  readonly offerId: string;
  readonly offerVersion: number;
  readonly nameAr: string;
  readonly parameters: PackOfferParameters;
  /** Absolute instants, epoch milliseconds. */
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly offlinePolicy: 'allow_cached' | 'online_only';
  /** Lower-cased product ids owned by this offer after the disjointness guard. */
  readonly eligibleProductIds: ReadonlySet<string>;
}

export interface OfferPack {
  readonly packRevision: number;
  /** The server time of the response that carried the body (epoch ms). */
  readonly issuedAtMs: number;
  readonly freshnessWindowHours: number;
  readonly currencyCode: string;
  readonly offers: readonly PackOffer[];
}

/** The most offers and product ids one Pack may carry (contract: 200 offers, 20 000 ids each). */
const MAX_OFFERS = 200;
const MAX_PRODUCT_IDS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERCENT = /^(?:[1-9][0-9]?|100)$/;
const CURRENCY = /^[A-Z]{3}$/;
/** RFC 3339 with an explicit zone: `Date.parse` alone also takes zone-less local forms. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** The contract's ceiling on `buyQuantity`, `getQuantity` and `maxApplicationsPerSale`. */
const MAX_OFFER_QUANTITY = 1_000;

function isOfferQuantity(value: unknown): value is number {
  return isPositiveInt(value) && value <= MAX_OFFER_QUANTITY;
}

/** An RFC 3339 instant as epoch ms, or null. */
export function instantMsOf(value: unknown): number | null {
  if (typeof value !== 'string' || !INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function readParameters(value: unknown): PackOfferParameters | null {
  if (!isRecord(value)) return null;
  const { buyQuantity, getQuantity, percentOff, maxApplicationsPerSale } = value;
  // The evaluator hard-codes the V1 semantics (the cheapest units, the resolved store price). A Pack that
  // names anything else is off-contract for this till: no offer, never the wrong units discounted.
  if (value.rewardSelection !== 'cheapest' || value.priceBasis !== 'resolved_store_price') {
    return null;
  }
  // null: unlimited; otherwise a positive integer; anything else is off-contract.
  const max =
    maxApplicationsPerSale === null || isOfferQuantity(maxApplicationsPerSale)
      ? maxApplicationsPerSale
      : undefined;
  if (
    !isOfferQuantity(buyQuantity) ||
    !isOfferQuantity(getQuantity) ||
    typeof percentOff !== 'string' ||
    !PERCENT.test(percentOff) ||
    max === undefined
  ) {
    return null;
  }
  return { buyQuantity, getQuantity, percentOff, maxApplicationsPerSale: max };
}

function readProductIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRODUCT_IDS) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    ids.push(id.toLowerCase());
  }
  return ids;
}

interface RawOffer extends Omit<PackOffer, 'eligibleProductIds'> {
  readonly productIds: string[];
}

/** The offer's window as absolute instants; null when the start is unreadable or a set end is. */
function readWindow(
  value: Record<string, unknown>,
): { startsAtMs: number; endsAtMs: number | null } | null {
  const startsAtMs = instantMsOf(value.startsAt);
  const endsAtMs = value.endsAt === null ? null : instantMsOf(value.endsAt);
  if (startsAtMs === null || (value.endsAt !== null && endsAtMs === null)) return null;
  return { startsAtMs, endsAtMs };
}

/** The offer's identity: a uuid, a positive version, an Arabic name, the one V1 type. */
function readIdentity(
  value: Record<string, unknown>,
): { offerId: string; offerVersion: number; nameAr: string } | null {
  const { offerId, offerVersion, nameAr, type } = value;
  if (
    typeof offerId !== 'string' ||
    !UUID.test(offerId) ||
    !isPositiveInt(offerVersion) ||
    typeof nameAr !== 'string' ||
    nameAr.length < 1 ||
    nameAr.length > 120 ||
    type !== 'buy_x_get_y_percent'
  ) {
    return null;
  }
  return { offerId: offerId.toLowerCase(), offerVersion, nameAr };
}

function readOffer(value: unknown): RawOffer | null {
  if (!isRecord(value)) return null;
  const identity = readIdentity(value);
  const window = readWindow(value);
  const parameters = readParameters(value.parameters);
  const productIds = readProductIds(value.eligibleProductIds);
  const { offlinePolicy } = value;
  if (
    identity === null ||
    window === null ||
    parameters === null ||
    productIds === null ||
    (offlinePolicy !== 'allow_cached' && offlinePolicy !== 'online_only')
  ) {
    return null;
  }
  return { ...identity, ...window, parameters, offlinePolicy, productIds };
}

/** Product ids that appear in more than one offer: ineligible for all of them. */
function contestedIds(raw: readonly RawOffer[]): Set<string> {
  const seen = new Set<string>();
  const contested = new Set<string>();
  for (const offer of raw) {
    for (const id of new Set(offer.productIds)) {
      if (seen.has(id)) contested.add(id);
      seen.add(id);
    }
  }
  return contested;
}

/** The Pack's own fields, or null when any is off-contract. */
function readHeader(json: Record<string, unknown>): Omit<OfferPack, 'offers'> | null {
  const { packRevision, freshnessWindowHours, currencyCode } = json;
  const issuedAtMs = instantMsOf(json.issuedAt);
  if (
    typeof packRevision !== 'number' ||
    !Number.isSafeInteger(packRevision) ||
    packRevision < 0 ||
    issuedAtMs === null ||
    typeof freshnessWindowHours !== 'number' ||
    !Number.isInteger(freshnessWindowHours) ||
    freshnessWindowHours < 1 ||
    freshnessWindowHours > 72 ||
    typeof currencyCode !== 'string' ||
    !CURRENCY.test(currencyCode) ||
    typeof json.storeTimezone !== 'string'
  ) {
    return null;
  }
  return { packRevision, issuedAtMs, freshnessWindowHours, currencyCode };
}

/**
 * The strictly-read Pack, or null when any field is off-contract. `issuedAtMs` is the body's
 * `issuedAt` (the service checks it against the `X-Server-Time` header).
 */
export function readOfferPack(json: unknown): OfferPack | null {
  if (!isRecord(json)) return null;
  const header = readHeader(json);
  const { offers } = json;
  if (header === null || !Array.isArray(offers) || offers.length > MAX_OFFERS) return null;
  const raw: RawOffer[] = [];
  for (const entry of offers) {
    const offer = readOffer(entry);
    if (offer === null) return null;
    raw.push(offer);
  }
  const contested = contestedIds(raw);
  return {
    ...header,
    offers: raw.map(({ productIds, ...offer }) => ({
      ...offer,
      eligibleProductIds: new Set(productIds.filter((id) => !contested.has(id))),
    })),
  };
}
