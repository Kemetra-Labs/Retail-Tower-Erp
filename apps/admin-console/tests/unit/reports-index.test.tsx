import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ctx } from "./sale-fixtures";

const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { ReportsIndex } from "@/reports/ReportsIndex";

/**
 * RT-1020 (v4.0) the reports index: the built report and the review screens are
 * live links, each only for a role that can open it; every proposed report says
 * «not available yet» in words, is not a link, and carries no figure.
 */

const PROPOSED = [
  "Sales by hour",
  "Shortage and overage trend",
  "Stock movement by type",
  "Posting health across days",
];

function renderIndex(): void {
  render(
    <MemoryRouter>
      <ReportsIndex />
    </MemoryRouter>,
  );
}

function hrefOf(name: string): string | null {
  return screen.getByRole("link", { name }).getAttribute("href");
}

describe("ReportsIndex (RT-1020)", () => {
  beforeEach(() => {
    activeContext.mockReset();
    activeContext.mockReturnValue(ctx("owner", "t1"));
  });
  afterEach(cleanup);

  test("an owner gets the built report and the three review screens as live links", () => {
    renderIndex();
    expect(screen.getByRole("heading", { level: 1, name: "Reports" })).toBeDefined();
    expect(hrefOf("Daily received sales")).toBe("/sales-daily");
    expect(hrefOf("Sales by store")).toBe("/sales-by-store");
    expect(hrefOf("Cash variance in shifts")).toBe("/shift-closes");
    expect(hrefOf("ERPNext stock discrepancies")).toBe("/stock-discrepancies");
    expect(hrefOf("Sales needing repair")).toBe("/sales-needing-repair");
  });

  test("four groups, each a named section with its decorative index", () => {
    renderIndex();
    for (const name of ["Sales", "Cash and shifts", "Inventory", "ERPNext integration"]) {
      expect(screen.getByRole("region", { name })).toBeDefined();
    }
    const badges = Array.from(document.querySelectorAll(".section-index"), (b) => b.textContent);
    expect(badges).toEqual(["01", "02", "03", "04"]);
    for (const badge of document.querySelectorAll(".section-index")) {
      expect(badge.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("each proposed report says it is not available yet, in text, with no link and no figure", () => {
    renderIndex();
    const marked = screen.getAllByText("Proposed, not available yet");
    expect(marked).toHaveLength(PROPOSED.length);
    for (const title of PROPOSED) {
      expect(screen.queryByRole("link", { name: new RegExp(title, "i") })).toBeNull();
      const card = screen.getByText(title).closest("[data-report]") as HTMLElement;
      expect(card.tagName).not.toBe("A");
      expect(card.querySelector("a, button, [tabindex]")).toBeNull();
      expect(card.textContent).toContain("Proposed, not available yet");
      // No figure of any kind: the card holds words only.
      expect(card.textContent).not.toMatch(/\d/);
    }
  });

  test("the band carries no facts: the catalogue's counts are not served figures", () => {
    renderIndex();
    expect(document.querySelector(".list-band__facts")).toBeNull();
  });

  test("a store manager sees the screens its role opens, not the tenant-admin repair queue", () => {
    activeContext.mockReturnValue(ctx("store_manager", "t1"));
    renderIndex();
    expect(hrefOf("Daily received sales")).toBe("/sales-daily");
    expect(hrefOf("Sales by store")).toBe("/sales-by-store");
    expect(hrefOf("Cash variance in shifts")).toBe("/shift-closes");
    expect(screen.queryByRole("link", { name: "Sales needing repair" })).toBeNull();
    // Its proposed sibling is still listed, as not available.
    expect(screen.getAllByText("Proposed, not available yet")).toHaveLength(PROPOSED.length);
  });

  test("a role that can open nothing sees no link and says so", () => {
    activeContext.mockReturnValue(ctx("store_staff", "t1"));
    renderIndex();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText(/no report or review screen/i)).toBeDefined();
  });

  test("no active tenant: the scope prompt only", () => {
    activeContext.mockReturnValue(ctx("owner", null));
    renderIndex();
    expect(screen.getByText(/select a tenant/i)).toBeDefined();
    expect(within(document.body).queryByRole("heading", { level: 2 })).toBeNull();
  });
});
