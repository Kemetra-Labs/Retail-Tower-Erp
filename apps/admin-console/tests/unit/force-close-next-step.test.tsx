import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { ForceCloseNextStep, blockedByOpenShift } from "@/force-actions/ForceCloseNextStep";
import { OpenShiftsLink } from "@/force-actions/OpenShiftsLink";

/**
 * RT-1440 (U1) AC4: the device panel's next step is shown to an owner or tenant_admin only, never
 * inside a support session, and only for the two block codes that clear when the shift closes.
 */

const STORE = "0198a0c4-0000-7000-8000-000000000a01";
const asContext = (
  role: string | null,
  supportSession: unknown = null,
  isPlatformAdmin = false,
) => ({
  context: {
    active_tenant: { id: "t1" },
    active_role_code: role,
    support_session: supportSession,
    user: { is_platform_admin: isPlatformAdmin },
  },
});

function renderStep(): void {
  render(
    <MemoryRouter>
      <ForceCloseNextStep storeId={STORE} />
    </MemoryRouter>,
  );
}

describe("ForceCloseNextStep", () => {
  beforeEach(() => activeContext.mockReset());

  test.each(["owner", "tenant_admin"])("a %s sees a link to the store's open shifts", (role) => {
    activeContext.mockReturnValue(asContext(role));
    renderStep();
    const link = screen.getByRole("link", { name: /View the store's open shifts/ });
    expect(link.getAttribute("href")).toBe(`/stores/${STORE}/open-shifts`);
  });

  test.each(["store_manager", "store_staff", "platform_admin"])("a %s sees nothing", (role) => {
    activeContext.mockReturnValue(asContext(role));
    renderStep();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("inside a support session even an owner who is not a platform admin sees nothing", () => {
    activeContext.mockReturnValue(asContext("owner", { id: "ss-1" }));
    renderStep();
    expect(screen.queryByRole("link")).toBeNull();
  });

  // RT-1462 (owner decision 2026-11-18): the server admits a platform admin whatever their role in the
  // tenant, with or without a support session, so the link follows.
  test.each([
    ["a store_manager member", "store_manager", null],
    ["no membership", null, null],
    ["no membership, inside a support session", null, { id: "ss-1" }],
  ])("a platform admin with %s sees the link", (_label, role, session) => {
    activeContext.mockReturnValue(asContext(role, session, true));
    renderStep();
    expect(screen.getByRole("link", { name: /View the store's open shifts/ })).toBeTruthy();
  });
});

describe("blockedByOpenShift", () => {
  test("only the two codes that clear when the shift is closed", () => {
    expect(blockedByOpenShift("unresolved_cash_session")).toBe(true);
    expect(blockedByOpenShift("unresolved_custody_exception")).toBe(true);
    expect(blockedByOpenShift("device_retired")).toBe(false);
    expect(blockedByOpenShift("something_new")).toBe(false);
    expect(blockedByOpenShift(null)).toBe(false);
  });
});

describe("OpenShiftsLink (the store page entry)", () => {
  beforeEach(() => activeContext.mockReset());
  const renderLink = () =>
    render(
      <MemoryRouter>
        <OpenShiftsLink storeId={STORE} />
      </MemoryRouter>,
    );

  test.each(["owner", "tenant_admin"])("a %s sees the link to the store's open shifts", (role) => {
    activeContext.mockReturnValue(asContext(role));
    renderLink();
    expect(
      screen.getByRole("link", { name: "Open shifts in this store" }).getAttribute("href"),
    ).toBe(`/stores/${STORE}/open-shifts`);
  });

  test("a store_manager and a support session see nothing", () => {
    activeContext.mockReturnValue(asContext("store_manager"));
    renderLink();
    expect(screen.queryByRole("link")).toBeNull();
    activeContext.mockReturnValue(asContext("owner", { id: "ss-1" }));
    renderLink();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("a platform admin sees the link with no membership, inside a support session too (RT-1462)", () => {
    activeContext.mockReturnValue(asContext(null, { id: "ss-1" }, true));
    renderLink();
    expect(screen.getByRole("link", { name: "Open shifts in this store" })).toBeTruthy();
  });
});
