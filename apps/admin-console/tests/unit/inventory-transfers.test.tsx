import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = {
  listStoreMovements: vi.fn(),
  listStockLocations: vi.fn(),
  getOnHand: vi.fn(),
  listTrackingIdentities: vi.fn(),
  listShipmentTransfers: vi.fn(),
  getShipmentTransfer: vi.fn(),
  listShipmentTransferReceipts: vi.fn(),
};
vi.mock("@/lib/inventory-queries", () => ({
  listStoreMovements: (...a: unknown[]) => api.listStoreMovements(...a),
  listStockLocations: (...a: unknown[]) => api.listStockLocations(...a),
  getOnHand: (...a: unknown[]) => api.getOnHand(...a),
  listTrackingIdentities: (...a: unknown[]) => api.listTrackingIdentities(...a),
  listShipmentTransfers: (...a: unknown[]) => api.listShipmentTransfers(...a),
  getShipmentTransfer: (...a: unknown[]) => api.getShipmentTransfer(...a),
  listShipmentTransferReceipts: (...a: unknown[]) => api.listShipmentTransferReceipts(...a),
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

import { InventoryStores } from "@/inventory/InventoryStores";
import { InventoryTransfers } from "@/inventory/transfers/InventoryTransfers";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";

const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const ALEX = "0190f000-0000-7000-8000-0000000007a2";
const UNLISTED = "0190f000-0000-7000-8000-0000000007a9";
const T1 = "0190f000-0000-7000-8000-00000000a001";
const T2 = "0190f000-0000-7000-8000-00000000a002";
const LINE = "0190f000-0000-7000-8000-00000000b001";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const BATCH = "0190f000-0000-7000-8000-0000000007f1";
const ME = "0190f000-0000-7000-8000-0000000000a1";
const REQUEST_ID = "0190f000-0000-7000-8000-0000000007e1";

function ctx(role: string | null = "owner", tenant = true) {
  return {
    context: {
      user: { id: ME, display_name: "Amal Saleh" },
      active_tenant: tenant ? { id: "t1", name: "Northstar Retail" } : null,
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
const failure = (status: number, code?: string) => ({
  status,
  error: code ? { error: { code, message: "server words", request_id: REQUEST_ID } } : undefined,
});

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    id: T1,
    sourceStoreId: CAIRO,
    destinationStoreId: ALEX,
    state: "in_transit",
    lines: [
      {
        id: LINE,
        lineSeq: 1,
        tenantProductRef: PRODUCT,
        stockingUnit: "kg",
        trackingIdentityId: BATCH,
        quantity: "10.0000",
        dispatchedQuantity: "10.0000",
        receivedQuantity: "4.0000",
        shortClosedQuantity: "0.0000",
        inTransitQuantity: "6.0000",
        dispatchMovementId: null,
      },
    ],
    reason: "Weekend restock",
    createdBy: ME,
    createdAt: "2026-11-20T08:00:00Z",
    approval: { by: ME, at: "2026-11-20T09:00:00Z" },
    reservation: null,
    dispatch: { by: ME, at: "2026-11-20T10:00:00Z" },
    dispatchIntegrationState: "confirmed",
    shortClose: null,
    closure: null,
    cancellation: null,
    receiptCount: 1,
    updatedAt: "2026-11-20T10:00:00Z",
    ...overrides,
  };
}

const receipt = {
  id: "0190f000-0000-7000-8000-00000000c001",
  transferId: T1,
  receivedBy: ME,
  receivedAt: "2026-11-21T08:00:00Z",
  note: "Two cartons wet",
  integrationState: "pending",
  lines: [
    {
      transferLineId: LINE,
      quantity: "4.0000",
      inventoryStatus: "damaged",
      stockLocationId: "0190f000-0000-7000-8000-0000000007d1",
      movementId: "0190f000-0000-7000-8000-0000000007d2",
    },
  ],
};

const stores = [
  { id: CAIRO, code: "CAI", name: "Cairo Festival", timezone: "Africa/Cairo", is_active: true },
  { id: ALEX, code: "ALX", name: "Alexandria", timezone: "Africa/Cairo", is_active: true },
];

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

function renderAt(entry = "/inventory/transfers"): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/inventory" element={<InventoryStores />} />
          <Route path="/inventory/transfers" element={<InventoryTransfers />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  listStores.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  listStores.mockResolvedValue({ status: 200, data: stores });
  api.listShipmentTransfers.mockResolvedValue(page([transfer()]));
  api.getShipmentTransfer.mockResolvedValue(ok(transfer()));
  api.listShipmentTransferReceipts.mockResolvedValue(page([receipt]));
});
afterEach(cleanup);

const table = () => screen.getByRole("table", { name: "Stock transfers, newest first" });
/** The skeleton shares the table's caption: the list is loaded once a row's Open control shows. */
const loaded = () => screen.findAllByRole("button", { name: /Open transfer details/ });

describe("transfers gate (RT-1515)", () => {
  test.each(["store_staff", "cashier", null])(
    "%s gets NoAccess and nothing is requested",
    (role) => {
      activeContext.mockReturnValue(ctx(role));
      renderAt();
      expect(screen.queryByText("Stock transfers")).toBeNull();
      expect(api.listShipmentTransfers).not.toHaveBeenCalled();
    },
  );

  test.each(["owner", "tenant_admin", "store_manager"])("%s may read the list", async (role) => {
    activeContext.mockReturnValue(ctx(role));
    renderAt();
    expect(
      await screen.findByRole("table", { name: "Stock transfers, newest first" }),
    ).toBeDefined();
  });

  test("without a tenant it asks for one and requests nothing", () => {
    activeContext.mockReturnValue(ctx("owner", false));
    renderAt();
    expect(screen.getByText(/Choose a tenant/)).toBeDefined();
    expect(api.listShipmentTransfers).not.toHaveBeenCalled();
  });

  test("the Inventory page carries the entry to the transfers", async () => {
    renderAt("/inventory");
    const link = await screen.findByRole("link", { name: "Stock transfers between stores" });
    expect(link.getAttribute("href")).toBe("/inventory/transfers");
  });
});

describe("transfer list (RT-1515)", () => {
  test("shows each Transfer newest first: route by store name, state, counts, dispatch leg", async () => {
    renderAt();
    expect(screen.getByText("Loading transfers…")).toBeDefined();
    await loaded();
    const row = within(table()).getAllByRole("row")[1];
    await within(row).findByText("Cairo Festival");
    expect(within(row).getByText("Alexandria")).toBeDefined();
    expect(within(row).getByText("In transit")).toBeDefined();
    expect(within(row).getByText("Confirmed by ERPNext")).toBeDefined();
    expect(api.listShipmentTransfers).toHaveBeenCalledWith({}, {});
  });

  test("a store the store list does not name shows its id, LTR-isolated", async () => {
    api.listShipmentTransfers.mockResolvedValue(
      page([
        transfer({ destinationStoreId: UNLISTED, dispatchIntegrationState: null, state: "draft" }),
      ]),
    );
    renderAt();
    const cell = await screen.findByText(UNLISTED);
    expect(cell.getAttribute("dir")).toBe("ltr");
    expect(screen.getByText("Not dispatched yet")).toBeDefined();
    expect(within(table()).getByText("Draft")).toBeDefined();
  });

  test("empty: no transfers yet, with no reset offered", async () => {
    api.listShipmentTransfers.mockResolvedValue(page([]));
    renderAt();
    expect(await screen.findByText("There are no stock transfers yet.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
  });

  test("filtered-empty offers a reset that clears the filters", async () => {
    api.listShipmentTransfers.mockResolvedValue(page([]));
    renderAt("/inventory/transfers?state=closed");
    expect(await screen.findByText("No transfers match the filters.")).toBeDefined();
    expect(api.listShipmentTransfers).toHaveBeenCalledWith({ state: "closed" }, {});
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/inventory/transfers"),
    );
    await waitFor(() => expect(api.listShipmentTransfers).toHaveBeenLastCalledWith({}, {}));
  });

  test("filters are the contract's: a state, a store, then a direction for that store", async () => {
    renderAt();
    await loaded();
    expect(screen.queryByLabelText("Direction")).toBeNull();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "received" } });
    await waitFor(() =>
      expect(api.listShipmentTransfers).toHaveBeenLastCalledWith({ state: "received" }, {}),
    );
    const storeSelect = screen.getByLabelText("Store");
    await within(storeSelect).findByRole("option", { name: "Cairo Festival" });
    fireEvent.change(storeSelect, { target: { value: CAIRO } });
    await waitFor(() =>
      expect(api.listShipmentTransfers).toHaveBeenLastCalledWith(
        { storeId: CAIRO, state: "received" },
        {},
      ),
    );
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "outbound" } });
    await waitFor(() =>
      expect(api.listShipmentTransfers).toHaveBeenLastCalledWith(
        { storeId: CAIRO, direction: "outbound", state: "received" },
        {},
      ),
    );
    expect(screen.getByTestId("where").textContent).toBe(
      `/inventory/transfers?store=${CAIRO}&direction=outbound&state=received`,
    );
    // Choosing all stores drops the direction with it (that list is already cached).
    fireEvent.change(screen.getByLabelText("Store"), { target: { value: "" } });
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/inventory/transfers?state=received"),
    );
    expect(screen.queryByLabelText("Direction")).toBeNull();
    expect(api.listShipmentTransfers).not.toHaveBeenCalledWith(
      expect.objectContaining({ direction: expect.anything(), storeId: undefined }),
      expect.anything(),
    );
  });

  test("a store the URL names but the picker does not list stays chosen", async () => {
    renderAt(`/inventory/transfers?store=${UNLISTED}`);
    await loaded();
    expect((screen.getByLabelText("Store") as HTMLSelectElement).value).toBe(UNLISTED);
  });

  test("the 404 while transfers are off reads as not available, never as empty", async () => {
    api.listShipmentTransfers.mockResolvedValue(failure(404, "not_found"));
    renderAt();
    expect(
      await screen.findByText("Stock transfers are not available for this organization."),
    ).toBeDefined();
    expect(screen.getByText(/may not be switched on for the organization yet/)).toBeDefined();
    expect(screen.queryByText("There are no stock transfers yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    expect(screen.getByText(REQUEST_ID)).toBeDefined();
    expect(screen.queryByText("server words")).toBeNull();
  });

  test("a failed store list says so and retries, while the transfers stay listed", async () => {
    listStores
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValue({ status: 200, data: stores });
    renderAt();
    expect(await screen.findByText("Stores could not be loaded.")).toBeDefined();
    expect(screen.getByRole("table", { name: /transfers/i })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Stores could not be loaded.")).toBeNull());
  });

  test("a filtered 404 also offers the reset", async () => {
    api.listShipmentTransfers.mockResolvedValue(failure(404, "not_found"));
    renderAt(`/inventory/transfers?store=${CAIRO}`);
    expect(await screen.findByText(/or the chosen store is not available to you/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeDefined();
  });

  test("an error is worded by error.code, carries the request id, and retries", async () => {
    api.listShipmentTransfers.mockResolvedValue(failure(500, "internal_error"));
    renderAt();
    expect(await screen.findByText("Could not load the transfers.")).toBeDefined();
    expect(screen.getByText(REQUEST_ID)).toBeDefined();
    expect(screen.queryByText("server words")).toBeNull();
    api.listShipmentTransfers.mockResolvedValue(page([transfer()]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("table", { name: "Stock transfers, newest first" }),
    ).toBeDefined();
  });

  test("the code wins over the status: forbidden on a 500 reads as forbidden", async () => {
    api.listShipmentTransfers.mockResolvedValue(failure(500, "forbidden"));
    renderAt();
    expect(await screen.findByText("This section is not available to your role.")).toBeDefined();
  });

  test("a failed continuation keeps the loaded rows and retries at the boundary", async () => {
    api.listShipmentTransfers
      .mockResolvedValueOnce(page([transfer()], "c2"))
      .mockResolvedValueOnce(failure(500, "internal_error"))
      .mockResolvedValueOnce(page([transfer({ id: T2, state: "received" })]));
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Load older transfers" }));
    expect(
      await screen.findByText(
        "This section could not be refreshed. Showing the last successful read.",
      ),
    ).toBeDefined();
    expect(within(table()).getAllByRole("row")).toHaveLength(2);
    expect(api.listShipmentTransfers).toHaveBeenLastCalledWith({}, { cursor: "c2" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(table()).getAllByRole("row")).toHaveLength(3));
    expect(api.listShipmentTransfers).toHaveBeenLastCalledWith({}, { cursor: "c2" });
    expect(screen.queryByRole("button", { name: "Load older transfers" })).toBeNull();
  });
});

describe("transfer drawer (RT-1515)", () => {
  async function openFirst() {
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Open transfer details/ }));
    return screen.getByRole("dialog", { name: "Transfer details" });
  }

  test("shows the route, state, stamps, labelled line quantities and the dispatch leg", async () => {
    const dialog = await openFirst();
    expect(api.getShipmentTransfer).toHaveBeenCalledWith(T1);
    const lines = await within(dialog).findByRole("table", {
      name: "The transfer's lines and their quantities",
    });
    for (const header of ["Ordered", "Dispatched", "Received", "Short-closed", "In transit"]) {
      expect(within(lines).getByRole("columnheader", { name: header })).toBeDefined();
    }
    expect(within(lines).queryByRole("columnheader", { name: /^Stock$/ })).toBeNull();
    expect(within(lines).getByText("6.0000")).toBeDefined();
    expect(within(lines).getByText(BATCH)).toBeDefined();
    expect(within(dialog).getByText("Approved")).toBeDefined();
    expect(within(dialog).getAllByText("Dispatched").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Weekend restock")).toBeDefined();
    expect(within(dialog).getByText("Confirmed by ERPNext")).toBeDefined();
    expect(within(dialog).queryByText(/available to sell/i)).toBeNull();
  });

  test("lists the receipts with their line, landed status and receipt leg", async () => {
    const dialog = await openFirst();
    const receipts = await within(dialog).findByRole("table", {
      name: "The transfer's receipts, oldest first",
    });
    expect(api.listShipmentTransferReceipts).toHaveBeenCalledWith(T1, {});
    expect(within(receipts).getByText("Damaged")).toBeDefined();
    expect(within(receipts).getByText("Posting")).toBeDefined();
    expect(within(receipts).getByText("Two cartons wet")).toBeDefined();
    expect(within(receipts).getByText("4.0000")).toBeDefined();
  });

  test("a closed, short-closed Transfer shows its reasons; no receipt is an empty state", async () => {
    api.getShipmentTransfer.mockResolvedValue(
      ok(
        transfer({
          state: "closed",
          trackingIdentityId: null,
          lines: [{ ...transfer().lines[0], trackingIdentityId: null }],
          shortClose: {
            approvedBy: ME,
            approvedAt: "2026-11-22T08:00:00Z",
            reason: "Lost on road",
          },
          closure: { by: ME, at: "2026-11-22T09:00:00Z" },
        }),
      ),
    );
    api.listShipmentTransferReceipts.mockResolvedValue(page([]));
    const dialog = await openFirst();
    expect(await within(dialog).findByText("Lost on road")).toBeDefined();
    expect(within(dialog).getByText("Short-close approved")).toBeDefined();
    expect(
      await within(dialog).findByText("No receipt has been recorded for this transfer yet."),
    ).toBeDefined();
  });

  test("a cancelled Transfer shows its cancellation reason", async () => {
    api.getShipmentTransfer.mockResolvedValue(
      ok(
        transfer({
          state: "cancelled",
          dispatch: null,
          dispatchIntegrationState: null,
          cancellation: {
            cancelledBy: ME,
            cancelledAt: "2026-11-20T11:00:00Z",
            reason: "Wrong store",
          },
        }),
      ),
    );
    const dialog = await openFirst();
    expect(await within(dialog).findByText("Wrong store")).toBeDefined();
    expect(within(dialog).getByText("Cancellation reason")).toBeDefined();
  });

  test("a failed read of the Transfer says so by code", async () => {
    api.getShipmentTransfer.mockResolvedValue(failure(404, "not_found"));
    const dialog = await openFirst();
    expect(await within(dialog).findByText("This transfer is not available.")).toBeDefined();
  });

  test("a failed receipts read keeps the Transfer and offers a retry", async () => {
    api.listShipmentTransferReceipts.mockResolvedValue(failure(500, "internal_error"));
    const dialog = await openFirst();
    expect(await within(dialog).findByText("Could not load the receipts.")).toBeDefined();
    expect(
      within(dialog).getByRole("table", { name: "The transfer's lines and their quantities" }),
    ).toBeDefined();
  });

  test("closing the drawer keeps the list and its filters", async () => {
    renderAt("/inventory/transfers?state=in_transit");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Open transfer details/ }));
    const dialog = screen.getByRole("dialog", { name: "Transfer details" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(table()).toBeDefined();
    expect(screen.getByTestId("where").textContent).toBe("/inventory/transfers?state=in_transit");
  });
});
