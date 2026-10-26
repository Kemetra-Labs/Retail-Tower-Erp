import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = {
  listStoreMovements: vi.fn(),
  listStockLocations: vi.fn(),
  getOnHand: vi.fn(),
  listTrackingIdentities: vi.fn(),
  createStatusMove: vi.fn(),
};
vi.mock("@/lib/inventory-queries", () => ({
  listStoreMovements: (...a: unknown[]) => api.listStoreMovements(...a),
  listStockLocations: (...a: unknown[]) => api.listStockLocations(...a),
  getOnHand: (...a: unknown[]) => api.getOnHand(...a),
  listTrackingIdentities: (...a: unknown[]) => api.listTrackingIdentities(...a),
  createStatusMove: (...a: unknown[]) => api.createStatusMove(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { InventoryProduct } from "@/inventory/InventoryProduct";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const PRIMARY = "0190f000-0000-7000-8000-0000000007d1";
const BACKROOM = "0190f000-0000-7000-8000-0000000007d2";
const REQUEST_ID = "0190f000-0000-7000-8000-0000000007e1";

function ctx(role: string | null) {
  return {
    context: {
      user: { id: "u1", display_name: "Amal Saleh" },
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
const location = (id: string, kind: string, name: string, isActive = true) => ({
  id,
  storeId: STORE,
  code: name.toUpperCase(),
  name,
  kind,
  isActive,
});
const onHand = {
  storeId: STORE,
  productId: PRODUCT,
  quantity: "10.0000",
  stockingUnit: "kg",
  negativeBalance: false,
  sellableQuantity: "8.0000",
  statusQuantities: [
    { inventoryStatus: "sellable", quantity: "8.0000" },
    { inventoryStatus: "return_inspection", quantity: "1.0000" },
    { inventoryStatus: "quality_hold", quantity: "0.0000" },
    { inventoryStatus: "damaged", quantity: "1.0000" },
    { inventoryStatus: "expired", quantity: "0.0000" },
    { inventoryStatus: "recall_hold", quantity: "0.0000" },
  ],
};

function renderProduct(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/inventory/stores/${STORE}/products/${PRODUCT}`]}>
        <Routes>
          <Route
            path="/inventory/stores/:storeId/products/:productId"
            element={<InventoryProduct />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  api.listStockLocations.mockResolvedValue(ok({ items: [location(PRIMARY, "primary", "Main")] }));
  api.getOnHand.mockResolvedValue(ok(onHand));
  api.listTrackingIdentities.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.createStatusMove.mockResolvedValue({ status: 201, data: {} });
});
afterEach(cleanup);

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function fillDamage(quantity = "2.5"): Promise<void> {
  await screen.findByRole("heading", { name: "Move stock between statuses" });
  // The stocking unit comes from the on-hand read: wait for it before submitting.
  await waitFor(() => expect(screen.getByTestId("on-hand-quantity").textContent).toContain("kg"));
  type(/^Quantity/, quantity);
}

describe("quantity labels (RT-436)", () => {
  test("Physical, Sellable and ERP Book are each labelled; no bare Stock label", async () => {
    renderProduct();
    expect((await screen.findByTestId("on-hand-quantity")).textContent).toContain("10.0000");
    expect(screen.getByTestId("on-hand-sellable").textContent).toContain("8.0000");
    expect(screen.getByText("ERP Book (ERPNext snapshot)")).toBeDefined();
    expect(screen.getByText("Physical on-hand", { selector: "dt" })).toBeDefined();
    expect(screen.getByText("Sellable", { selector: "dt" })).toBeDefined();
    expect(document.body.textContent).not.toMatch(/\bStock\b(?! (locations|movement|between))/);
  });

  test("ERP Book shows no number, only a link to the store's ERPNext snapshot view", async () => {
    renderProduct();
    const erp = await screen.findByTestId("on-hand-erp-book");
    expect(erp.textContent).not.toMatch(/\d/);
    const link = erp.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/stock-discrepancies/${STORE}`);
  });
});

describe("status move form gate (RT-436)", () => {
  test.each(["cashier", "auditor"])("%s gets no form (and no locations read)", async (role) => {
    activeContext.mockReturnValue(ctx(role));
    renderProduct();
    await waitFor(() => expect(api.listStockLocations).not.toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Move stock between statuses" })).toBeNull();
  });

  test("store_manager cannot pick damaged or expired as the source", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderProduct();
    await screen.findByRole("heading", { name: "Move stock between statuses" });
    const from = [...select("Move from").options].map((o) => o.textContent);
    expect(from).toEqual(["Sellable", "Return inspection"]);
  });

  test("owner can pick damaged as the source; holds are never offered", async () => {
    renderProduct();
    await screen.findByRole("heading", { name: "Move stock between statuses" });
    const from = [...select("Move from").options].map((o) => o.textContent);
    expect(from).toContain("Damaged");
    const all = [...from, ...[...select("Move to").options].map((o) => o.textContent)];
    expect(all).not.toContain("Quality hold");
    expect(all).not.toContain("Recall hold");
  });
});

describe("status move submit (RT-436)", () => {
  test("a Sellable to Damaged move sends the strict command with an Idempotency-Key", async () => {
    renderProduct();
    await fillDamage();
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    await waitFor(() => expect(api.createStatusMove).toHaveBeenCalledTimes(1));
    const [storeId, command, key] = api.createStatusMove.mock.calls[0];
    expect(storeId).toBe(STORE);
    expect(command).toEqual({
      tenantProductRef: PRODUCT,
      quantity: "2.5",
      stockingUnit: "kg",
      fromStatus: "sellable",
      toStatus: "damaged",
      reasonCode: "damage",
    });
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(await screen.findByText(/Status move recorded/)).toBeDefined();
    // The on-hand is re-read from the server, never edited in place.
    await waitFor(() => expect(api.getOnHand.mock.calls.length).toBeGreaterThan(1));
  });

  test("an invalid quantity is refused before any request", async () => {
    renderProduct();
    await fillDamage("0");
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    expect(await screen.findByText(/Enter a quantity above zero/)).toBeDefined();
    expect(api.createStatusMove).not.toHaveBeenCalled();
  });

  test("Return inspection to Sellable uses its own reason code", async () => {
    renderProduct();
    await fillDamage("1");
    fireEvent.change(select("Move from"), { target: { value: "return_inspection" } });
    fireEvent.change(select("Move to"), { target: { value: "sellable" } });
    expect(select("Reason").value).toBe("inspection_restock");
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    await waitFor(() => expect(api.createStatusMove).toHaveBeenCalled());
    expect(api.createStatusMove.mock.calls[0][1]).toMatchObject({
      fromStatus: "return_inspection",
      toStatus: "sellable",
      reasonCode: "inspection_restock",
    });
  });

  test("a correction needs a note before it is sent", async () => {
    renderProduct();
    await fillDamage("1");
    fireEvent.change(select("Reason"), { target: { value: "correction" } });
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    expect(await screen.findByText(/a correction needs one/)).toBeDefined();
    expect(api.createStatusMove).not.toHaveBeenCalled();
  });

  test("a backend refusal is shown verbatim with its code and request id", async () => {
    api.createStatusMove.mockResolvedValue({
      status: 409,
      error: {
        error: {
          code: "tracking_identity_required",
          message: "This product is tracked; tracked moves are not supported yet.",
          request_id: REQUEST_ID,
        },
      },
    });
    renderProduct();
    await fillDamage();
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    const box = await screen.findByTestId("move-rejection");
    expect(box.textContent).toContain(
      "This product is tracked; tracked moves are not supported yet.",
    );
    expect(box.textContent).toContain("tracking_identity_required");
    expect(box.textContent).toContain(REQUEST_ID);
    expect(screen.queryByText(/Status move recorded/)).toBeNull();
  });

  test("a 403 body is shown as sent, not reworded", async () => {
    api.createStatusMove.mockResolvedValue({
      status: 403,
      error: { error: { code: "forbidden", message: "Not allowed for this store." } },
    });
    renderProduct();
    await fillDamage();
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    expect((await screen.findByTestId("move-rejection")).textContent).toContain(
      "Not allowed for this store.",
    );
  });

  test("a retry of the same command reuses its key; an edit gets a new one", async () => {
    api.createStatusMove.mockResolvedValue({ status: 502 });
    renderProduct();
    await fillDamage();
    const submit = screen.getByRole("button", { name: "Record status move" });
    fireEvent.click(submit);
    await waitFor(() => expect(api.createStatusMove).toHaveBeenCalledTimes(1));
    await screen.findByTestId("move-rejection");
    fireEvent.click(submit);
    await waitFor(() => expect(api.createStatusMove).toHaveBeenCalledTimes(2));
    expect(api.createStatusMove.mock.calls[1][2]).toBe(api.createStatusMove.mock.calls[0][2]);
    type(/^Quantity/, "3");
    fireEvent.click(submit);
    await waitFor(() => expect(api.createStatusMove).toHaveBeenCalledTimes(3));
    expect(api.createStatusMove.mock.calls[2][2]).not.toBe(api.createStatusMove.mock.calls[0][2]);
  });
});

describe("location disclosure (RT-436)", () => {
  test("a single-location store never shows a location field", async () => {
    renderProduct();
    await screen.findByRole("heading", { name: "Move stock between statuses" });
    await waitFor(() => expect(api.listStockLocations).toHaveBeenCalled());
    expect(screen.queryByLabelText("Location")).toBeNull();
  });

  test("an inactive extra location does not count", async () => {
    api.listStockLocations.mockResolvedValue(
      ok({
        items: [location(PRIMARY, "primary", "Main"), location(BACKROOM, "storage", "Back", false)],
      }),
    );
    renderProduct();
    await screen.findByRole("heading", { name: "Move stock between statuses" });
    await waitFor(() => expect(api.listStockLocations).toHaveBeenCalled());
    expect(screen.queryByLabelText("Location")).toBeNull();
  });

  test("with another active location the field appears and a choice is sent", async () => {
    api.listStockLocations.mockResolvedValue(
      ok({ items: [location(PRIMARY, "primary", "Main"), location(BACKROOM, "storage", "Back")] }),
    );
    renderProduct();
    await fillDamage();
    const field = await screen.findByLabelText("Location");
    fireEvent.change(field, { target: { value: BACKROOM } });
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    await waitFor(() => expect(api.createStatusMove).toHaveBeenCalled());
    expect(api.createStatusMove.mock.calls[0][1].stockLocationId).toBe(BACKROOM);
  });

  test("left on the primary location, no location is sent", async () => {
    api.listStockLocations.mockResolvedValue(
      ok({ items: [location(PRIMARY, "primary", "Main"), location(BACKROOM, "storage", "Back")] }),
    );
    renderProduct();
    await fillDamage();
    await screen.findByLabelText("Location");
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    await waitFor(() => expect(api.createStatusMove).toHaveBeenCalled());
    expect(api.createStatusMove.mock.calls[0][1]).not.toHaveProperty("stockLocationId");
  });
});

describe("no stocking unit (RT-436)", () => {
  test("a product with no stocking unit cannot be moved", async () => {
    api.getOnHand.mockResolvedValue(ok({ ...onHand, stockingUnit: null }));
    renderProduct();
    await screen.findByRole("heading", { name: "Move stock between statuses" });
    await waitFor(() => expect(screen.getAllByText(/stocking unit is not known/).length).toBe(1));
    type(/^Quantity/, "1");
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    expect(api.createStatusMove).not.toHaveBeenCalled();
  });
});
