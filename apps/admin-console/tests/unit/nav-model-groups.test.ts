import { tenantNav } from "@/shell/nav-model";
import { describe, expect, test } from "vitest";

/**
 * RT-1291 (from RT-1289 F1): the first sidebar group was ten entries with no
 * heading. It is now two headed groups, "Daily" and "Stock and items". Only the
 * grouping changes: every role sees the same entries, in the same relative order.
 */

// RT-455 part 1: the tracking entry needs the tracked-selling switch on too.
const SIGNALS = { hasTrackedProducts: true, trackedSellingOn: true } as const;
const paths = (
  role: string,
  signals: { hasTrackedProducts?: boolean; trackedSellingOn?: boolean } = SIGNALS,
) => tenantNav(role, false, signals).flatMap((g) => g.entries.map((e) => e.to));

describe("tenant navigation groups (RT-1291)", () => {
  test("an owner sees four groups, the first two with the new headings", () => {
    const groups = tenantNav("owner", false, SIGNALS);
    expect(groups.map((g) => g.id)).toEqual(["daily", "stock", "integration", "management"]);
    expect(groups.map((g) => g.heading)).toEqual([
      "shell.nav.section.daily",
      "shell.nav.section.stock",
      "erp.nav.section",
      "shell.nav.section.management",
    ]);
  });

  test("Daily and Stock and items hold the approved entries, in their old relative order", () => {
    const groups = tenantNav("owner", false, SIGNALS);
    const entries = (id: string) => groups.find((g) => g.id === id)?.entries.map((e) => e.to);
    expect(entries("daily")).toEqual(["/", "/sales", "/shift-closes", "/reports", "/devices"]);
    expect(entries("stock")).toEqual([
      "/catalog/products",
      "/unknown-items",
      "/inventory",
      "/tracking",
      "/stock-discrepancies",
    ]);
  });

  test("Integration and Management are unchanged", () => {
    const groups = tenantNav("owner", false, SIGNALS);
    const entries = (id: string) => groups.find((g) => g.id === id)?.entries.map((e) => e.to);
    expect(entries("integration")).toEqual([
      "/erp-connection",
      "/sales-needing-repair",
      "/product-reconciliation",
      "/audit",
    ]);
    expect(entries("management")).toEqual(["/stores", "/operators", "/tenants", "/payer-accounts"]);
  });

  test("a role sees the same set of entries as before; only the grouping changed", () => {
    expect(paths("owner")).toHaveLength(18);
    expect(paths("tenant_admin")).toHaveLength(18);
    expect(paths("store_manager")).toHaveLength(14);
    expect(paths("cashier")).toEqual(["/", "/audit", "/stores", "/operators", "/tenants"]);
  });

  test("tracking stays hidden until the tenant has tracked products", () => {
    expect(paths("owner", {})).not.toContain("/tracking");
    expect(paths("owner", { hasTrackedProducts: false })).not.toContain("/tracking");
    expect(paths("owner", { hasTrackedProducts: true, trackedSellingOn: false })).not.toContain(
      "/tracking",
    );
    expect(paths("owner", {})).toHaveLength(17);
  });

  test("a group left with no entry is dropped, and a support session lists no tenant group", () => {
    const groupIds = (role: string) => tenantNav(role, false, SIGNALS).map((g) => g.id);
    // A role with no daily-operations entry still has Overview, so Daily stays; Stock goes.
    expect(groupIds("cashier")).toEqual(["daily", "integration", "management"]);
    expect(tenantNav("owner", true, SIGNALS).map((g) => g.id)).toEqual(["platform"]);
  });
});
