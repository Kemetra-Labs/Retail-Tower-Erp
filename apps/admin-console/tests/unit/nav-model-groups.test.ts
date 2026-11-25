import { navigatorNav, tenantNav } from "@/shell/nav-model";
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
) => tenantNav(role, signals).flatMap((g) => g.entries.map((e) => e.to));

describe("tenant navigation groups (RT-1291)", () => {
  test("an owner sees four groups, the first two with the new headings", () => {
    const groups = tenantNav("owner", SIGNALS);
    expect(groups.map((g) => g.id)).toEqual(["daily", "stock", "integration", "management"]);
    expect(groups.map((g) => g.heading)).toEqual([
      "shell.nav.section.daily",
      "shell.nav.section.stock",
      "erp.nav.section",
      "shell.nav.section.management",
    ]);
  });

  test("Daily and Stock and items hold the approved entries, in their old relative order", () => {
    const groups = tenantNav("owner", SIGNALS);
    const entries = (id: string) => groups.find((g) => g.id === id)?.entries.map((e) => e.to);
    expect(entries("daily")).toEqual(["/", "/sales", "/shift-closes", "/reports", "/devices"]);
    expect(entries("stock")).toEqual([
      "/catalog/products",
      "/unknown-items",
      "/catalog/brands",
      "/inventory",
      "/tracking",
      "/stock-discrepancies",
    ]);
  });

  test("Integration and Management are unchanged", () => {
    const groups = tenantNav("owner", SIGNALS);
    const entries = (id: string) => groups.find((g) => g.id === id)?.entries.map((e) => e.to);
    expect(entries("integration")).toEqual([
      "/erp-connection",
      "/sales-needing-repair",
      "/quarantined-sales",
      "/product-reconciliation",
      "/audit",
    ]);
    expect(entries("management")).toEqual([
      "/stores",
      "/operators",
      "/tenants",
      "/payer-accounts",
      "/vouchers",
      "/offers",
      "/settings",
    ]);
  });

  test("a role sees the same set of entries as before; only the grouping changed", () => {
    // RT-1109 added Vouchers for owner and tenant_admin; RT-1338 added Brands and Offers;
    // RT-1312 added the sale quarantine queue.
    expect(paths("owner")).toHaveLength(23);
    expect(paths("tenant_admin")).toHaveLength(23);
    expect(paths("store_manager")).toHaveLength(16);
    expect(paths("cashier")).toEqual(["/", "/audit", "/stores", "/operators", "/tenants"]);
  });

  test("tracking stays hidden until the tenant has tracked products", () => {
    expect(paths("owner", {})).not.toContain("/tracking");
    expect(paths("owner", { hasTrackedProducts: false })).not.toContain("/tracking");
    expect(paths("owner", { hasTrackedProducts: true, trackedSellingOn: false })).not.toContain(
      "/tracking",
    );
    expect(paths("owner", {})).toHaveLength(22);
  });

  test("RT-1468: a platform admin gets the platform directory as the last group; nobody else does", () => {
    const last = tenantNav("owner", { ...SIGNALS, platformAdmin: true }).at(-1);
    expect(last?.id).toBe("platform");
    expect(last?.entries.map((e) => e.to)).toEqual(["/platform/tenants"]);
    expect(tenantNav("owner", SIGNALS).some((g) => g.id === "platform")).toBe(false);
  });

  test("a group left with no entry is dropped", () => {
    const groupIds = (role: string) => tenantNav(role, SIGNALS).map((g) => g.id);
    // A role with no daily-operations entry still has Overview, so Daily stays; Stock goes.
    expect(groupIds("cashier")).toEqual(["daily", "integration", "management"]);
  });
});

/** RF-7 (spec 016): the Settings destination, for the tenant's admins only. */
describe("settings destination (RF-7)", () => {
  test("owner and tenant_admin see Settings last in Management", () => {
    for (const role of ["owner", "tenant_admin"]) {
      const groups = tenantNav(role, SIGNALS);
      const management = groups.find((g) => g.id === "management")?.entries.map((e) => e.to);
      expect(management?.at(-1)).toBe("/settings");
    }
  });

  test("other roles get no Settings entry", () => {
    for (const role of ["store_manager", "store_staff", "cashier", "auditor"]) {
      expect(paths(role)).not.toContain("/settings");
    }
  });
});

/**
 * Navigator-only destinations: built screens the sidebar deliberately omits
 * by owner decision — the daily/by-store reports live under /reports
 * (RT-821/RT-1020/RT-1054), the import opens from the catalog list (RT-1509),
 * pairing codes and the POS download live on the device list (RT-372).
 * The sidebar and drawer never list them; Ctrl K does, with the same gates.
 */
describe("navigator-only destinations", () => {
  const NAV_ONLY = [
    "/sales-daily",
    "/sales-by-store",
    "/catalog/import",
    "/devices/pairing-codes",
    "/devices/download-pos",
  ] as const;
  const navPaths = (role: string) =>
    navigatorNav(role, SIGNALS).flatMap((g) => g.entries.map((e) => e.to));

  test("the sidebar model is unchanged: none of the five is listed", () => {
    expect(paths("owner")).toHaveLength(23);
    for (const to of NAV_ONLY) expect(paths("owner")).not.toContain(to);
  });

  test("an owner's navigator is the sidebar entries plus the five, in group order", () => {
    expect(navPaths("owner")).toEqual([
      "/",
      "/sales",
      "/shift-closes",
      "/reports",
      "/sales-daily",
      "/sales-by-store",
      "/devices",
      "/devices/pairing-codes",
      "/devices/download-pos",
      "/catalog/products",
      "/catalog/import",
      "/unknown-items",
      "/catalog/brands",
      "/inventory",
      "/tracking",
      "/stock-discrepancies",
      "/erp-connection",
      "/sales-needing-repair",
      "/quarantined-sales",
      "/product-reconciliation",
      "/audit",
      "/stores",
      "/operators",
      "/tenants",
      "/payer-accounts",
      "/vouchers",
      "/offers",
      "/settings",
    ]);
  });

  test("the gates hold: a cashier sees none of the five, a store manager sees all but the import", () => {
    expect(navPaths("cashier")).toEqual(paths("cashier"));
    expect(navPaths("store_manager")).toHaveLength(20);
    for (const to of [
      "/sales-daily",
      "/sales-by-store",
      "/devices/pairing-codes",
      "/devices/download-pos",
    ]) {
      expect(navPaths("store_manager")).toContain(to);
    }
    expect(navPaths("store_manager")).not.toContain("/catalog/import");
  });
});
