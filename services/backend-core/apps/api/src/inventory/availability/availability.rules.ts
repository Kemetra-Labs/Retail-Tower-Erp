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
    availableToSell: formatQuantity(sellable - expired - reserved - SAFETY_PROTECTION_V1),
    inTransitInbound: formatQuantity(parseQuantity(facts.inTransitInbound)),
    inTransitOutbound: formatQuantity(parseQuantity(facts.inTransitOutbound)),
    onOrder: null,
    asOf: facts.asOf.toISOString(),
  };
}
