/**
 * Pricing resolver types (spec 041 §4, RT-1484 PR-1 / RT-282 PR-08a).
 *
 * The inputs are the Drizzle row shapes of the pricing tables (0121), narrowed
 * to the columns the resolver reads, so the repository that loads them (a later
 * RT-1484 PR) passes rows through unchanged. The output mirrors
 * `PriceResolution` in `packages/contracts/openapi/pricing/price-inquiry.yaml`.
 *
 * Drizzle reads a `timestamp without time zone` as a `Date` whose UTC fields
 * are the stored wall-clock value; `effectiveFromLocal` / `effectiveToLocal`
 * keep that convention (their UTC fields are the Store-local date-time).
 */
import type { priceBooks, priceEvents, priceZoneMemberships, stores } from "@data-pulse-2/db/schema";

/** The Store being priced: its tenant and its IANA time zone (`stores.timezone`). */
export type ResolutionStore = Pick<typeof stores.$inferSelect, "id" | "tenantId" | "timezone">;

/** The tenant's retail Price Book (v1: the only one, data-model §2.1). */
export type ResolutionPriceBook = Pick<
  typeof priceBooks.$inferSelect,
  "id" | "tenantId" | "currencyCode" | "taxPriceBasis"
>;

/** A Store → Zone membership row; absolute instants (data-model §2.3). */
export type ResolutionZoneMembership = Pick<
  typeof priceZoneMemberships.$inferSelect,
  | "id"
  | "tenantId"
  | "priceBookId"
  | "priceZoneId"
  | "storeId"
  | "effectiveFrom"
  | "effectiveTo"
  | "publishedInRevision"
  | "endedInRevision"
>;

/** A price event row (data-model §2.4). */
export type ResolutionPriceEvent = Pick<
  typeof priceEvents.$inferSelect,
  | "id"
  | "tenantId"
  | "priceBookId"
  | "scope"
  | "priceZoneId"
  | "storeId"
  | "productId"
  | "sellUnit"
  | "priceKind"
  | "price"
  | "timeBasis"
  | "effectiveFrom"
  | "effectiveTo"
  | "effectiveFromLocal"
  | "effectiveToLocal"
  | "publishedInRevision"
  | "endedInRevision"
>;

/**
 * The pricing data the resolver reads. It may hold more rows than the key
 * needs (other products, Stores, revisions); the resolver filters them.
 */
export interface ResolutionData {
  /** The tenant's retail Book, or null when the tenant has none (`no_price_book`). */
  readonly book: ResolutionPriceBook | null;
  /** The Book's default Zone (Q-8: one per Book, immutable), or null when unknown. */
  readonly defaultZoneId: string | null;
  readonly memberships: ReadonlyArray<ResolutionZoneMembership>;
  readonly events: ReadonlyArray<ResolutionPriceEvent>;
}

export type PriceScope = "book" | "zone" | "store";

/** `ResolvedPriceProvenance` (price-inquiry.yaml). */
interface ResolvedPriceProvenance {
  readonly origin: "pricing";
  readonly sourceScope: PriceScope;
  readonly priceEventId: string;
  readonly priceKind: "regular";
  /** The revision the resolution was evaluated at (`asOfRevision`). */
  readonly pricingRevision: number;
  readonly priceBookId: string;
  /** The selected Zone; null unless `sourceScope = zone`. */
  readonly priceZoneId: string | null;
  /** RFC 3339 instant in the Store's time zone. */
  readonly effectiveFrom: string;
  /** Exclusive end, RFC 3339 in the Store's time zone; null when open-ended. */
  readonly effectiveTo: string | null;
}

interface PricedResolution {
  readonly status: "priced";
  /** Exact decimal at `numeric(19,4)` scale, e.g. `125.5000`. */
  readonly price: string;
  readonly currencyCode: string;
  readonly taxPriceBasis: "inclusive" | "exclusive";
  readonly sellUnit: string;
  readonly provenance: ResolvedPriceProvenance;
}

interface UnpricedResolution {
  readonly status: "unpriced";
  readonly reason: "no_price" | "no_price_book" | "not_representable";
}

type ErrorResolution =
  | { readonly status: "error"; readonly reason: "overlap_violation"; readonly eventIds: ReadonlyArray<string> }
  | {
      readonly status: "error";
      readonly reason: "ambiguous_zone_membership";
      readonly membershipIds: ReadonlyArray<string>;
    };

/** `PriceResolution` (price-inquiry.yaml), discriminated by `status`. */
export type PriceResolution = PricedResolution | UnpricedResolution | ErrorResolution;
