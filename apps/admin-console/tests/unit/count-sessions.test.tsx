import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const count = vi.hoisted(() => ({
  listCountSessions: vi.fn(),
  getCountSession: vi.fn(),
  createCountSession: vi.fn(),
  recordCountObservations: vi.fn(),
  takeCountCut: vi.fn(),
  submitCountSession: vi.fn(),
  listCountVarianceLines: vi.fn(),
  requestCountRecount: vi.fn(),
  approveCountSession: vi.fn(),
  cancelCountSession: vi.fn(),
  listCountLateEventFindings: vi.fn(),
  getCountSelfApprovalSetting: vi.fn(),
  setCountSelfApprovalSetting: vi.fn(),
}));
vi.mock("@/lib/count-session-queries", () => count);
const inv = {
  listStockLocations: vi.fn(),
  getOnHand: vi.fn(),
  listStoreMovements: vi.fn(),
  listTrackingIdentities: vi.fn(),
};
vi.mock("@/lib/inventory-queries", () => ({
  listStockLocations: (...a: unknown[]) => inv.listStockLocations(...a),
  getOnHand: (...a: unknown[]) => inv.getOnHand(...a),
  listStoreMovements: (...a: unknown[]) => inv.listStoreMovements(...a),
  listTrackingIdentities: (...a: unknown[]) => inv.listTrackingIdentities(...a),
}));
const catalog = { consoleListCatalogProducts: vi.fn(), consoleGetCatalogProduct: vi.fn() };
vi.mock("@/lib/catalog-queries", () => ({
  consoleListCatalogProducts: (...a: unknown[]) => catalog.consoleListCatalogProducts(...a),
  consoleGetCatalogProduct: (...a: unknown[]) => catalog.consoleGetCatalogProduct(...a),
}));
const people = vi.fn();
vi.mock("@/lib/people-queries", () => ({
  consoleListPeopleNames: (...a: unknown[]) => people(...a),
}));
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listStores: (...a: unknown[]) => listStores(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { CountSessionDetail } from "@/count-sessions/CountSessionPage";
import { CountSessions } from "@/count-sessions/CountSessions";
import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const SESSION = "0190f000-0000-7000-8000-0000000008a1";
const NEW_SESSION = "0190f000-0000-7000-8000-0000000008a2";
const P1 = "0190f000-0000-7000-8000-0000000009a1";
const P2 = "0190f000-0000-7000-8000-0000000009a2";
const P3 = "0190f000-0000-7000-8000-0000000009a3";
const LOC = "0190f000-0000-7000-8000-0000000007d1";
const ME = "0190f000-0000-7000-8000-0000000000a1";
const REQUEST_ID = "0190f000-0000-7000-8000-0000000007e1";

function ctx(role: string | null = "owner") {
  return {
    context: {
      user: { id: ME, display_name: "Amal Saleh" },
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: null,
      active_role_code: role,
      memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
    },
    switchTenant: () => {},
    switchStore: () => {},
    clearStore: () => {},
  };
}

const ok = <T,>(data: T) => ({ status: 200, data });
const page = (items: unknown[], nextCursor: string | null = null) => ok({ items, nextCursor });
const conflict = (code: string) => ({
  status: 409,
  error: { error: { code, message: "server words", request_id: REQUEST_ID } },
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    storeId: STORE,
    state: "open",
    scope: { kind: "products", productIds: [P1, P2] },
    note: null,
    cut: null,
    openedBy: ME,
    openedAt: "2026-11-16T08:00:00Z",
    counterIds: [],
    submittedBy: null,
    submittedAt: null,
    approval: null,
    cancellation: null,
    lateEventFindingCount: 0,
    updatedAt: "2026-11-16T08:00:00Z",
    ...overrides,
  };
}

const CUT = { watermark: "wm-0001", cutAt: "2026-11-16T08:15:00Z", takenBy: ME };

function line(productId: string, overrides: Record<string, unknown> = {}) {
  return {
    productId,
    lineVersion: "1",
    stockingUnit: "kg",
    expectedQuantity: "10.0000",
    countedQuantity: "7.0000",
    varianceQuantity: "-3.0000",
    flags: [],
    acknowledgementRequired: false,
    acknowledgement: null,
    refusal: null,
    observations: [{ locationId: LOC, inventoryStatus: "sellable", countedQuantity: "7.0000" }],
    ...overrides,
  };
}
const flagged = (id: string, version = "1") =>
  line(id, { lineVersion: version, flags: ["divergence"], acknowledgementRequired: true });

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderList() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/inventory/stores/${STORE}/counts`]}>
        <Where />
        <Routes>
          <Route path="/inventory/stores/:storeId/counts" element={<CountSessions />} />
          <Route
            path="/inventory/stores/:storeId/counts/:sessionId"
            element={<CountSessionDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/inventory/stores/${STORE}/counts/${SESSION}`]}>
        <Routes>
          <Route
            path="/inventory/stores/:storeId/counts/:sessionId"
            element={<CountSessionDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of [...Object.values(count), ...Object.values(inv)]) fn.mockReset();
  for (const fn of Object.values(catalog)) fn.mockReset();
  people.mockReset();
  listStores.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  listStores.mockResolvedValue({ status: 200, data: [] });
  people.mockResolvedValue(ok({ items: [] }));
  inv.listStockLocations.mockResolvedValue(
    ok({
      items: [
        {
          id: LOC,
          storeId: STORE,
          code: "MAIN",
          name: "Main shelf",
          kind: "primary",
          isActive: true,
        },
      ],
    }),
  );
  catalog.consoleGetCatalogProduct.mockImplementation(async (id: string) =>
    ok({ summary: { productId: id, name: id === P1 ? "Olive oil" : id === P2 ? "Rice" : "Tea" } }),
  );
  catalog.consoleListCatalogProducts.mockResolvedValue(
    ok({
      items: [
        { productId: P1, name: "Olive oil", primarySku: "OIL-1", trackingMode: "none" },
        { productId: P3, name: "Tea", primarySku: null, trackingMode: "batch" },
      ],
      nextCursor: null,
    }),
  );
  count.listCountSessions.mockResolvedValue(page([]));
  count.getCountSession.mockResolvedValue(ok(session()));
  count.listCountVarianceLines.mockResolvedValue(page([]));
  count.listCountLateEventFindings.mockResolvedValue(page([]));
  count.getCountSelfApprovalSetting.mockResolvedValue(
    ok({ enabled: false, reason: null, changedAt: null, changedBy: null }),
  );
});
afterEach(cleanup);

