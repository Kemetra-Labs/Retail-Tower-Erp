import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consoleListOpenShifts = vi.fn();
const consoleGetForceClosePreview = vi.fn();
const consoleForceCloseShift = vi.fn();
vi.mock("@/lib/force-action-queries", () => ({
  consoleListOpenShifts: (...a: unknown[]) => consoleListOpenShifts(...a),
  consoleGetForceClosePreview: (...a: unknown[]) => consoleGetForceClosePreview(...a),
  consoleForceCloseShift: (...a: unknown[]) => consoleForceCloseShift(...a),
}));
const listAuditEvents = vi.fn();
vi.mock("@/lib/client", () => ({
  listAuditEvents: (...a: unknown[]) => listAuditEvents(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));
const supportSession = vi.fn();
vi.mock("@/platform/session/useSupportSession", () => ({
  useSupportSession: () => supportSession(),
}));
vi.mock("@/shift-closes/useShiftCloses", () => ({
  useStoreOf: () => ({ name: "Cairo Festival City", timeZone: "Africa/Cairo", ready: true }),
  useStoreDirectory: () => ({
    stores: [],
    ready: true,
    nameOf: (id: string) => (id === STORE ? "Cairo Festival City" : undefined),
    timeZoneOf: () => "Africa/Cairo",
  }),
}));
vi.mock("@/people/usePeopleNames", () => ({
  usePeopleNames: () => new Map([["0198a0c4-0000-7000-8000-000000000e01", "Mona Hassan"]]),
}));

import { ForceClosedPage } from "@/force-actions/ForceClosedPage";
import { OpenShiftsPage } from "@/force-actions/OpenShiftsPage";
import { createQueryClient } from "@/lib/query";

/**
 * RT-1440 (U1): the open-shifts view (AC4: the action is hidden for store_manager and inside a
 * support session) and the read-only list of shifts closed without a count (A4, audit-backed).
 */

const STORE = "0198a0c4-0000-7000-8000-000000000a01";

const asRole = (role: string) => ({
  context: { active_tenant: { id: "t1", name: "Northstar" }, active_role_code: role },
});

function shift(
  id: string,
  over: { eligible: boolean; blockers?: string[]; label?: string | null; name?: string | null },
) {
  return {
    shiftId: id,
    storeId: STORE,
    source: "cash_up",
    lifecycleState: "open",
    openedAt: "2026-11-16T08:00:00Z",
    ageMinutes: 880,
    cashier: { userId: "0198a0c4-0000-7000-8000-000000000c01", displayName: over.name ?? null },
    terminal: {
      deviceId: "0198a0c4-0000-7000-8000-000000000d01",
      label: over.label === undefined ? "till-A" : over.label,
      lastSeenAt: "2026-11-16T08:20:00Z",
      trustState: "active",
    },
    verdict: {
      eligible: over.eligible,
      stale: true,
      liveOperatorSession: !over.eligible,
      liveCashierAdmission: false,
      blockers: over.blockers ?? (over.eligible ? [] : ["live_operator_session"]),
    },
  };
}

const list = (items: unknown[]) => ({
  status: 200,
  data: { storeId: STORE, evaluatedAt: "2026-11-16T22:40:00Z", staleThresholdMinutes: 15, items },
});

function renderOpenShifts(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/stores/${STORE}/open-shifts`]}>
        <Routes>
          <Route path="/stores/:storeId/open-shifts" element={<OpenShiftsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OpenShiftsPage", () => {
  beforeEach(() => {
    for (const fn of [
      consoleListOpenShifts,
      consoleGetForceClosePreview,
      consoleForceCloseShift,
      activeContext,
      supportSession,
    ]) {
      fn.mockReset();
    }
    activeContext.mockReturnValue(asRole("owner"));
    supportSession.mockReturnValue(null);
  });

  test("lists each open shift with the server's verdict as text; only an eligible one offers the close", async () => {
    consoleListOpenShifts.mockResolvedValue(
      list([
        shift("0198a0c4-0000-7000-8000-000000000b01", { eligible: true, name: null }),
        shift("0198a0c4-0000-7000-8000-000000000b02", {
          eligible: false,
          label: "till-B",
          name: "Jane Smith",
        }),
      ]),
    );
    renderOpenShifts();
    expect(await screen.findByText("Can be closed without a count now.")).toBeTruthy();
    expect(screen.getByText(/Cannot be closed from here now/)).toBeTruthy();
    expect(screen.getByText(/still in use \(an active cashier session\)/)).toBeTruthy();
    expect(screen.getByText("Cashier with no name")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Close the shift on .* without a count/ }),
    ).toHaveLength(1);
  });

  test("a blocked shift whose blocker list is empty still shows a reason, never a bare label", async () => {
    consoleListOpenShifts.mockResolvedValue(
      list([shift("0198a0c4-0000-7000-8000-000000000b01", { eligible: false, blockers: [] })]),
    );
    renderOpenShifts();
    expect(await screen.findByText("This shift cannot be closed from here now.")).toBeTruthy();
  });

  test("the action opens the dialog for that shift, which reads its preview", async () => {
    consoleListOpenShifts.mockResolvedValue(
      list([shift("0198a0c4-0000-7000-8000-000000000b01", { eligible: true })]),
    );
    consoleGetForceClosePreview.mockReturnValue(new Promise(() => undefined));
    renderOpenShifts();
    fireEvent.click(
      await screen.findByRole("button", { name: /Close the shift on till-A without a count/ }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Close the shift without a count" }),
    ).toBeTruthy();
    expect(consoleGetForceClosePreview).toHaveBeenCalledWith(
      "0198a0c4-0000-7000-8000-000000000b01",
    );
  });

  test.each(["store_manager", "store_staff"])("the action is hidden from a %s", async (role) => {
    activeContext.mockReturnValue(asRole(role));
    consoleListOpenShifts.mockResolvedValue(
      list([shift("0198a0c4-0000-7000-8000-000000000b01", { eligible: true })]),
    );
    renderOpenShifts();
    await screen.findByText("Can be closed without a count now.");
    expect(screen.queryByRole("button", { name: /without a count/ })).toBeNull();
  });

  test("the action is hidden inside a support session, even for an owner", async () => {
    supportSession.mockReturnValue({ id: "ss-1" });
    consoleListOpenShifts.mockResolvedValue(
      list([shift("0198a0c4-0000-7000-8000-000000000b01", { eligible: true })]),
    );
    renderOpenShifts();
    await screen.findByText("Can be closed without a count now.");
    expect(screen.queryByRole("button", { name: /without a count/ })).toBeNull();
  });

  test("no open shift is said so", async () => {
    consoleListOpenShifts.mockResolvedValueOnce(list([]));
    renderOpenShifts();
    expect(await screen.findByText("No shifts are open in this store.")).toBeTruthy();
  });

  test("a 404 is the non-disclosing 'not available for your access'", async () => {
    consoleListOpenShifts.mockResolvedValue({
      status: 404,
      error: { error: { code: "store_not_found", request_id: "r1" } },
    });
    renderOpenShifts();
    expect(await screen.findByText(/not available for your access/)).toBeTruthy();
  });

  test("a failed read offers a retry that reads again", async () => {
    consoleListOpenShifts.mockResolvedValueOnce({
      status: 500,
      error: { error: { code: "x", request_id: "r2" } },
    });
    consoleListOpenShifts.mockResolvedValueOnce(list([]));
    renderOpenShifts();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No shifts are open in this store.")).toBeTruthy();
    expect(consoleListOpenShifts).toHaveBeenCalledTimes(2);
  });
});

const auditRow = (
  id: string,
  over: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) => ({
  id,
  occurred_at: "2026-11-16T22:41:00Z",
  actor_user_id: "0198a0c4-0000-7000-8000-000000000e01",
  store_id: STORE,
  action: "shift.force_closed",
  kind: "change",
  target_type: "shift",
  target_id: "0198a0c4-0000-7000-8000-000000000b01",
  metadata: {
    shift_id: "0198a0c4-0000-7000-8000-000000000b01",
    channel: "console",
    actor_role: "owner",
    shift_age_minutes: 880,
    ...meta,
  },
  ...over,
});

function renderClosed(search = ""): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/shifts/force-closed${search}`]}>
        <ForceClosedPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ForceClosedPage", () => {
  beforeEach(() => {
    listAuditEvents.mockReset();
    activeContext.mockReset();
    activeContext.mockReturnValue(asRole("owner"));
  });

  test("lists who closed each shift, when, where and through which channel; the reason is not shown", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: {
        items: [
          auditRow("a1"),
          auditRow("a2", {}, { channel: "pos", actor_role: "store_manager" }),
        ],
        next_cursor: null,
      },
    });
    renderClosed();
    expect(await screen.findAllByText("Mona Hassan")).toHaveLength(2);
    expect(listAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ action: "shift.force_closed" }),
    );
    expect(screen.getByText("Console")).toBeTruthy();
    expect(screen.getByText("Point-of-sale terminal")).toBeTruthy();
    expect(screen.getAllByText("Cairo Festival City")).toHaveLength(2);
    expect(screen.getAllByText("880 minutes")).toHaveLength(2);
    expect(screen.queryByText(/reason/i, { selector: "th" })).toBeNull();
  });

  test("the store in the link narrows the list to that store, as the ledger row's count was", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: { items: [auditRow("a1")], next_cursor: null },
    });
    renderClosed(`?store=${STORE}`);
    await screen.findAllByText("Mona Hassan");
    expect(listAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ action: "shift.force_closed", store_id: STORE }),
    );
  });

  test("a malformed store in the link is ignored, never sent", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: { items: [auditRow("a1")], next_cursor: null },
    });
    renderClosed("?store=not-a-uuid");
    await screen.findAllByText("Mona Hassan");
    expect((listAuditEvents.mock.calls[0][0] as Record<string, unknown>).store_id).toBeUndefined();
  });

  test("a continuation cursor offers 'Load more' and appends the next page", async () => {
    listAuditEvents
      .mockResolvedValueOnce({ status: 200, data: { items: [auditRow("a1")], next_cursor: "c2" } })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          items: [auditRow("a2", { occurred_at: "2026-11-15T10:00:00Z" })],
          next_cursor: null,
        },
      });
    renderClosed();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3)); // header + 2
    expect(listAuditEvents).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c2" }));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("none is said so", async () => {
    listAuditEvents.mockResolvedValueOnce({ status: 200, data: { items: [], next_cursor: null } });
    renderClosed();
    expect(await screen.findByText("No shifts were closed without a count.")).toBeTruthy();
  });

  test("a 403 is not available for the caller's access", async () => {
    listAuditEvents.mockResolvedValue({ status: 403, error: { error: { code: "forbidden" } } });
    renderClosed();
    expect(await screen.findByText(/not available for your access/)).toBeTruthy();
  });

  test("a failed read keeps no stale rows and offers a retry", async () => {
    listAuditEvents.mockResolvedValueOnce({
      status: 500,
      error: { error: { code: "x", request_id: "r9" } },
    });
    listAuditEvents.mockResolvedValueOnce({
      status: 200,
      data: { items: [auditRow("a1")], next_cursor: null },
    });
    renderClosed();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Mona Hassan")).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  });
});

