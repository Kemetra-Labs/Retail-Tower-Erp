/**
 * RT-1576 (RT-1511 S1) — wire projection of the Available-to-Sell facts of one (store, product)
 * (contract `OnHand.availability`, `inventory.yaml` 1.23.0-draft). Quantities are exact decimal strings.
 */
export interface AvailabilityBody {
  /** The store's `primary` stock location (0044): the only location V1 sells from (A-1). */
  readonly primaryLocationId: string;
  /** The `sellable` quantity at that location. */
  readonly primarySellable: string;
  /** The sellable quantity of tracking identities whose expiry date is before the store's business date (859). */
  readonly expiredTrackedSellable: string;
  /** Active reservations at that location: `state = 'active'` and `expires_at > now()` (A-2). */
  readonly activeReserved: string;
  /** Safety protection: zero in V1 and reported so its later arrival is additive (A-3). */
  readonly safetyProtection: string;
  /** primarySellable - expiredTrackedSellable - activeReserved - safetyProtection. Never clamped (A-4). */
  readonly availableToSell: string;
  /** Dispatched - received - short-closed on Transfers into this store. Never part of ATS (A-6). */
  readonly inTransitInbound: string;
  /** The same arithmetic on Transfers out of this store. */
  readonly inTransitOutbound: string;
  /** No purchasing source exists yet (A-7). */
  readonly onOrder: string | null;
  /** The instant the facts were read. */
  readonly asOf: string;
}
