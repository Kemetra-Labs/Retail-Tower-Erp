import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TENANT_ID } from "./branding-fixtures";
import { readSource } from "./source-scan";

/**
 * RT-474 entry: the «هوية المؤسسة» link on the tenant page, for an owner or
 * tenant_admin of that (the active) tenant only. Other roles get no link; the
 * route itself answers them with the no-access screen (branding-page.test).
 */
const ctx = vi.hoisted(() => ({ role: "owner" as string, tenant: "" }));
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { active_tenant: { id: ctx.tenant }, active_role_code: ctx.role },
  }),
}));

import { TenantBrandingLink } from "@/branding/TenantBrandingLink";
import { canManageLogo } from "@/branding/brandingAccess";
import { setLocale } from "@/i18n/locale";

beforeEach(() => {
  setLocale("ar");
  ctx.role = "owner";
  ctx.tenant = TENANT_ID;
});
afterEach(cleanup);

const renderLink = () =>
  render(
    <MemoryRouter>
      <TenantBrandingLink tenantId={TENANT_ID} />
    </MemoryRouter>,
  );

describe("tenant page entry", () => {
  test("only owner and tenant_admin may manage the logo", () => {
    expect(canManageLogo("owner")).toBe(true);
    expect(canManageLogo("tenant_admin")).toBe(true);
    for (const role of ["store_manager", "store_staff", "platform_admin", "", null, undefined]) {
      expect(canManageLogo(role)).toBe(false);
    }
  });

  test.each(["owner", "tenant_admin"])("%s sees the link to the branding route", (role) => {
    ctx.role = role;
    renderLink();
    const link = screen.getByRole("link", { name: "هوية المؤسسة" });
    expect(link.getAttribute("href")).toBe(`/tenants/${TENANT_ID}/branding`);
  });

  test.each(["store_manager", "store_staff"])("%s gets no link", (role) => {
    ctx.role = role;
    renderLink();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("an owner viewing another tenant gets no link", () => {
    ctx.tenant = "0190f000-0000-7000-8000-0000000000ff";
    renderLink();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("the tenant page renders the link and the route is registered", () => {
    expect(readSource("src/tenants/TenantDetail.tsx")).toMatch(
      /<TenantBrandingLink tenantId=\{tenant\.id\} \/>/,
    );
    expect(readSource("src/shell/rf2Routes.tsx")).toContain('path="tenants/:tenantId/branding"');
  });
});