describe("RT-1440 review: focus after a close, and the list's window", () => {
  const SHIFT_ID = "0198a0c4-0000-7000-8000-000000000b01";
  const previewData = () => ({
    shift: shift(SHIFT_ID, { eligible: true }),
    recorded: {
      currencyCode: "EGP",
      openingFloat: "500.00",
      cashMovementCount: 3,
      lastCashMovementReceivedAt: "2026-11-16T09:12:00Z",
      saleCount: 41,
      refundExecutionCount: 1,
    },
    effects: { willChange: ["shift_closed_not_counted"], willNotChange: ["sales_unchanged"] },
    reversible: false,
    drawerCashUnaccounted: true,
    caveats: ["offline_facts_not_visible"],
    previewFingerprint: "3f0c8a5e1b7d4c2a9e6f0b1d8c7a5e4f2b3d9c6a1e8f7b0d5c4a3e2f1b9d8c7a",
    evaluatedAt: "2026-11-16T22:40:00Z",
  });

  beforeEach(() => {
    for (const fn of [
      consoleListOpenShifts,
      consoleGetForceClosePreview,
      consoleForceCloseShift,
      listAuditEvents,
      activeContext,
      supportSession,
    ]) {
      fn.mockReset();
    }
    activeContext.mockReturnValue(asRole("owner"));
    supportSession.mockReturnValue(null);
  });

  test("after a successful close removes the row, focus lands on the page heading, not on the page body", async () => {
    consoleListOpenShifts
      .mockResolvedValueOnce(list([shift(SHIFT_ID, { eligible: true })]))
      .mockResolvedValue(list([]));
    consoleGetForceClosePreview.mockResolvedValue({ status: 200, data: previewData() });
    consoleForceCloseShift.mockResolvedValue({ status: 201, data: {} });
    renderOpenShifts();
    fireEvent.click(
      await screen.findByRole("button", { name: /Close the shift on till-A without a count/ }),
    );
    fireEvent.change(await screen.findByLabelText(/Reason for closing/), {
      target: { value: "Till died" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Confirm closing the shift without a count/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1, name: "Open shifts" }),
      ),
    );
  });

  test("a cancelled dialog returns focus to the button that opened it while that button still exists", async () => {
    consoleListOpenShifts.mockResolvedValue(list([shift(SHIFT_ID, { eligible: true })]));
    consoleGetForceClosePreview.mockResolvedValue({ status: 200, data: previewData() });
    renderOpenShifts();
    const opener = await screen.findByRole("button", {
      name: /Close the shift on till-A without a count/,
    });
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  test("the list reads the same last 30 days the Overview row counts, and says so", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: { items: [auditRow("a1")], next_cursor: null },
    });
    renderClosed();
    expect(await screen.findByText(/last 30 days/)).toBeTruthy();
    const query = listAuditEvents.mock.calls[0][0] as { from?: string };
    const days = (Date.now() - Date.parse(query.from ?? "")) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
  });
});

