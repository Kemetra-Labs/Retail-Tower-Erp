/**
 * Row builders for the pricing resolver specs (RT-1484 PR-1). Plain objects in
 * the Drizzle row shapes the resolver reads; no database.
 */
import type {
  ResolutionData,
  ResolutionPriceBook,
  ResolutionPriceEvent,
  ResolutionStore,
  ResolutionZoneMembership,
} from "../../../src/pricing/resolution/types";

export const TENANT = "00000000-0000-7000-8000-000000000001";
export const OTHER_TENANT = "00000000-0000-7000-8000-000000000002";
export const BOOK = "00000000-0000-7000-8000-0000000000b1";
export const DEFAULT_ZONE = "00000000-0000-7000-8000-0000000000d0";
export const ZONE_A = "00000000-0000-7000-8000-0000000000a1";
export const ZONE_B = "00000000-0000-7000-8000-0000000000a2";
export const STORE = "00000000-0000-7000-8000-0000000000c1";
export const OTHER_STORE = "00000000-0000-7000-8000-0000000000c2";
export const PRODUCT = "00000000-0000-7000-8000-0000000000e1";
export const OTHER_PRODUCT = "00000000-0000-7000-8000-0000000000e2";

export const store = (over: Partial<ResolutionStore> = {}): ResolutionStore => ({
  id: STORE,
  tenantId: TENANT,
  timezone: "Africa/Cairo",
  ...over,
});

export const book = (over: Partial<ResolutionPriceBook> = {}): ResolutionPriceBook => ({
  id: BOOK,
  tenantId: TENANT,
  currencyCode: "EGP",
  taxPriceBasis: "inclusive",
  ...over,
});

let seq = 0;
/** A deterministic UUID-shaped id; `n` keeps ids stable across a spec. */
export const id = (prefix: string, n: number = ++seq): string =>
  `00000000-0000-7000-${prefix.padStart(4, "0")}-${n.toString(16).padStart(12, "0")}`;

export const at = (iso: string): Date => new Date(iso);
/** A wall-clock value in Drizzle's `timestamp without time zone` convention. */
export const wall = (iso: string): Date => new Date(`${iso}Z`);

export type EventOver = Partial<ResolutionPriceEvent>;

export const event = (over: EventOver = {}): ResolutionPriceEvent => ({
  id: id("e"),
  tenantId: TENANT,
  priceBookId: BOOK,
  scope: "book",
  priceZoneId: null,
  storeId: null,
  productId: PRODUCT,
  sellUnit: "each",
  priceKind: "regular",
  price: "100.0000",
  timeBasis: "absolute",
  effectiveFrom: at("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  effectiveFromLocal: null,
  effectiveToLocal: null,
  publishedInRevision: 1,
  endedInRevision: null,
  ...over,
});

export const bookEvent = (over: EventOver = {}): ResolutionPriceEvent => event({ scope: "book", ...over });
export const zoneEvent = (zoneId: string, over: EventOver = {}): ResolutionPriceEvent =>
  event({ scope: "zone", priceZoneId: zoneId, ...over });
export const storeEvent = (over: EventOver = {}): ResolutionPriceEvent =>
  event({ scope: "store", storeId: STORE, ...over });

export const membership = (
  zoneId: string,
  over: Partial<ResolutionZoneMembership> = {},
): ResolutionZoneMembership => ({
  id: id("m"),
  tenantId: TENANT,
  priceBookId: BOOK,
  priceZoneId: zoneId,
  storeId: STORE,
  effectiveFrom: at("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  publishedInRevision: 1,
  endedInRevision: null,
  ...over,
});

export const data = (over: Partial<ResolutionData> = {}): ResolutionData => ({
  book: book(),
  defaultZoneId: DEFAULT_ZONE,
  memberships: [],
  events: [],
  ...over,
});
