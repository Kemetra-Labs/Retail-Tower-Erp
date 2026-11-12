/**
 * RT-1337 review hardening: impossible absolute dates are refused, and a reward-heavy evaluation stays linear.
 */
import { MAX_EVALUATED_UNITS, evaluateOffer } from "../../src/offers/evaluator/offer-evaluator";
import { OfferDefinitionSchema } from "../../src/offers/offers.dto";

const definition = (startsAt: string, endsAt: string | null) => ({
  nameAr: "عرض",
  type: "buy_x_get_y_percent",
  parameters: { buyQuantity: 1, getQuantity: 1, percentOff: "40", rewardSelection: "cheapest", maxApplicationsPerSale: null, priceBasis: "resolved_store_price" },
  eligibility: { include: { productIds: ["0a000000-0000-7000-8000-0000000000a1"] } },
  storeScope: { allStores: true },
  schedule: { timeBasis: "absolute", startsAt, endsAt },
});

describe("absolute schedule instants", () => {
  it.each([
    ["an impossible day", "2027-02-30T00:00:00Z"],
    ["a month 13", "2027-13-01T00:00:00Z"],
    ["hour 24", "2027-01-01T24:00:00Z"],
    ["a leap second", "2027-01-01T00:00:60Z"],
    ["no offset", "2027-01-01T00:00:00"],
    ["an offset of 24 hours", "2027-01-01T00:00:00+24:00"],
  ])("refuses %s", (_label, startsAt) => {
    expect(OfferDefinitionSchema.safeParse(definition(startsAt, null)).success).toBe(false);
  });

  it("accepts real instants, a leap day and a fractional second", () => {
    expect(OfferDefinitionSchema.safeParse(definition("2028-02-29T00:00:00Z", "2028-03-01T10:00:00.250+02:00")).success).toBe(true);
  });
});

describe("evaluation of a reward-heavy line", () => {
  it("stays linear: 99,000 rewards of one line", () => {
    const started = Date.now();
    const result = evaluateOffer({
      offer: { buyQuantity: 1, getQuantity: 1000, percentOff: "40", maxApplicationsPerSale: null },
      minorUnit: 2,
      cart: [{ lineRef: "a", productId: "p", unitPrice: "1.00", quantity: "100000", eligible: true }],
    });
    expect(result.applications).toBe(99);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses more than the unit bound", () => {
    expect(() =>
      evaluateOffer({
        offer: { buyQuantity: 1, getQuantity: 1, percentOff: "40", maxApplicationsPerSale: null },
        minorUnit: 2,
        cart: [{ lineRef: "a", productId: "p", unitPrice: "1.00", quantity: String(MAX_EVALUATED_UNITS + 1n), eligible: true }],
      }),
    ).toThrow(/units/);
  });
});