// --- List and open ----------------------------------------------------------------------

describe("count sessions list and open (RT-1425)", () => {
  test("lists the sessions with their status and links to each", async () => {
    count.listCountSessions.mockResolvedValue(
      page([session({ state: "submitted" }), session({ id: NEW_SESSION, state: "confirmed" })]),
    );
    renderList();
    expect(await screen.findByText("Awaiting approval", { selector: "span.badge" })).toBeDefined();
    const table = screen.getByRole("table", { name: /count sessions/i });
    expect(within(table).getByText("Confirmed by ERPNext")).toBeDefined();
    expect(within(table).getAllByRole("link")).toHaveLength(2);
    // The list never carries an expected quantity.
    expect(document.body.textContent).not.toMatch(/Expected at the cut/);
  });

  test("empty, filtered-empty and error states are each said plainly", async () => {
    renderList();
    expect(await screen.findByText(/No count sessions in this store yet/)).toBeDefined();
    count.listCountSessions.mockResolvedValue(page([]));
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "approved" } });
    expect(await screen.findByText("No sessions with this status.")).toBeDefined();
    expect(count.listCountSessions).toHaveBeenLastCalledWith(STORE, { state: "approved" });
  });

  test("a failed list is a persistent alert with the request id and a retry", async () => {
    count.listCountSessions.mockResolvedValue({
      status: 500,
      error: { error: { code: "x", message: "x", request_id: REQUEST_ID } },
    });
    renderList();
    expect(await screen.findByText("Count sessions could not be loaded.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  test("keyset paging: Load more follows the cursor and keeps the rows", async () => {
    count.listCountSessions
      .mockResolvedValueOnce(page([session()], "c1"))
      .mockResolvedValueOnce(page([session({ id: NEW_SESSION })]));
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Load older sessions" }));
    await waitFor(() => expect(count.listCountSessions).toHaveBeenCalledTimes(2));
    expect(count.listCountSessions.mock.calls[1][1]).toEqual({ cursor: "c1" });
  });

  test("opens a count for chosen products with an Idempotency-Key, then goes to the session", async () => {
    count.createCountSession.mockResolvedValue({ status: 201, data: session({ id: NEW_SESSION }) });
    renderList();
    fireEvent.click(await screen.findByLabelText(/Olive oil/));
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: " Aisle 3 " } });
    fireEvent.click(screen.getByRole("button", { name: "Open count session" }));
    await waitFor(() => expect(count.createCountSession).toHaveBeenCalledTimes(1));
    const [storeId, body, key] = count.createCountSession.mock.calls[0];
    expect(storeId).toBe(STORE);
    expect(body).toEqual({ scope: { kind: "products", productIds: [P1] }, note: "Aisle 3" });
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        `/inventory/stores/${STORE}/counts/${NEW_SESSION}`,
      ),
    );
  });

  test("opening with no product is refused before any request", async () => {
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Open count session" }));
    expect(await screen.findByText("Choose at least one product.")).toBeDefined();
    expect(count.createCountSession).not.toHaveBeenCalled();
  });

  test("a tracked product is marked, and the server's typed refusal is shown by its code", async () => {
    count.createCountSession.mockResolvedValue(conflict("count_tracked_product_refused"));
    renderList();
    expect(await screen.findByText("Batch or serial")).toBeDefined();
    fireEvent.click(screen.getByLabelText(/Tea/));
    fireEvent.click(screen.getByRole("button", { name: "Open count session" }));
    const outcome = await screen.findByTestId("count-outcome");
    expect(outcome.textContent).toContain("A batch or serial product cannot be counted yet");
    expect(outcome.textContent).toContain("count_tracked_product_refused");
    expect(outcome.textContent).toContain(REQUEST_ID);
    expect(outcome.textContent).not.toContain("server words");
  });

  test("a store_manager sees the page; a cashier gets no access", async () => {
    activeContext.mockReturnValue(ctx("cashier"));
    renderList();
    expect(await screen.findByText("No assigned access")).toBeDefined();
    expect(count.listCountSessions).not.toHaveBeenCalled();
  });
});

