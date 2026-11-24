import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * AlertsPage renders the Overview's attention ledger on its own page, so the
 * mocks here are the ledger's five reads (RT-559), copied from
 * overview-panels.test.tsx. The sales-summary / low-stock reads belong to the
 * Overview's other panels and are not needed here.
 */
const listErpnextNegativeOnHandStores = vi.fn();
vi.mock("@/lib/stock-discrepancy-queries", () => ({
  listErpnextNegativeOnHandStores: (...a: unknown[]) => listErpnextNegativeOnHandStores(...a),
}));
const consoleListShiftCloses = vi.fn();
vi.mock("@/lib/shift-close-queries", () => ({
  consoleListShiftCloses: (...a: unknown[]) => consoleListShiftCloses(...a),
}));
const listUnknownItems = vi.fn();
vi.mock("@/lib/unknown-items-queries", () => ({
  listUnknownItems: (...a: unknown[]) => listUnknownItems(...a),
}));
const listAuditEvents = vi.fn();
vi.mock("@/lib/client", () => ({
  listAuditEvents: (...a: unknown[]) => listAuditEvents(...a),
}));
const getCountSessionsSetting = vi.fn();
vi.mock("@/lib/count-session-queries", () => ({
  getCountSessionsSetting: (...a: unknown[]) => getCountSessionsSetting(...a),
}));
const storeRows = vi.fn();
vi.mock("@/stores/useStoreQueries", () => ({
  useStoreList: () => ({ result: { kind: "rows", rows: storeRows() }, isLoading: false }),
  useStoreDetail: () => ({ result: undefined, isLoading: false }),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { createQueryClient } from "@/lib/query";
import { AlertsPage } from "@/alerts/AlertsPage";

const A = "0190f000-0000-7000-8000-0000000000a1";
const NOW = "2026-10-15T22:30:00Z"; // Oct 16 in Cairo, Oct 15 in UTC
const READ_AT = "2026-10-15T07:58:12.000Z";

function ctx(role: string, store: { id: string; name: string } | null = null) {
  return {
    context: {
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: store,
      active_role_code: role,
    },
  };
}

function snapshot(status: string, over: Record<string, unknown> = {}) {
  const has = status === "fresh" || status === "stale";
  return {
    status,
    erpnextWarehouseRef: has ? "Stores - NSR" : null,
    runId: has ? "0190f000-0000-7000-8000-0000000000r1" : null,
    readAt: has ? READ_AT : null,
    recordedAt: has ? READ_AT : null,
    staleAfterSeconds: 86400,
    reportedEntryCount: has ? 42 : null,
    pendingRequest: null,
    ...over,
  };
}

function summary(storeId: string, storeName: string, status = "fresh", negativeItemCount = 0) {
  return { storeId, storeName, snapshot: snapshot(status), negativeItemCount };
}

const ok = (data: unknown) => Promise.resolve({ status: 200, data });
const fail = (status: number) =>
  Promise.resolve({ status, error: { error: { code: "x", request_id: "req-1" } } });

/** Every panel answers with one quiet page unless a test overrides it. */
function answerAll(): void {
  listErpnextNegativeOnHandStores.mockImplementation(() =>
    ok({ items: [summary(A, "Cairo Festival City", "fresh", 3)], nextCursor: null }),
  );
  consoleListShiftCloses.mockImplementation(() => ok({ items: [{}, {}], nextCursor: null }));
  listUnknownItems.mockImplementation(() => ok({ items: [{}], next_cursor: null }));
  // RT-1440: no force closes, and the count switch is on (so its row is hidden).
  listAuditEvents.mockImplementation(() => ok({ items: [], next_cursor: null }));
  getCountSessionsSetting.mockImplementation(() => ok({ enabled: true, unmetReadiness: [] }));
}

function renderAlerts(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/alerts"]}>
        <AlertsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(label: string): HTMLElement {
  const el = screen.getByText(label).closest("li");
  if (!el) throw new Error(`no ledger row for ${label}`);
  return el as HTMLElement;
}

async function findRow(label: string): Promise<HTMLElement> {
  await screen.findByText(label);
  return row(label);
}

const SHIFT = "Shift-close variances with no recorded approver (last 7 days)";
const UNKNOWN = "Unknown items pending review";
const stockLabel = (store: string) => `Stock discrepancies · ${store}`;

describe("AlertsPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    for (const fn of [
      listErpnextNegativeOnHandStores,
      consoleListShiftCloses,
      listUnknownItems,
      listAuditEvents,
      getCountSessionsSetting,
      activeContext,
    ]) {
      fn.mockReset();
    }
    storeRows.mockReturnValue([
      { id: A, name: "Cairo Festival City", timezone: "Africa/Cairo" },
    ]);
    answerAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("the ledger's rows render on their own page, with their links", async () => {
    activeContext.mockReturnValue(ctx("owner"));
    renderAlerts();
    expect(screen.getByRole("heading", { level: 1, name: "Alerts" })).toBeTruthy();
    const stock = await findRow(stockLabel("Cairo Festival City"));
    expect(within(stock).getByText("Negative items: 3")).toBeTruthy();
    expect(
      within(stock).getByRole("link", { name: "View store discrepancies" }).getAttribute("href"),
    ).toBe(`/stock-discrepancies/${A}`);
    const shift = await findRow(SHIFT);
    await within(shift).findByText("Closes: 2");
    expect(within(shift).getByRole("link", { name: "Review closes" }).getAttribute("href")).toBe(
      "/shift-closes?from=2026-10-09&min=0.0001&approval=not_approved",
    );
    const unknown = await findRow(UNKNOWN);
    await within(unknown).findByText("Items: 1");
    // The alerts page itself has no "view all" link: it is the destination.
    expect(screen.queryByRole("link", { name: "View all alerts" })).toBeNull();
  });

  test("with no active tenant only the scope prompt renders and no panel is read", async () => {
    activeContext.mockReturnValue({
      context: { active_tenant: null, active_store: null, active_role_code: null },
    });
    renderAlerts();
    expect(await screen.findByText(/select a tenant to view alerts/i)).toBeDefined();
    expect(screen.queryByText("Needs your attention")).toBeNull();
    for (const fn of [
      listErpnextNegativeOnHandStores,
      consoleListShiftCloses,
      listUnknownItems,
      listAuditEvents,
      getCountSessionsSetting,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  test("with every attention panel refused, the ledger says so instead of rendering empty", async () => {
    activeContext.mockReturnValue(ctx("store_staff"));
    listUnknownItems.mockImplementation(() => fail(403));
    listAuditEvents.mockImplementation(() => fail(403));
    renderAlerts();
    expect(
      await screen.findByText("No attention items are available to your role here."),
    ).toBeTruthy();
    const attention = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(attention).queryByRole("list")).toBeNull();
  });
});
