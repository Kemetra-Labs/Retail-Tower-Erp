import {
  OFFER_FIELD_ORDER,
  buildDefinition,
  emptyOfferForm,
  formOf,
  isDirty,
  validateOfferForm,
} from "@/offers/offerFormLogic";
import { describe, expect, test } from "vitest";
import { BRAND_NIKE, CATEGORY_SHOES, PRODUCT_Z, STORE_A, definition } from "./offer-fixtures";

/**
 * RT-1338 (RT-286 S6): the offer editor's draft ↔ `OfferDefinition`. The Console guards what the
 * contract constrains and resolves nothing: exclusion wins is copy, the eligible set is the server's.
 */

function valid() {
  return {
    ...emptyOfferForm(true),
    nameAr: "اشترِ واحصل",
    percentOff: "40",
    include: { productIds: [], categoryIds: [CATEGORY_SHOES], brandIds: [] },
    startsAt: "2026-11-20T09:00",
  };
}

describe("buildDefinition", () => {
  test("a valid form is the complete definition: cheapest, resolved store price, store-local time", () => {
    const built = buildDefinition(valid(), true);
    expect(built).toEqual({
      ok: true,
      definition: {
        nameAr: "اشترِ واحصل",
        type: "buy_x_get_y_percent",
        parameters: {
          buyQuantity: 1,
          getQuantity: 1,
          percentOff: "40",
          rewardSelection: "cheapest",
          maxApplicationsPerSale: null,
          priceBasis: "resolved_store_price",
        },
        eligibility: { include: { categoryIds: [CATEGORY_SHOES] } },
        storeScope: { allStores: true },
        schedule: { timeBasis: "store_local", startsAt: "2026-11-20T09:00", endsAt: null },
        offlinePolicy: "allow_cached",
      },
    });
  });

  test("an exclude set goes on the wire only when it names something; empty dimensions are left out", () => {
    const withExclude = buildDefinition(
      {
        ...valid(),
        include: { productIds: [], categoryIds: [CATEGORY_SHOES], brandIds: [BRAND_NIKE] },
        exclude: { productIds: [PRODUCT_Z], categoryIds: [], brandIds: [] },
      },
      true,
    );
    expect(withExclude.ok && withExclude.definition.eligibility).toEqual({
      include: { categoryIds: [CATEGORY_SHOES], brandIds: [BRAND_NIKE] },
      exclude: { productIds: [PRODUCT_Z] },
    });
    const none = buildDefinition(valid(), true);
    expect(none.ok && "exclude" in none.definition.eligibility).toBe(false);
  });

  test("Arabic-Indic digits are accepted for X, Y, P and the maximum; blank maximum is unlimited", () => {
    const built = buildDefinition(
      { ...valid(), buyQuantity: "٢", getQuantity: "٣", percentOff: "٤٠", maxApplications: "٥" },
      true,
    );
    expect(built.ok && built.definition.parameters).toMatchObject({
      buyQuantity: 2,
      getQuantity: 3,
      percentOff: "40",
      maxApplicationsPerSale: 5,
    });
  });

  test("an English name and an end time are sent when given, trimmed", () => {
    const built = buildDefinition(
      {
        ...valid(),
        nameEn: "  Buy and get ",
        endsAt: "2026-12-01T00:00",
        offlinePolicy: "online_only",
      },
      true,
    );
    expect(built.ok && built.definition).toMatchObject({
      nameEn: "Buy and get",
      schedule: { endsAt: "2026-12-01T00:00" },
      offlinePolicy: "online_only",
    });
  });

  test("stores: a list is sent as is; a bounded membership cannot send all stores", () => {
    const stores = buildDefinition({ ...valid(), scope: "stores", storeIds: [STORE_A] }, false);
    expect(stores.ok && stores.definition.storeScope).toEqual({ storeIds: [STORE_A] });
    const all = buildDefinition({ ...valid(), scope: "all" }, false);
    expect(all).toEqual({
      ok: false,
      errors: { storeIds: { messageKey: "offers.form.error.allStoresNotAllowed" } },
    });
  });
});

describe("validateOfferForm: every error at once, nothing sent", () => {
  test("an empty new offer lists name, include and start", () => {
    const errors = validateOfferForm(emptyOfferForm(true), true);
    expect(Object.keys(errors)).toEqual(["nameAr", "include", "startsAt"]);
  });

  test("X, Y, P and the maximum are whole numbers in range", () => {
    const errors = validateOfferForm(
      {
        ...valid(),
        buyQuantity: "0",
        getQuantity: "1001",
        percentOff: "101",
        maxApplications: "x",
      },
      true,
    );
    expect(Object.keys(errors)).toEqual([
      "buyQuantity",
      "getQuantity",
      "percentOff",
      "maxApplications",
    ]);
    expect(validateOfferForm({ ...valid(), percentOff: "100" }, true)).toEqual({});
    expect(validateOfferForm({ ...valid(), percentOff: "1" }, true)).toEqual({});
  });

  test("include must name at least one product, category or brand", () => {
    const errors = validateOfferForm(
      { ...valid(), include: { productIds: [], categoryIds: [], brandIds: [] } },
      true,
    );
    expect(errors.include?.messageKey).toBe("offers.form.error.includeRequired");
  });

  test("an end time must be after the start", () => {
    expect(
      validateOfferForm({ ...valid(), endsAt: "2026-11-20T09:00" }, true).endsAt?.messageKey,
    ).toBe("offers.form.error.endBeforeStart");
    expect(
      validateOfferForm({ ...valid(), endsAt: "2026-11-19T09:00" }, true).endsAt?.messageKey,
    ).toBe("offers.form.error.endBeforeStart");
    expect(validateOfferForm({ ...valid(), endsAt: "2026-11-21T09:00" }, true)).toEqual({});
  });

  test("the errors are reported in the order of the form", () => {
    expect(OFFER_FIELD_ORDER).toEqual([
      "nameAr",
      "nameEn",
      "buyQuantity",
      "getQuantity",
      "percentOff",
      "maxApplications",
      "include",
      "storeIds",
      "startsAt",
      "endsAt",
    ]);
  });
});

describe("formOf and isDirty", () => {
  test("a definition round-trips through the form unchanged", () => {
    const loaded = formOf(definition());
    const built = buildDefinition(loaded, true);
    expect(built.ok && built.definition).toEqual(definition());
  });

  test("a stored schedule with seconds fills the datetime field; an absolute one is flagged", () => {
    expect(
      formOf(
        definition({
          schedule: { timeBasis: "store_local", startsAt: "2026-11-20T09:00:30", endsAt: null },
        }),
      ).startsAt,
    ).toBe("2026-11-20T09:00");
    const absolute = formOf(
      definition({
        schedule: { timeBasis: "absolute", startsAt: "2026-11-20T09:00:00Z", endsAt: null },
      }),
    );
    expect(absolute.scheduleWasAbsolute).toBe(true);
  });

  test("dirty is any difference from what was loaded", () => {
    const base = formOf(definition());
    expect(isDirty(base, formOf(definition()))).toBe(false);
    expect(isDirty(base, { ...base, nameAr: "غير" })).toBe(true);
    expect(isDirty(base, { ...base, exclude: { ...base.exclude, productIds: [] } })).toBe(true);
  });
});
