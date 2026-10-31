import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";

const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { AppShell } from "@/shell/AppShell";

function renderShell(role: string): HTMLElement {
  activeContext.mockReturnValue({
    context: {
      user: { display_name: "Amal Saleh" },
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: null,
      active_role_code: role,
      memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail" }],
    },
    switchTenant: vi.fn(),
    switchStore: vi.fn(),
    clearStore: vi.fn(),
  });
  render(
    <MemoryRouter>
      <AppShell onSignOut={() => {}} />
    </MemoryRouter>,
  );
  return screen.getByRole("navigation", { name: "Primary" });
}

function entryLabels(nav: HTMLElement): string[] {
  return Array.from(nav.querySelectorAll(".nav-entry__label")).map((el) => el.textContent ?? "");
}

/**
 * RT-969: the heading of the canvas group a link sits in; "" for the first,
 * daily-operations group, which has none.
 */
function groupOf(nav: HTMLElement, link: string): string {
  const group = within(nav).getByRole("link", { name: link }).closest(".nav-group");
  if (!group) throw new Error(`${link} is not in a nav group`);
  return group.querySelector(".nav-section")?.textContent ?? "";
}

/** The entries of the group under `heading`. */
function groupLabels(nav: HTMLElement, heading: string): string[] {
  const section = within(nav).getByText(heading, { selector: ".nav-section" });
  const group = section.closest(".nav-group") as HTMLElement;
  return entryLabels(group);
}

/**
 * RT-270 (UX-09: no dead destinations). A production build lists only live
 * destinations. The dev-only RF-* placeholders are gone (RT-765 removed the last).
 */
