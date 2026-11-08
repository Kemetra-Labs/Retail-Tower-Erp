import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-455 part 1: the tenant's tracked-selling switch on the tenant page, against
 * mocked contract answers (`inventory.yaml` 1.12.0-draft; RT-451 OD-T1..OD-T7).
 *
 * - owner / tenant_admin: on/off, last change with the actor's name (OD-3),
 *   the unmet preconditions in plain words, switch on (409 explained, the read
 *   fetched again), switch off behind a confirm step;
 * - store_manager: on/off only, no action;
 * - another role, another tenant, the gate's 404: nothing rendered;
 * - on with `preconditionsMet: false`: the OD-T7 warning;
 * - loading and a failed read with a retry; Arabic copy in RTL.
 */
const getSetting = vi.fn();
const putSetting = vi.fn();
vi.mock("@/lib/tracked-selling-queries", () => ({
  getTrackedSellingSetting: (...a: unknown[]) => getSetting(...a),
  setTrackedSellingSetting: (...a: unknown[]) => putSetting(...a),
}));
const listPeopleNames = vi.fn();
vi.mock("@/lib/people-queries", () => ({
  consoleListPeopleNames: (...a: unknown[]) => listPeopleNames(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";
import { TenantTrackedSellingSection } from "@/tracked-selling/TenantTrackedSellingSection";

const TENANT = "t1";
const OMAR = "0190f000-0000-7000-8000-0000000000c1";

function ctx(role: string | null, tenantId = TENANT) {
  return { context: { active_tenant: { id: tenantId }, active_role_code: role } };
}

const off = {
  enabled: false,
  changedAt: null,
  changedBy: null,
  preconditionsMet: false,
  unmetPreconditions: ["erp_batch_posting_verified", "identity_anchor"],
};
const on = {
  enabled: true,
  changedAt: "2026-11-08T18:00:00Z",
  changedBy: OMAR,
  preconditionsMet: true,
  unmetPreconditions: [],
};
const ok = (data: unknown) => ({ status: 200, data });

function renderSection(tenantId = TENANT): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <TenantTrackedSellingSection tenantId={tenantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getSetting.mockReset();
  putSetting.mockReset();
  listPeopleNames.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  listPeopleNames.mockResolvedValue({
    status: 200,
    data: { items: [{ user_id: OMAR, display_name: "Omar Nabil" }] },
  });
});

afterEach(cleanup);

describe("who sees the section", () => {
  test.each(["cashier", "store_staff", null])("%s: nothing rendered, nothing asked", (role) => {
    activeContext.mockReturnValue(ctx(role));
    renderSection();
    expect(screen.queryByTestId("tracked-selling-section")).toBeNull();
    expect(getSetting).not.toHaveBeenCalled();
  });

  test("another tenant than the session's: nothing rendered, nothing asked", () => {
    renderSection("t2");
    expect(screen.queryByTestId("tracked-selling-section")).toBeNull();
    expect(getSetting).not.toHaveBeenCalled();
  });

  test("the deployment gate's 404 hides the setting", async () => {
    getSetting.mockResolvedValue({ status: 404, error: { error: { code: "not_found" } } });
    renderSection();
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("tracked-selling-section")).toBeNull());
  });

  test("store_manager: on/off only, no action and no preconditions", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    getSetting.mockResolvedValue(
      ok({
        enabled: true,
        changedAt: null,
        changedBy: null,
        preconditionsMet: null,
        unmetPreconditions: null,
      }),
    );
    renderSection();
    expect((await screen.findByTestId("tracked-selling-state")).textContent).toBe("On");
    expect(screen.getByText("View only. The tenant owner or admin changes it.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("tracked-selling-preconditions")).toBeNull();
  });
});

describe("read states", () => {
  test("loading, then a failed read with the request id and a retry", async () => {
    getSetting.mockResolvedValueOnce({
      status: 500,
      error: { error: { code: "internal", request_id: "req_ts_9" } },
    });
    renderSection();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText("The batch selling setting could not be loaded.")).toBeTruthy();
    expect(screen.getByText("req_ts_9")).toBeTruthy();
    getSetting.mockResolvedValue(ok(off));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByTestId("tracked-selling-state")).textContent).toBe("Off");
  });
});

