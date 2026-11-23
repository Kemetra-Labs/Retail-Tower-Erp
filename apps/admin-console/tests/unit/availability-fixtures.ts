/** RT-1579 shared test data: the `OnHand.availability` object (RT-1576, inventory.yaml 1.23.0). */

export const AVAILABILITY_AS_OF = "2026-11-23T10:30:00Z";

/** A consistent default: 8 sellable, 1 expired, 2 reserved, 0 safety = 5 to sell. */
export function availability(overrides: Record<string, string | null> = {}) {
  return {
    primaryLocationId: "0190f000-0000-7000-8000-0000000007d1",
    primarySellable: "8.0000",
    expiredTrackedSellable: "1.0000",
    activeReserved: "2.0000",
    safetyProtection: "0.0000",
    availableToSell: "5.0000",
    inTransitInbound: "3.0000",
    inTransitOutbound: "4.0000",
    onOrder: null,
    asOf: AVAILABILITY_AS_OF,
    ...overrides,
  };
}

/** The negative-balance case of the older fixtures: -1.25 sellable, nothing else, so -1.25 to sell. */
export function negativeAvailability() {
  return availability({
    primarySellable: "-1.2500",
    expiredTrackedSellable: "0.0000",
    activeReserved: "0.0000",
    availableToSell: "-1.2500",
    inTransitInbound: "0.0000",
    inTransitOutbound: "0.0000",
  });
}