describe("RT-1440 review: cache scope and transport failures", () => {
  beforeEach(() => {
    for (const fn of [consoleListOpenShifts, listAuditEvents, activeContext, supportSession])
      fn.mockReset();
    activeContext.mockReturnValue(asRole("owner"));
    supportSession.mockReturnValue(null);
  });

  test("a role change in the same tenant re-reads the closed list instead of showing the old role's rows", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: { items: [auditRow("a1")], next_cursor: null },
    });
    const client = createQueryClient();
    const tree = () => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/shifts/force-closed"]}>
          <ForceClosedPage />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    await screen.findAllByText("Mona Hassan");
    expect(listAuditEvents).toHaveBeenCalledTimes(1);
    listAuditEvents.mockResolvedValue({ status: 403, error: { error: { code: "forbidden" } } });
    activeContext.mockReturnValue(asRole("store_manager"));
    rerender(tree());
    await waitFor(() => expect(listAuditEvents).toHaveBeenCalledTimes(2));
  });

  test("the closed list offers Try again when the request itself fails (offline), not only on a server error", async () => {
    listAuditEvents.mockRejectedValueOnce(new Error("offline"));
    listAuditEvents.mockResolvedValueOnce({
      status: 200,
      data: { items: [auditRow("a1")], next_cursor: null },
    });
    renderClosed();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Mona Hassan")).toBeTruthy();
  });

  test("the open shifts offer Try again when the request itself fails (offline)", async () => {
    consoleListOpenShifts.mockRejectedValueOnce(new Error("offline"));
    consoleListOpenShifts.mockResolvedValueOnce(list([]));
    renderOpenShifts();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No shifts are open in this store.")).toBeTruthy();
  });
});
