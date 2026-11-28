import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  tenant: "t1" as string | null,
  role: "owner" as string,
}));
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: ctx.tenant
      ? {
          active_tenant: { id: ctx.tenant, name: "Northstar Retail" },
          active_role_code: ctx.role,
        }
      : { active_tenant: null },
  }),
}));
// The sections are covered by their own suites; the page only gathers them.
vi.mock("@/branding/TenantBrandingLink", () => ({
  TenantBrandingLink: () => <p>branding-section</p>,
}));
vi.mock("@/cash-policy/TenantPolicySection", () => ({
  TenantPolicySection: () => <p>policy-section</p>,
}));
vi.mock("@/ai-entitlements/TenantAiPlanSection", () => ({
  TenantAiPlanSection: () => <p>ai-plan-section</p>,
}));
vi.mock("@/tracked-selling/TenantTrackedSellingSection", () => ({
  TenantTrackedSellingSection: () => <p>tracked-selling-section</p>,
}));

import { SettingsPage } from "@/settings/SettingsPage";

beforeEach(() => {
  ctx.tenant = "t1";
  ctx.role = "owner";
});
afterEach(cleanup);

function renderPage(): void {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

/** RF-7 (spec 016): the Settings destination gathers the tenant sections. */
describe("SettingsPage", () => {
  test("gathers the tenant sections for the active tenant", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeDefined();
    for (const marker of [
      "branding-section",
      "policy-section",
      "ai-plan-section",
      "tracked-selling-section",
    ]) {
      expect(screen.getByText(marker)).toBeDefined();
    }
    expect(screen.getByRole("link", { name: "My account" }).getAttribute("href")).toBe("/account");
    // Modern concept (Settings & Devices): the two destinations sit in one
    // quick-links bar at the top; each inline section sits in its own card.
    expect(screen.getByRole("heading", { level: 2, name: "Quick links" })).toBeDefined();
    expect(document.querySelectorAll(".settings-card")).toHaveLength(3);
  });

  test("a role with no AI-plan view gets no AI-plan card", () => {
    ctx.role = "store_staff";
    renderPage();
    expect(screen.queryByText("ai-plan-section")).toBeNull();
    expect(document.querySelectorAll(".settings-card")).toHaveLength(2);
  });

  test("without an active tenant it points at the tenant list", () => {
    ctx.tenant = null;
    renderPage();
    expect(screen.getByText("Choose a tenant first to see its settings.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Tenants" }).getAttribute("href")).toBe("/tenants");
    expect(screen.queryByText("branding-section")).toBeNull();
  });
});
