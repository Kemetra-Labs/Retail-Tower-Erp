/** RT-1338 shared test data: offers payloads (`offers.openapi.yaml`). */
import type { Offer, OfferDefinition, OfferPreview } from "@/lib/offer-queries";

export const OFFER_ID = "0190f000-0000-7000-8000-00000000a001";
export const STORE_A = "0190f000-0000-7000-8000-00000000b001";
export const STORE_B = "0190f000-0000-7000-8000-00000000b002";
export const CATEGORY_SHOES = "0190f000-0000-7000-8000-00000000c001";
export const BRAND_NIKE = "0190f000-0000-7000-8000-00000000d001";
export const PRODUCT_Z = "0190f000-0000-7000-8000-00000000e001";

export function definition(over: Partial<OfferDefinition> = {}): OfferDefinition {
  return {
    nameAr: "اشترِ واحصل",
    nameEn: "Buy and get",
    type: "buy_x_get_y_percent",
    parameters: {
      buyQuantity: 1,
      getQuantity: 1,
      percentOff: "40",
      rewardSelection: "cheapest",
      maxApplicationsPerSale: null,
      priceBasis: "resolved_store_price",
    },
    eligibility: {
      include: { categoryIds: [CATEGORY_SHOES] },
      exclude: { productIds: [PRODUCT_Z] },
    },
    storeScope: { allStores: true },
    schedule: { timeBasis: "store_local", startsAt: "2026-11-20T09:00", endsAt: null },
    offlinePolicy: "allow_cached",
    ...over,
  } as OfferDefinition;
}

export function offer(over: Partial<Offer> = {}): Offer {
  const published = definition();
  return {
    offerId: OFFER_ID,
    state: "active",
    draft: null,
    currentVersion: {
      version: 1,
      definition: published,
      publishedAt: "2026-11-12T10:00:00Z",
      publishedByUserId: "0190f000-0000-7000-8000-00000000f001",
      eligibleSetCount: 12,
    },
    pause: null,
    pausedStores: [],
    createdAt: "2026-11-12T09:00:00Z",
    updatedAt: "2026-11-12T10:00:00Z",
    endedAt: null,
    archivedAt: null,
    rematerialisationConflicts: [],
    ...over,
  };
}

export function draftOffer(over: Partial<Offer> = {}): Offer {
  return offer({
    state: "draft",
    currentVersion: null,
    draft: {
      draftRevision: 1,
      definition: definition(),
      updatedAt: "2026-11-12T09:00:00Z",
      updatedByUserId: "0190f000-0000-7000-8000-00000000f001",
    },
    ...over,
  });
}

export function preview(over: Partial<OfferPreview> = {}): OfferPreview {
  return {
    offerId: OFFER_ID,
    draftRevision: 1,
    publishable: true,
    issues: [],
    eligibleSet: {
      count: 12,
      sample: [{ productId: PRODUCT_Z, sku: "SKU-1", name: "Runner" }],
    },
    conflicts: [],
    simulation: null,
    ...over,
  };
}
