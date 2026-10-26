import {
  availabilityChoiceOf,
  buildOverrideBody,
  canOverrideTax,
  canRetireOverride,
  canWriteOverrides,
  expectedUpdatedAtOf,
  isActiveOf,
  mapOverrideWriteError,
  mergeOverrideReload,
  overrideOf,
  overrideTaxError,
  overrideValuesOf,
} from "@/catalog/storeOverrideLogic";
import type { CatalogStoreOverride } from "@/lib/catalog-queries";
import { describe, expect, test } from "vitest";
import { CAIRO_STORE, NEW_YORK_STORE, override } from "./catalog-fixtures";

/**
 * RT-770 pure rules of the store-override drawer (CAT-C2c): the availability
 * tri-state on the wire, the role-shaped controls (O-4), the body (only what
 * changed, never a price), the reload merge, and where each failure goes.
 */
const ov = (over: Record<string, unknown> = {}) => override(over) as CatalogStoreOverride;
const NONE = { availability: "inherit", taxCategory: "" } as const;

describe("the availability tri-state", () => {
  test("follow the tenant is null on the wire; available is true; not available is false", () => {
    expect(isActiveOf("inherit")).toBeNull();
    expect(isActiveOf("available")).toBe(true);
    expect(isActiveOf("unavailable")).toBe(false);
  });

  test("a stored value reads back as its choice", () => {
    expect(availabilityChoiceOf(null)).toBe("inherit");
    expect(availabilityChoiceOf(true)).toBe("available");
    expect(availabilityChoiceOf(false)).toBe("unavailable");
  });

  test("no override is follow the tenant for both fields, with a null precondition", () => {
    expect(overrideValuesOf(null)).toEqual(NONE);
    expect(expectedUpdatedAtOf(null)).toBeNull();
  });

  test("an override reads as its raw fields, its precondition is its updatedAt", () => {
    const o = ov({ isActive: false, taxCategory: "zero" });
    expect(overrideValuesOf(o)).toEqual({ availability: "unavailable", taxCategory: "zero" });
    expect(expectedUpdatedAtOf(o)).toBe("2026-10-05T09:00:00Z");
  });

  test("the override of one store, or null", () => {
    const list = [ov(), ov({ storeId: NEW_YORK_STORE, isActive: true })];
    expect(overrideOf(list, NEW_YORK_STORE)?.isActive).toBe(true);
    expect(overrideOf([], CAIRO_STORE)).toBeNull();
  });
});

describe("role-shaped controls (O-4)", () => {
  test.each([
    ["owner", true, true],
    ["tenant_admin", true, true],
    ["store_manager", true, false],
    ["cashier", false, false],
    [null, false, false],
  ] as const)("%s: writes overrides %s, sets tax %s", (role, writes, tax) => {
    expect(canWriteOverrides(role)).toBe(writes);
    expect(canOverrideTax(role)).toBe(tax);
  });

  test("store_manager may retire an override only when it has no tax category", () => {
    expect(canRetireOverride("store_manager", ov({ isActive: false }))).toBe(true);
    expect(canRetireOverride("store_manager", ov({ taxCategory: "zero" }))).toBe(false);
    expect(canRetireOverride("owner", ov({ taxCategory: "zero" }))).toBe(true);
    expect(canRetireOverride("tenant_admin", ov({ taxCategory: "zero" }))).toBe(true);
  });

  test("there is nothing to retire without an override, and no role outside the list retires", () => {
    expect(canRetireOverride("owner", null)).toBe(false);
    expect(canRetireOverride("cashier", ov())).toBe(false);
  });
});