describe("owner / tenant_admin view", () => {
  test("off: never changed, the unmet preconditions in plain words, switch on offered", async () => {
    activeContext.mockReturnValue(ctx("tenant_admin"));
    getSetting.mockResolvedValue(ok(off));
    renderSection();
    expect((await screen.findByTestId("tracked-selling-state")).textContent).toBe("Off");
    expect(screen.getByText("Not changed since the tenant was created.")).toBeTruthy();
    const list = screen.getByTestId("tracked-selling-preconditions");
    expect(
      within(list).getByText("Posting batch lines to ERPNext with the batch number is verified."),
    ).toBeTruthy();
    expect(within(list).getByText("Each batch's starting balance is set.")).toBeTruthy();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Switch batch selling on" })).toBeTruthy();
  });

  test("on: last change with the actor's name, all met, no warning", async () => {
    getSetting.mockResolvedValue(ok(on));
    renderSection();
    expect((await screen.findByTestId("tracked-selling-state")).textContent).toBe("On");
    expect(await screen.findByText("Omar Nabil")).toBeTruthy();
    expect(screen.getByText(OMAR)).toBeTruthy();
    expect(screen.getByText("Every condition for switching on is met now.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("OD-T7: on with a precondition that no longer holds shows the warning", async () => {
    getSetting.mockResolvedValue(
      ok({ ...on, preconditionsMet: false, unmetPreconditions: ["sale_effects_active"] }),
    );
    renderSection();
    const alert = await screen.findByRole("alert");
    await waitFor(() =>
      expect(alert.textContent).toContain(
        "Batch selling is on, but one or more conditions no longer hold.",
      ),
    );
    // Still on, and only an owner or tenant_admin switches it off.
    expect(screen.getByTestId("tracked-selling-state").textContent).toBe("On");
    expect(screen.getByRole("button", { name: "Switch batch selling off" })).toBeTruthy();
  });

  test("switch on: 409 preconditions unmet is explained and the read is fetched again", async () => {
    getSetting.mockResolvedValue(ok(off));
    putSetting.mockResolvedValue({
      status: 409,
      error: { error: { code: "tracked_selling_preconditions_unmet", request_id: "req_409" } },
    });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Switch batch selling on" }));
    await waitFor(() => expect(putSetting).toHaveBeenCalledWith({ enabled: true }));
    expect(
      await screen.findByText(/Batch selling was not switched on: at least one condition/),
    ).toBeTruthy();
    expect(screen.getByText("req_409")).toBeTruthy();
    await waitFor(() => expect(getSetting).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("tracked-selling-state").textContent).toBe("Off");
  });

  test("switch on: 200 shows what succeeded and the server's state", async () => {
    getSetting.mockResolvedValue(ok({ ...off, preconditionsMet: true, unmetPreconditions: [] }));
    putSetting.mockResolvedValue(ok(on));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Switch batch selling on" }));
    expect(await screen.findByText("Batch selling is switched on.")).toBeTruthy();
    expect(screen.getByTestId("tracked-selling-state").textContent).toBe("On");
    expect(screen.getByRole("button", { name: "Switch batch selling off" })).toBeTruthy();
  });

  test("switch off goes through a confirm step; cancel sends nothing", async () => {
    getSetting.mockResolvedValue(ok(on));
    putSetting.mockResolvedValue(ok({ ...on, enabled: false }));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Switch batch selling off" }));
    const confirm = screen.getByTestId("tracked-selling-confirm");
    expect(confirm.textContent).toContain("Nothing is deleted");
    // Safe default focus on cancel.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" })),
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(putSetting).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Switch batch selling off" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm switching off" }));
    await waitFor(() => expect(putSetting).toHaveBeenCalledWith({ enabled: false }));
    expect(await screen.findByText("Batch selling is switched off.")).toBeTruthy();
    expect(screen.getByTestId("tracked-selling-state").textContent).toBe("Off");
  });

  test("no answer: the outcome is unknown, never a success, and the state is read again", async () => {
    getSetting.mockResolvedValue(ok(off));
    putSetting.mockRejectedValue(new TypeError("Failed to fetch"));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Switch batch selling on" }));
    expect(
      await screen.findByText(/No answer arrived, so whether the setting changed/),
    ).toBeTruthy();
    expect(screen.queryByText("Batch selling is switched on.")).toBeNull();
    await waitFor(() => expect(getSetting).toHaveBeenCalledTimes(2));
  });

  test("a 404 on the switch (gate went off): the answer stays, nothing else of the setting", async () => {
    getSetting.mockResolvedValueOnce(ok(off));
    getSetting.mockResolvedValue({ status: 404 });
    putSetting.mockResolvedValue({ status: 404 });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Switch batch selling on" }));
    expect(
      await screen.findByText(
        "The batch selling setting is not available now. Nothing was recorded.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("tracked-selling-state")).toBeNull());
    expect(screen.queryByRole("button")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Batch selling" })),
    );
  });

  test("no answer and a failed re-read: the unknown outcome is kept above the read error", async () => {
    getSetting.mockResolvedValueOnce(ok(off));
    getSetting.mockResolvedValue({ status: 500 });
    putSetting.mockRejectedValue(new TypeError("Failed to fetch"));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Switch batch selling on" }));
    expect(await screen.findByText("The batch selling setting could not be loaded.")).toBeTruthy();
    expect(screen.getByText(/No answer arrived, so whether the setting changed/)).toBeTruthy();
  });

  test("a 401 on the switch says the session ended", async () => {
    getSetting.mockResolvedValue(ok(off));
    putSetting.mockResolvedValue({ status: 401 });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Switch batch selling on" }));
    expect(await screen.findByText("Your session has ended. Sign in again.")).toBeTruthy();
  });

  test("a manage read without the precondition fields is a failed read, never «all met»", async () => {
    getSetting.mockResolvedValue(ok({ ...on, preconditionsMet: null, unmetPreconditions: null }));
    renderSection();
    expect(await screen.findByText("The batch selling setting could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("Every condition for switching on is met now.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch batch selling off" })).toBeNull();
  });
});

describe("Arabic (RTL default copy)", () => {
  test("the section reads in Arabic", async () => {
    setLocale("ar");
    getSetting.mockResolvedValue(ok(off));
    renderSection();
    expect((await screen.findByTestId("tracked-selling-state")).textContent).toBe("متوقف");
    expect(screen.getByRole("heading", { name: "البيع بالدفعة" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "تشغيل البيع بالدفعة" })).toBeTruthy();
    expect(screen.getByText("رصيد البداية لكل دفعة مثبَّت.")).toBeTruthy();
  });
});
