/**
 * RT-1578 (RT-1511 S3, spec 013) — the `availability.*` bridge types.
 *
 * Band only: the Available-to-Sell number is never part of a bridge answer (owner decision 2026-11-24,
 * RT-1578 comment 18614). Availability is shown and never enforced: no member of this surface blocks,
 * holds or confirms a sale (FR-5), and none reserves or writes stock (FR-6).
 */

/** What a row shows. `unknown`: no record (or nothing downloaded). `uncertain`: the data is stale. */
export type AvailabilityRowState = 'in_stock' | 'low' | 'out' | 'unknown' | 'uncertain';

/** `never`: no successful refresh for this pairing. `stale`: older than the staleness window. */
export type AvailabilityFreshnessState = 'never' | 'fresh' | 'stale';

export interface AvailabilityFreshness {
  readonly state: AvailabilityFreshnessState;
  /** The OLDEST `asOf` of the last successful refresh (ISO-8601 UTC); null while `never`. */
  readonly as_of: string | null;
}

export type AvailabilityRefusalReason = 'no_session' | 'invalid_request';

export type AvailabilityStatusResponse =
  | ({ readonly kind: 'ok' } & AvailabilityFreshness)
  | { readonly kind: 'refused'; readonly reason: AvailabilityRefusalReason };

export interface AvailabilityBandsRequest {
  readonly product_ids: readonly string[];
}

export type AvailabilityBandsResponse =
  | ({
      readonly kind: 'ok';
      /** One entry for EVERY requested product id. */
      readonly states: Readonly<Record<string, AvailabilityRowState>>;
    } & AvailabilityFreshness)
  | { readonly kind: 'refused'; readonly reason: AvailabilityRefusalReason };

export type AvailabilityRefreshOutcome =
  | 'refreshed'
  | 'failed'
  | 'unreachable'
  | 'unauthorized'
  | 'unpaired';

export type AvailabilityRefreshResponse =
  | { readonly kind: 'done'; readonly outcome: AvailabilityRefreshOutcome }
  | { readonly kind: 'refused'; readonly reason: AvailabilityRefusalReason };

export interface AvailabilityBridgeAPI {
  status(req: Record<string, never>): Promise<AvailabilityStatusResponse>;
  bands(req: AvailabilityBandsRequest): Promise<AvailabilityBandsResponse>;
  refresh(req: Record<string, never>): Promise<AvailabilityRefreshResponse>;
}