describe("the upsert body: expectedUpdatedAt plus only what changed", () => {
  test("nothing changed: nothing is sent", () => {
    expect(buildOverrideBody(NONE, NONE, null, true)).toBeNull();
  });

  test.each([
    ["inherit", null],
    ["available", true],
    ["unavailable", false],
  ] as const)("availability %s sends isActive %s", (choice, wire) => {
    const base = { availability: "available", taxCategory: "" } as const;
    const typed = { ...base, availability: choice };
    if (choice === "available") {
      expect(buildOverrideBody(base, typed, "t0", true)).toBeNull();
      return;
    }
    expect(buildOverrideBody(base, typed, "t0", true)).toEqual({
      expectedUpdatedAt: "t0",
      isActive: wire,
    });
  });

  test("a new override carries a null precondition", () => {
    expect(buildOverrideBody(NONE, { ...NONE, availability: "unavailable" }, null, true)).toEqual({
      expectedUpdatedAt: null,
      isActive: false,
    });
  });

  test("a tax category is sent trimmed at the ends (D5); spaces alone are no edit", () => {
    const base = { availability: "inherit", taxCategory: "zero" } as const;
    expect(buildOverrideBody(NONE, { ...NONE, taxCategory: "  reduced " }, null, true)).toEqual({
      expectedUpdatedAt: null,
      taxCategory: "reduced",
    });
    expect(buildOverrideBody(base, { ...base, taxCategory: " zero " }, "t0", true)).toBeNull();
  });

  test("an emptied tax category clears it with null (the store follows the tenant)", () => {
    const base = { availability: "inherit", taxCategory: "zero" } as const;
    expect(buildOverrideBody(base, { ...base, taxCategory: "   " }, "t0", true)).toEqual({
      expectedUpdatedAt: "t0",
      taxCategory: null,
    });
  });

  test("a role that may not set tax never sends the key, even if the value changed", () => {
    const typed = { availability: "unavailable", taxCategory: "zero" } as const;
    const body = buildOverrideBody(NONE, typed, null, false);
    expect(body).toEqual({ expectedUpdatedAt: null, isActive: false });
    expect(body && "taxCategory" in body).toBe(false);
  });

  test("the body never carries a price", () => {
    const body = buildOverrideBody(
      NONE,
      { availability: "available", taxCategory: "x" },
      null,
      true,
    );
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "expectedUpdatedAt",
      "isActive",
      "taxCategory",
    ]);
  });

  test("a tax category over 50 characters is prevented; empty is allowed", () => {
    expect(overrideTaxError({ ...NONE, taxCategory: "x".repeat(51) })).toBe(
      "catalog.override.error.taxCategoryTooLong",
    );
    expect(overrideTaxError({ ...NONE, taxCategory: ` ${"x".repeat(50)} ` })).toBeUndefined();
    expect(overrideTaxError(NONE)).toBeUndefined();
  });
});

describe("stale write: the reload keeps what the person changed", () => {
  test("a changed field keeps the typed value; an untouched one takes the fresh value", () => {
    const oldBase = { availability: "inherit", taxCategory: "" } as const;
    const typed = { availability: "unavailable", taxCategory: "" } as const;
    const fresh = { availability: "available", taxCategory: "reduced" } as const;
    expect(mergeOverrideReload(oldBase, typed, fresh)).toEqual({
      availability: "unavailable",
      taxCategory: "reduced",
    });
  });
});

describe("where each failure goes", () => {
  const map = (op: "upsert" | "retire", status: number, code?: string) =>
    mapOverrideWriteError({ op, status, code, requestId: "r1" });

  test("409 stale_write is a stale conflict for both writes", () => {
    expect(map("upsert", 409, "stale_write")).toEqual({ kind: "stale", requestId: "r1" });
    expect(map("retire", 409, "stale_write")).toEqual({ kind: "stale", requestId: "r1" });
  });

  test("409 product_retired: the item is retired", () => {
    expect(map("upsert", 409, "product_retired")).toEqual({ kind: "retired", requestId: "r1" });
  });

  test("422 override_empty: offer to retire instead", () => {
    expect(map("upsert", 422, "override_empty")).toEqual({ kind: "empty", requestId: "r1" });
  });

  test("409 price_override_present: the store price is kept (a warning, not a failure of input)", () => {
    expect(map("retire", 409, "price_override_present")).toEqual({
      kind: "banner",
      variant: "warning",
      messageKey: "catalog.override.error.pricePresent",
      requestId: "r1",
    });
  });

  test.each([
    [400, "validation_error", "catalog.override.error.validation"],
    [401, "unauthorized", "catalog.write.error.session"],
    [403, "tax_override_forbidden", "catalog.override.error.taxForbidden"],
    [403, "origin_rejected", "catalog.write.error.origin"],
    [403, "forbidden", "catalog.override.error.forbidden"],
    [404, "not_found", "catalog.override.error.notFound"],
    [409, "other", "catalog.override.error.conflict"],
    [429, "rate_limited", "catalog.write.error.rateLimited"],
    [500, "internal_error", "catalog.write.error.server"],
  ] as const)("%i %s → %s", (status, code, key) => {
    const render = map("upsert", status, code);
    expect(render.kind).toBe("banner");
    expect(render.kind === "banner" && render.messageKey).toBe(key);
    expect(render.requestId).toBe("r1");
  });
});