// --- Blind capture, cut, submit ---------------------------------------------------------------

describe("blind capture, Count Cut and submit (RT-1425)", () => {
  async function capture(quantity = "7.5", unit = "kg") {
    await screen.findByRole("heading", { name: "Counting" });
    await waitFor(() =>
      expect(screen.getByLabelText("Stock location").textContent).toContain("Main shelf"),
    );
    fireEvent.change(screen.getByLabelText("Product"), { target: { value: P1 } });
    fireEvent.change(screen.getByLabelText("Stock location"), { target: { value: LOC } });
    fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: quantity } });
    fireEvent.change(screen.getByLabelText("Counted unit"), { target: { value: unit } });
    fireEvent.click(screen.getByRole("button", { name: "Record count" }));
  }

  test("records a position with an Idempotency-Key and never reads expected quantities", async () => {
    count.recordCountObservations.mockResolvedValue(
      ok({
        sessionId: SESSION,
        observations: [
          {
            productId: P1,
            locationId: LOC,
            inventoryStatus: "sellable",
            countedQuantity: "7.5",
            stockingUnit: "kg",
            countedBy: ME,
            countedAt: "2026-11-16T08:05:00Z",
          },
        ],
      }),
    );
    renderDetail();
    await capture();
    await waitFor(() => expect(count.recordCountObservations).toHaveBeenCalledTimes(1));
    const [storeId, sessionId, observations, key] = count.recordCountObservations.mock.calls[0];
    expect([storeId, sessionId]).toEqual([STORE, SESSION]);
    expect(observations).toEqual([
      {
        productId: P1,
        locationId: LOC,
        inventoryStatus: "sellable",
        countedQuantity: "7.5",
        stockingUnit: "kg",
      },
    ]);
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
    const recorded = await screen.findByTestId("count-recorded");
    expect(recorded.textContent).toContain("7.5");
    const coverage = screen.getByTestId("count-coverage");
    expect(within(coverage).getByText("Count recorded")).toBeDefined();
    expect(within(coverage).getByText("No count recorded")).toBeDefined();
    // Blind: no on-hand read, no variance column, no expected quantity anywhere.
    expect(inv.getOnHand).not.toHaveBeenCalled();
    expect(inv.listStoreMovements).not.toHaveBeenCalled();
    expect(count.listCountVarianceLines).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/Expected at the cut/);
  });

  test("an invalid quantity is refused before any request, with a field error", async () => {
    renderDetail();
    await capture("-1");
    expect(await screen.findByText(/Enter a quantity of zero or more/)).toBeDefined();
    expect(count.recordCountObservations).not.toHaveBeenCalled();
  });

  test("the Count Cut refusal is persistent text with the typed code and request id; nothing claims success", async () => {
    count.takeCountCut.mockResolvedValue(conflict("count_cut_barrier_not_met"));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Take the Count Cut" }));
    const outcome = await screen.findByTestId("count-outcome");
    expect(outcome.textContent).toContain("The Count Cut is not ready yet");
    expect(outcome.textContent).toContain("No cut was recorded");
    expect(outcome.textContent).toContain("count_cut_barrier_not_met");
    expect(outcome.textContent).toContain(REQUEST_ID);
    expect(screen.queryByText(/Cut taken/)).toBeNull();
    // A retry of the same intent replays the same key.
    fireEvent.click(screen.getByRole("button", { name: "Take the Count Cut" }));
    await waitFor(() => expect(count.takeCountCut).toHaveBeenCalledTimes(2));
    // A terminal 409 settles the key, so the retry is a new action.
    expect(count.takeCountCut.mock.calls[0][2]).not.toBe(count.takeCountCut.mock.calls[1][2]);
  });

  test("a cut that succeeds re-reads the session and offers submit", async () => {
    count.takeCountCut.mockResolvedValue(ok(session({ state: "cut_taken", cut: CUT })));
    count.getCountSession
      .mockResolvedValueOnce(ok(session()))
      .mockResolvedValue(ok(session({ state: "cut_taken", cut: CUT })));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Take the Count Cut" }));
    expect(await screen.findByRole("button", { name: "Submit for review" })).toBeDefined();
    expect(screen.getByText("wm-0001")).toBeDefined();
  });

  test("submit sends the command with a key and shows a refusal when counts are missing", async () => {
    count.getCountSession.mockResolvedValue(ok(session({ state: "cut_taken", cut: CUT })));
    count.submitCountSession.mockResolvedValue(conflict("count_session_not_in_state"));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
    const outcome = await screen.findByTestId("count-outcome");
    expect(outcome.textContent).toContain("not available in the session's current status");
    expect(count.submitCountSession.mock.calls[0][2]).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  test("a lost answer is reported as unknown and the retry reuses the Idempotency-Key", async () => {
    count.getCountSession.mockResolvedValue(ok(session({ state: "cut_taken", cut: CUT })));
    count.submitCountSession.mockRejectedValueOnce(new Error("network"));
    count.submitCountSession.mockResolvedValue(ok(session({ state: "submitted", cut: CUT })));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
    expect(await screen.findByText(/not known whether the request was applied/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(count.submitCountSession).toHaveBeenCalledTimes(2));
    expect(count.submitCountSession.mock.calls[0][2]).toBe(
      count.submitCountSession.mock.calls[1][2],
    );
  });

  test("cancel names its consequence, needs a reason, and sends it", async () => {
    count.cancelCountSession.mockResolvedValue(ok(session({ state: "cancelled" })));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel this count session" }));
    expect(screen.getByText(/A cancelled session cannot be reopened/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(await screen.findByText("Write the reason for cancelling.")).toBeDefined();
    expect(count.cancelCountSession).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for cancelling"), {
      target: { value: "Wrong aisle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(count.cancelCountSession).toHaveBeenCalledTimes(1));
    expect(count.cancelCountSession.mock.calls[0].slice(0, 3)).toEqual([
      STORE,
      SESSION,
      "Wrong aisle",
    ]);
  });
});

describe("Count Cut blockers, not-enabled state and the owner setting (RT-1425)", () => {
  const DEVICE = "0190f000-0000-7000-8000-0000000000d1";

  test("a cut refusal lists the blocking devices and warehouses with their reasons", async () => {
    count.takeCountCut.mockResolvedValue({
      status: 409,
      error: {
        error: {
          code: "count_cut_barrier_not_met",
          message: "server words",
          request_id: REQUEST_ID,
          details: {
            devices: [{ deviceId: DEVICE, reason: "queue_pending" }],
            warehouses: [{ warehouseRef: "Stores - RT", reason: "import_not_past_cut" }],
          },
        },
      },
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Take the Count Cut" }));
    const blockers = await screen.findByTestId("count-blockers");
    expect(blockers.textContent).toContain(DEVICE);
    expect(blockers.textContent).toContain("holds a pending, failed or held sale");
    expect(blockers.textContent).toContain("Stores - RT");
    expect(blockers.textContent).toContain("No stock import has completed since the cut request");
    expect(screen.getByTestId("count-outcome").textContent).toContain("No cut was recorded");
  });

  test("a cut refusal without details still shows the typed refusal and no blocker list", async () => {
    count.takeCountCut.mockResolvedValue(conflict("count_cut_barrier_not_met"));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Take the Count Cut" }));
    await screen.findByTestId("count-outcome");
    expect(screen.queryByTestId("count-blockers")).toBeNull();
  });

  test("the 404 of a tenant without Count Sessions reads as not enabled, not as a failure", async () => {
    count.listCountSessions.mockResolvedValue({ status: 404 });
    renderList();
    expect(
      await screen.findByText(/Stock counts are not enabled for this tenant, or this store/),
    ).toBeDefined();
  });

  test("only the owner is offered the self-approval setting", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderList();
    await screen.findByRole("heading", { name: "Open a count session" });
    expect(screen.queryByRole("heading", { name: "Small-shop self-approval" })).toBeNull();
    expect(count.getCountSelfApprovalSetting).not.toHaveBeenCalled();
  });

  test("the owner enables self-approval with a reason; the reason is required first", async () => {
    count.setCountSelfApprovalSetting.mockResolvedValue(
      ok({
        enabled: true,
        reason: "One person runs this shop",
        changedAt: "2026-11-16T10:00:00Z",
        changedBy: ME,
      }),
    );
    renderList();
    expect(await screen.findByText("Self-approval is not allowed.")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Allow self-approval of counts"));
    fireEvent.click(screen.getByRole("button", { name: "Save setting" }));
    expect(await screen.findByText("Write the reason for allowing self-approval.")).toBeDefined();
    expect(count.setCountSelfApprovalSetting).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for allowing it"), {
      target: { value: " One person runs this shop " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save setting" }));
    await waitFor(() => expect(count.setCountSelfApprovalSetting).toHaveBeenCalledTimes(1));
    expect(count.setCountSelfApprovalSetting.mock.calls[0][0]).toEqual({
      enabled: true,
      reason: "One person runs this shop",
    });
  });

  test("disabling sends no reason, and the server's owner-only refusal is shown by its code", async () => {
    count.getCountSelfApprovalSetting.mockResolvedValue(
      ok({ enabled: true, reason: "x", changedAt: "2026-11-16T10:00:00Z", changedBy: ME }),
    );
    count.setCountSelfApprovalSetting.mockResolvedValue({
      status: 403,
      error: {
        error: { code: "count_self_approval_owner_only", message: "w", request_id: REQUEST_ID },
      },
    });
    renderList();
    fireEvent.click(await screen.findByLabelText("Allow self-approval of counts"));
    fireEvent.click(screen.getByRole("button", { name: "Save setting" }));
    const outcome = await screen.findByTestId("count-outcome");
    expect(outcome.textContent).toContain("Only the tenant owner can read or change this setting");
    expect(outcome.textContent).toContain("count_self_approval_owner_only");
    expect(count.setCountSelfApprovalSetting.mock.calls[0][0]).toEqual({ enabled: false });
  });
});

// --- Variance review, acknowledgement, recount, approval ------------------------------------------

describe("variance review and approval (RT-1425)", () => {
  const submitted = () =>
    session({ state: "submitted", cut: CUT, counterIds: ["other"], submittedBy: "other" });

  test("shows the exact expected, counted and variance with flags and per-position counts", async () => {
    count.getCountSession.mockResolvedValue(ok(submitted()));
    count.listCountVarianceLines.mockResolvedValue(page([flagged(P1), line(P2)]));
    renderDetail();
    const rows = await screen.findAllByTestId("count-line");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("10.0000");
    expect(rows[0].textContent).toContain("7.0000");
    expect(within(rows[0]).getByTestId("count-variance").textContent).toBe("-3.0000");
    expect(rows[0].textContent).toContain("Differs from ERPNext");
    expect(rows[0].textContent).toContain("Main shelf");
    expect(rows[0].textContent).toContain("Olive oil");
  });

  test("approval needs every flagged line acknowledged, then sends each lineVersion with a key", async () => {
    count.getCountSession.mockResolvedValue(ok(submitted()));
    count.listCountVarianceLines.mockResolvedValue(page([flagged(P1, "4"), line(P2)]));
    count.approveCountSession.mockResolvedValue(ok(session({ state: "approved" })));
    renderDetail();
    const approve = await screen.findByRole("button", { name: "Approve the count" });
    await waitFor(() =>
      expect(screen.getByTestId("count-ack-progress").textContent).toContain("1 flagged line"),
    );
    expect(approve.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Confirm review of Olive oil"));
    await waitFor(() => expect(approve.getAttribute("disabled")).toBeNull());
    fireEvent.click(approve);
    await waitFor(() => expect(count.approveCountSession).toHaveBeenCalledTimes(1));
    const [storeId, sessionId, body, key] = count.approveCountSession.mock.calls[0];
    expect([storeId, sessionId]).toEqual([STORE, SESSION]);
    expect(body).toEqual({ acknowledgements: [{ productId: P1, lineVersion: "4" }] });
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  test("every page of lines is loaded before approval is possible", async () => {
    count.getCountSession.mockResolvedValue(ok(submitted()));
    count.listCountVarianceLines
      .mockResolvedValueOnce(page([line(P1)], "next"))
      .mockResolvedValueOnce(page([flagged(P2)]));
    renderDetail();
    await waitFor(() => expect(count.listCountVarianceLines).toHaveBeenCalledTimes(2));
    expect(count.listCountVarianceLines.mock.calls[1][2]).toEqual({ cursor: "next" });
    expect(await screen.findAllByTestId("count-line")).toHaveLength(2);
    const approve = screen.getByRole("button", { name: "Approve the count" });
    // The second page's flagged line is not acknowledged yet.
    expect(approve.getAttribute("disabled")).not.toBeNull();
  });

  test("a line the server refuses cannot be acknowledged into posting and shows why", async () => {
    count.getCountSession.mockResolvedValue(ok(submitted()));
    count.listCountVarianceLines.mockResolvedValue(
      page([
        line(P1, {
          flags: ["unmapped"],
          acknowledgementRequired: true,
          refusal: { code: "count_line_unmapped", message: "x" },
        }),
      ]),
    );
    renderDetail();
    const row = await screen.findByTestId("count-line");
    expect(row.textContent).toContain("not mapped to an ERPNext item");
    expect(row.textContent).toContain("Will not post");
    expect(within(row).queryByLabelText(/Confirm review of/)).toBeNull();
    // The rest proceeds: a refused line does not block approval.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Approve the count" }).getAttribute("disabled"),
      ).toBeNull(),
    );
  });

  test("a stale line refusal re-reads the lines and drops the acknowledgement", async () => {
    count.getCountSession.mockResolvedValue(ok(submitted()));
    count.listCountVarianceLines
      .mockResolvedValueOnce(page([flagged(P1, "1")]))
      .mockResolvedValue(page([flagged(P1, "2")]));
    count.approveCountSession.mockResolvedValue(conflict("count_line_version_stale"));
    renderDetail();
    fireEvent.click(await screen.findByLabelText("Confirm review of Olive oil"));
    fireEvent.click(screen.getByRole("button", { name: "Approve the count" }));
    const outcome = await screen.findByTestId("count-outcome");
    expect(outcome.textContent).toContain("A line changed after you reviewed it");
    await waitFor(() => expect(count.listCountVarianceLines).toHaveBeenCalledTimes(2));
    const box = (await screen.findByLabelText("Confirm review of Olive oil")) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(false));
    expect(
      screen.getByRole("button", { name: "Approve the count" }).getAttribute("disabled"),
    ).not.toBeNull();
  });

  test("the separate-approver refusal is the server's: the viewer's part is only advised, never blocked", async () => {
    count.getCountSession.mockResolvedValue(
      ok(session({ state: "submitted", cut: CUT, counterIds: [ME], submittedBy: ME })),
    );
    count.listCountVarianceLines.mockResolvedValue(page([line(P1)]));
    count.approveCountSession.mockResolvedValue(conflict("count_approver_conflict"));
    renderDetail();
    expect(await screen.findByTestId("count-took-part")).toBeDefined();
    const approve = await screen.findByRole("button", { name: "Approve the count" });
    await waitFor(() => expect(approve.getAttribute("disabled")).toBeNull());
    fireEvent.click(approve);
    const outcome = await screen.findByTestId("count-outcome");
    expect(outcome.textContent).toContain("cannot approve, unless the tenant owner enabled");
    expect(outcome.textContent).toContain("count_approver_conflict");
  });

  test("recount needs a reason and sends the chosen products back", async () => {
    count.getCountSession.mockResolvedValue(ok(submitted()));
    count.listCountVarianceLines.mockResolvedValue(page([line(P1), line(P2)]));
    count.requestCountRecount.mockResolvedValue(ok(session({ state: "cut_taken", cut: CUT })));
    renderDetail();
    fireEvent.click(await screen.findByLabelText("Recount Olive oil"));
    const send = screen.getByRole("button", { name: "Recount 1 product" });
    fireEvent.click(send);
    expect(await screen.findByText("Write the reason for the recount.")).toBeDefined();
    expect(count.requestCountRecount).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for the recount"), {
      target: { value: "Looks short" },
    });
    fireEvent.click(send);
    await waitFor(() => expect(count.requestCountRecount).toHaveBeenCalledTimes(1));
    const [, , body, key] = count.requestCountRecount.mock.calls[0];
    expect(body).toEqual({ productIds: [P1], reason: "Looks short" });
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  test("a failed lines read says so and offers a retry; the session facts stay", async () => {
    count.getCountSession.mockResolvedValue(ok(submitted()));
    count.listCountVarianceLines.mockResolvedValue({ status: 500 });
    renderDetail();
    expect(await screen.findByText("Variances could not be loaded.")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Status" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Approve the count" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Approve the count" }).getAttribute("disabled"),
    ).not.toBeNull();
  });
});

// --- Approval marker, ERP status, late events -------------------------------------------------------

describe("approval marker, ERP status and late events (RT-1425)", () => {
  const approval = (selfApproved: boolean) => ({
    approvedBy: ME,
    approvedAt: "2026-11-16T09:30:00Z",
    policy: selfApproved ? "small_merchant_exception" : "strict_separation",
    selfApproved,
  });

  test("a self-approved session carries a visible badge and the exception policy text", async () => {
    count.getCountSession.mockResolvedValue(
      ok(session({ state: "approved", cut: CUT, approval: approval(true) })),
    );
    count.listCountVarianceLines.mockResolvedValue(page([line(P1)]));
    renderDetail();
    const marker = await screen.findByTestId("count-self-approved");
    expect(marker.textContent).toContain("Self-approved");
    expect(screen.getByText(/Small-shop exception/)).toBeDefined();
  });

  test("a separately approved session has no self-approval marker", async () => {
    count.getCountSession.mockResolvedValue(
      ok(session({ state: "approved", cut: CUT, approval: approval(false) })),
    );
    renderDetail();
    expect(await screen.findByText(/Approved by another person/)).toBeDefined();
    expect(screen.queryByTestId("count-self-approved")).toBeNull();
  });

  test.each([
    ["posting", /being posted to ERPNext/],
    ["confirmed", /ERPNext confirmed the result/],
    ["needs_attention", /needs attention: the posting was rejected/],
  ])("ERP status %s is rendered from the server state only", async (state, text) => {
    count.getCountSession.mockResolvedValue(
      ok(session({ state, cut: CUT, approval: approval(false) })),
    );
    renderDetail();
    const panel = await screen.findByTestId("count-erp-status");
    // A status banner mounts empty and fills on the next task (live-region rule).
    await waitFor(() => expect(panel.textContent).toMatch(text));
  });

  test("no ERP status line, no activation toggle and no resolve action appear before approval", async () => {
    count.getCountSession.mockResolvedValue(ok(session({ state: "cut_taken", cut: CUT })));
    renderDetail();
    await screen.findByRole("heading", { name: "Status" });
    expect(screen.queryByTestId("count-erp-status")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /resolve|activate|compensat/i })).toBeNull();
  });

  test("late pre-cut findings list the assessment, risk and linked event, with no resolve action", async () => {
    count.getCountSession.mockResolvedValue(
      ok(
        session({
          state: "needs_attention",
          cut: CUT,
          approval: approval(false),
          lateEventFindingCount: 1,
        }),
      ),
    );
    count.listCountVarianceLines.mockResolvedValue(page([line(P1)]));
    count.listCountLateEventFindings.mockResolvedValue(
      page([
        {
          id: "0190f000-0000-7000-8000-0000000006f1",
          sessionId: SESSION,
          productId: P1,
          assessment: "overstated",
          quantity: "2.0000",
          linkedEvent: {
            eventType: "sale",
            reference: "SALE-77",
            sourceSystem: "pos",
            externalId: "ext-1",
            effectId: null,
          },
          oversellRisk: true,
          erpStamp: "2026-11-16T08:10:00Z",
          detectedAt: "2026-11-16T09:40:00Z",
          detectedInState: "approved",
        },
      ]),
    );
    renderDetail();
    const table = await screen.findByRole("table", { name: /Late event findings/ });
    expect(table.textContent).toContain("The count overstates availability");
    expect(table.textContent).toContain("Oversell risk");
    expect(table.textContent).toContain("SALE-77");
    expect(table.textContent).toContain("2.0000");
    expect(screen.queryByRole("button", { name: /resolve/i })).toBeNull();
  });

  test("a session that is not found reads as not available (non-disclosing)", async () => {
    count.getCountSession.mockResolvedValue({
      status: 404,
      error: { error: { code: "not_found", message: "x", request_id: REQUEST_ID } },
    });
    renderDetail();
    expect(await screen.findByText(/Stock counts are not enabled for this tenant/)).toBeDefined();
  });
});

// --- Arabic and accessibility ----------------------------------------------------------------------

describe("Arabic, keyboard and screen-reader support (RT-1425)", () => {
  test("the review renders in Arabic with machine data isolated LTR", async () => {
    setLocale("ar");
    count.getCountSession.mockResolvedValue(
      ok(session({ state: "submitted", cut: CUT, counterIds: ["other"], submittedBy: "other" })),
    );
    count.listCountVarianceLines.mockResolvedValue(page([flagged(P1)]));
    renderDetail();
    expect(await screen.findByRole("heading", { name: "مراجعة الفروقات" })).toBeDefined();
    const row = await screen.findByTestId("count-line");
    expect(row.textContent).toContain("اختلاف عن ERPNext");
    const variance = within(row).getByTestId("count-variance").querySelector("bdi");
    expect(variance?.getAttribute("dir")).toBe("ltr");
    expect(document.body.textContent).not.toMatch(/counts\.[a-z]+\.[a-z]/);
  });

  test("every capture control has a label and a refusal is announced as an alert", async () => {
    count.takeCountCut.mockResolvedValue(conflict("count_cut_barrier_not_met"));
    renderDetail();
    await screen.findByRole("heading", { name: "Counting" });
    for (const label of [
      "Product",
      "Stock location",
      "Status",
      "Counted quantity",
      "Counted unit",
    ]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
    fireEvent.click(screen.getByRole("button", { name: "Take the Count Cut" }));
    expect(await screen.findByRole("alert")).toBeDefined();
  });
});