describe("production navigation", () => {
  test("production nav lists only live destinations", () => {
    const nav = renderShell("owner");
    // RT-969: grouped as on the owner-approved canvas.
    expect(entryLabels(nav)).toEqual([
      "Overview",
      "Sales",
      "Items",
      "Unknown items",
      "Stock movements",
      "Stock discrepancies",
      "Shift closes",
      "Reports",
      "Devices",
      "Connection & sync",
      "Sales needing repair",
      "Product reconciliation",
      "Audit",
      "Stores",
      "Operators",
      "Tenants",
      "Payer accounts",
      "Sign out",
    ]);
    expect(Array.from(nav.querySelectorAll(".nav-section"), (h) => h.textContent)).toEqual([
      "Integration",
      "Management",
    ]);
    expect(nav.querySelector("[aria-disabled='true']")).toBeNull();
    expect(within(nav).queryByText(/^RF-/)).toBeNull();
  });

  test.each(["owner", "tenant_admin", "store_manager"])(
    "RT-18: the shift-close review is listed for %s",
    (role) => {
      expect(entryLabels(renderShell(role))).toContain("Shift closes");
    },
  );

  test.each(["owner", "tenant_admin", "store_manager"])(
    "RT-1020: the reports index is listed for %s, and opens /reports",
    (role) => {
      const nav = renderShell(role);
      expect(entryLabels(nav)).toContain("Reports");
      expect(within(nav).getByRole("link", { name: "Reports" }).getAttribute("href")).toBe(
        "/reports",
      );
    },
  );

  test("RT-1020: a role that can open no report or review screen gets no reports entry", () => {
    expect(entryLabels(renderShell("store_staff"))).not.toContain("Reports");
  });

  test.each(["owner", "tenant_admin", "store_manager"])(
    "RT-728: the inventory read views are listed for %s",
    (role) => {
      expect(entryLabels(renderShell(role))).toContain("Stock movements");
    },
  );

  test("RT-728: the inventory read views are hidden from other roles", () => {
    expect(entryLabels(renderShell("cashier"))).not.toContain("Stock movements");
  });

  test("RT-18: the shift-close review is hidden from roles the API refuses", () => {
    expect(entryLabels(renderShell("cashier"))).not.toContain("Shift closes");
  });

  // RT-560 / RT-557 OD-2: one entry in its own "Integration" section, for the
  // roles the API lets read the ERP connection & sync status.
  test.each(["owner", "tenant_admin"])(
    "RT-560: %s sees Connection & sync in its section",
    (role) => {
      const nav = renderShell(role);
      expect(
        within(nav).getByRole("link", { name: "Connection & sync" }).getAttribute("href"),
      ).toBe("/erp-connection");
      expect(within(nav).getByText("Integration").className).toBe("nav-section");
    },
  );

  // RT-969: the Integration heading also holds the audit log, so for these
  // roles it is left with Audit alone.
  test.each(["store_manager", "cashier", "auditor"])("RT-560: %s has no entry", (role) => {
    const nav = renderShell(role);
    expect(entryLabels(nav)).not.toContain("Connection & sync");
    expect(groupLabels(nav, "Integration")).toEqual(["Audit"]);
  });

  // RT-726: the NEEDS_REPAIR queue shares the "Integration" heading (one
  // heading, not two), for the roles the sale sync-ops API serves.
  test.each(["owner", "tenant_admin"])(
    "RT-726: %s sees Sales needing repair under the one Integration heading",
    (role) => {
      const nav = renderShell(role);
      expect(
        within(nav).getByRole("link", { name: "Sales needing repair" }).getAttribute("href"),
      ).toBe("/sales-needing-repair");
      expect(within(nav).getAllByText("Integration")).toHaveLength(1);
    },
  );

  test.each(["store_manager", "store_staff", "cashier", "auditor"])(
    "RT-726: %s has no Sales needing repair entry",
    (role) => {
      expect(entryLabels(renderShell(role))).not.toContain("Sales needing repair");
    },
  );

  // RT-727: product reconciliation joins the Integration section (one heading),
  // for the roles the API lets use it (all five ops are owner / tenant_admin).
  test.each(["owner", "tenant_admin"])(
    "RT-727: %s sees Product reconciliation under the one Integration heading",
    (role) => {
      const nav = renderShell(role);
      expect(
        within(nav).getByRole("link", { name: "Product reconciliation" }).getAttribute("href"),
      ).toBe("/product-reconciliation");
      expect(within(nav).getAllByText("Integration")).toHaveLength(1);
    },
  );

  test.each(["store_manager", "store_staff", "cashier", "auditor"])(
    "RT-727: %s has no Product reconciliation entry",
    (role) => {
      expect(entryLabels(renderShell(role))).not.toContain("Product reconciliation");
    },
  );

  // RT-371: the device registry, for the roles the RT-365 API lets read it;
  // RT-969 lists it with the daily operations, as on the canvas.
  test.each(["owner", "tenant_admin", "store_manager"])(
    "RT-371: %s sees Devices in its section",
    (role) => {
      const nav = renderShell(role);
      expect(within(nav).getByRole("link", { name: "Devices" }).getAttribute("href")).toBe(
        "/devices",
      );
      expect(groupOf(nav, "Devices")).toBe("");
    },
  );

  test.each(["store_staff", "cashier", "auditor"])("RT-371: %s has no Devices entry", (role) => {
    const nav = renderShell(role);
    expect(entryLabels(nav)).not.toContain("Devices");
  });

  // RT-587 (spec 012 FR-012 / OD-556-3): Sales, only for the roles the console
  // sales read serves; RT-969 lists it right after Overview, as on the canvas.
  test.each(["owner", "tenant_admin", "store_manager"])(
    "RT-587: %s sees Sales in its section",
    (role) => {
      const nav = renderShell(role);
      expect(within(nav).getByRole("link", { name: "Sales" }).getAttribute("href")).toBe("/sales");
      expect(groupOf(nav, "Sales")).toBe("");
      expect(entryLabels(nav).indexOf("Sales")).toBe(1);
    },
  );

  test.each(["store_staff", "cashier", "auditor"])("RT-587: %s has no Sales entry", (role) => {
    const nav = renderShell(role);
    expect(entryLabels(nav)).not.toContain("Sales");
  });

  // RT-421: payer accounts, for owner / tenant_admin only (both payer routes are
  // `@Roles("owner", "tenant_admin")`); RT-969 lists them under Management.
  test.each(["owner", "tenant_admin"])("RT-421: %s sees Payer accounts in its section", (role) => {
    const nav = renderShell(role);
    expect(within(nav).getByRole("link", { name: "Payer accounts" }).getAttribute("href")).toBe(
      "/payer-accounts",
    );
    expect(groupOf(nav, "Payer accounts")).toBe("Management");
  });

  test.each(["store_manager", "store_staff", "cashier", "auditor"])(
    "RT-421: %s has no Payer accounts entry",
    (role) => {
      const nav = renderShell(role);
      expect(entryLabels(nav)).not.toContain("Payer accounts");
      expect(within(nav).queryByText("Payers")).toBeNull();
    },
  );

  test("RT-421: no navigation entry leads to the retired receivables screens", () => {
    for (const role of ["owner", "tenant_admin", "store_manager"]) {
      const nav = renderShell(role);
      expect(entryLabels(nav).join("|")).not.toMatch(/receivable|claim|remittance|apply payment/i);
      for (const link of within(nav).queryAllByRole("link")) {
        expect(link.getAttribute("href")).not.toMatch(/receivables|claims|apply-payment/);
      }
      cleanup();
    }
  });

  // RT-765 (RT-752 AC 2): «الأصناف» comes right before the unknown-items queue,
  // for the roles the catalog read API serves, and stays selected on its child
  // routes. RT-969 lists both with the daily operations, as on the canvas.
  test.each(["owner", "tenant_admin", "store_manager"])(
    "RT-765: %s sees Items first in the Catalog section",
    (role) => {
      const nav = renderShell(role);
      const items = within(nav).getByRole("link", { name: "Items" });
      expect(items.getAttribute("href")).toBe("/catalog/products");
      const labels = entryLabels(nav);
      expect(labels.indexOf("Items")).toBe(labels.indexOf("Unknown items") - 1);
      expect(groupOf(nav, "Items")).toBe("");
    },
  );

  test.each(["store_staff", "cashier", "auditor"])("RT-765: %s has no Items entry", (role) => {
    expect(entryLabels(renderShell(role))).not.toContain("Items");
  });

  // RT-724: the unknown-items queue left the RF-4 gate, for the roles the list
  // API serves (RT-969: with the daily operations, beside the catalog items).
  test.each(["owner", "tenant_admin", "store_manager"])(
    "RT-724: %s sees Unknown items in its section",
    (role) => {
      const nav = renderShell(role);
      expect(within(nav).getByRole("link", { name: "Unknown items" }).getAttribute("href")).toBe(
        "/unknown-items",
      );
      expect(groupOf(nav, "Unknown items")).toBe("");
    },
  );

  test.each(["store_staff", "cashier", "auditor"])(
    "RT-724: %s has no Unknown items entry",
    (role) => {
      const nav = renderShell(role);
      expect(entryLabels(nav)).not.toContain("Unknown items");
    },
  );
});
