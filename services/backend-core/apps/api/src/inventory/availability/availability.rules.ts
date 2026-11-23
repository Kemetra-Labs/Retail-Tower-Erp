/**
 * RT-1576 (RT-1511 S1) — the pure Available-to-Sell composition. The facts come from the database
 * (`availability.query.ts`); this file only does the arithmetic, in exact scaled bigints (never `Number`).
 *
 * A-1  ATS = primary sellable - expired tracked sellable - active reservations - safety protection.
 * A-3  Safety protection is zero in V1 (the field is reported so a later policy is additive).
 * A-4  A negative ATS is reported as computed (743). Nothing is clamped.
 * A-5  Holds are NOT subtracted: they already left `sellable` (inventory/safety/hold-move.rules.ts).
 * A-6  In Transit is reported beside ATS and never enters it.
 * A-7  On Order has no purchasing source on `main`: `null`.
 *
 * RT-1577 (S2): the same arithmetic serves the POS snapshot and adds the till's band (RT-1511 section 3):
 * `out` when ATS <= 0; `low` when 0 < ATS <= the active low-stock level; `in_stock` otherwise, including with no level.
 */
import { formatQuantity, parseQuantity } from '../../common/quantity/decimal-quantity';
import type { AvailabilityBody } from './availability.types';

/** V1 safety protection (A-3): a policy value, not a stored quantity. */
const SAFETY_PROTECTION_V1 = 0n;

interface AvailabilityFacts {
  readonly primaryLocationId: string;
  readonly primarySellable: string;
  readonly expiredTrackedSellable: string;
  readonly activeReserved: string;
  readonly inTransitInbound: string;
  readonly inTransitOutbound: string;
  readonly asOf: Date;
}

/** A-1: the one formula, exact in scaled bigints and never clamped (A-4). */
function availableToSell(sellable: bigint, expired: bigint, reserved: bigint): bigint {
  return sellable - expired - reserved - SAFETY_PROTECTION_V1;
}

export function composeAvailability(facts: AvailabilityFacts): AvailabilityBody {
  const sellable = parseQuantity(facts.primarySellable);
  const expired = parseQuantity(facts.expiredTrackedSellable);
  const reserved = parseQuantity(facts.activeReserved);
  return {
    primaryLocationId: facts.primaryLocationId,
    primarySellable: formatQuantity(sellable),
    expiredTrackedSellable: formatQuantity(expired),
    activeReserved: formatQuantity(reserved),
    safetyProtection: formatQuantity(SAFETY_PROTECTION_V1),
    availableToSell: formatQuantity(availableToSell(sellable, expired, reserved)),
    inTransitInbound: formatQuantity(parseQuantity(facts.inTransitInbound)),
    inTransitOutbound: formatQuantity(parseQuantity(facts.inTransitOutbound)),
    onOrder: null,
    asOf: facts.asOf.toISOString(),
  };
}

/** The till's three-way availability band (spec 013 FR-1). */
type AvailabilityBand = 'in_stock' | 'low' | 'out';

/** The band of a (possibly negative) ATS against the active low-stock level; a `null` level means none is set. */
function availabilityBand(ats: bigint, lowStockLevel: bigint | null): AvailabilityBand {
  if (ats <= 0n) return 'out';
  if (lowStockLevel !== null && ats <= lowStockLevel) return 'low';
  return 'in_stock';
}

/** One item of the POS store-availability snapshot (contract `StoreAvailabilityItem`). */
export interface StoreAvailabilityItem {
  readonly productId: string;
  readonly availableToSell: string;
  readonly band: AvailabilityBand;
}

/** The sellable, expired-lot and reserved quantities of one product at the primary location (`numeric(19,4)` text). */
export interface SnapshotFacts {
  readonly primarySellable: string;
  readonly expiredTrackedSellable: string;
  readonly activeReserved: string;
}

/** The snapshot item of one product: ATS by the A-1 formula, then its band against `lowStockLevel` (text, or null). */
export function composeStoreAvailabilityItem(
  productId: string,
  facts: SnapshotFacts,
  lowStockLevel: string | null,
): StoreAvailabilityItem {
  const ats = availableToSell(
    parseQuantity(facts.primarySellable),
    parseQuantity(facts.expiredTrackedSellable),
    parseQuantity(facts.activeReserved),
  );
  return {
    productId,
    availableToSell: formatQuantity(ats),
    band: availabilityBand(ats, lowStockLevel === null ? null : parseQuantity(lowStockLevel)),
  };
}
