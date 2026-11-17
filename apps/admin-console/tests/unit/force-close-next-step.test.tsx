import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { ForceCloseNextStep, blockedByOpenShift } from "@/force-actions/ForceCloseNextStep";

/**
 * RT-1440 (U1) AC4: the device panel's next step is shown to an owner or tenant_admin only, never
 * inside a support session, and only for the two block codes that clear when the shift closes.
 */

const STORE = "0198a0c4-0000-7000-8000-000000000a01";
const asContext = (role: string, supportSession: unknown = null) => ({
  context: { active_tenant: { id: "t1" }, active_role_code: role, support_session: supportSession },
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

  test("inside a support session even an owner sees nothing (read-only by construction)", () => {
    activeContext.mockReturnValue(asContext("owner", { id: "ss-1" }));
    renderStep();
    expect(screen.queryByRole("link")).toBeNull();
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
