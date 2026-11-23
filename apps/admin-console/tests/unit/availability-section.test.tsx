import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-1579 (RT-1511 S4): the stock quantities panel of the product page. Each
 * quantity of `OnHand.availability` (RT-1576) is its own labelled figure, shown
 * verbatim; a negative Available To Sell stays negative; On Order is "not
 * available yet" while it is null; a missing or failed read is Unknown, never
 * zero; the as-of time is the API's, in the store's zone.
 */
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
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listStores: (...a: unknown[]) => listStores(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { InventoryProduct } from "@/inventory/InventoryProduct";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";
import { AVAILABILITY_AS_OF, availability, negativeAvailability } from "./availability-fixtures";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const URL = `/inventory/stores/${STORE}/products/${PRODUCT}`;

const onHandWith = (extra: Record<string, unknown>) => ({
  storeId: STORE,
  productId: PRODUCT,
  quantity: "11.0000",
  stockingUnit: "kg",
  negativeBalance: false,
  sellableQuantity: "10.0000",
  statusQuantities: [{ inventoryStatus: "sellable", quantity: "10.0000" }],
  ...extra,
});

const ok = <T,>(data: T) => ({ status: 200, data });
const never = () => new Promise(() => undefined);
const figure = (id: string) => screen.getByTestId(`availability-${id}`).textContent;

function renderPage(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[URL]}>
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
  listStores.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue({
    context: {
      user: { id: "u1", display_name: "Amal Saleh" },
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: null,
      active_role_code: "owner",
      memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "owner" }],
    },
    switchTenant: () => {},
    switchStore: () => {},
    clearStore: () => {},
  });
  listStores.mockResolvedValue({
    status: 200,
    data: [{ id: STORE, code: "CAI", name: "Cairo", timezone: "Africa/Cairo", is_active: true }],
  });
  api.listStockLocations.mockResolvedValue(ok({ items: [] }));
  api.listStoreMovements.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.listTrackingIdentities.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.getOnHand.mockResolvedValue(ok(onHandWith({ availability: availability() })));
});
afterEach(cleanup);

describe("stock quantities panel (RT-1579)", () => {
  test("every quantity is its own labelled figure, shown as the API sent it", async () => {
    renderPage();
    const panel = await screen.findByRole("region", { name: "Stock quantities" });
    await screen.findByTestId("availability-ats");
    expect(figure("physical")).toBe("11.0000 kg");
    expect(figure("sellable")).toBe("10.0000 kg");
    expect(figure("primary-sellable")).toBe("8.0000 kg");
    expect(figure("expired")).toBe("1.0000 kg");
    expect(figure("reserved")).toBe("2.0000 kg");
    expect(figure("safety")).toBe("0.0000 kg");
    expect(figure("ats")).toBe("5.0000 kg");
    expect(figure("in-transit-inbound")).toBe("3.0000 kg");
    expect(figure("in-transit-outbound")).toBe("4.0000 kg");
    for (const label of [
      "Physical on-hand",
      "Sellable, all locations",
      "Sellable at the primary location",
      "Less: expired tracked lots",
      "Less: active reservations",
      "Less: safety protection",
      "Available to sell",
      "In transit, inbound",
      "In transit, outbound",
      "On order",
    ]) {
      expect(within(panel).getByText(label, { selector: "dt" })).toBeDefined();
    }
    // Never one generic "Stock" figure (745).
    expect(within(panel).queryByText("Stock", { selector: "dt" })).toBeNull();
  });

  test("the terms of Available To Sell sit in one group, In Transit and On Order outside it", async () => {
    renderPage();
    await screen.findByTestId("availability-ats");
    const group = (title: string) =>
      screen.getByRole("heading", { name: title }).closest(".inventory__group") as HTMLElement;
    const ats = group("Available to sell, primary location");
    for (const id of ["primary-sellable", "expired", "reserved", "safety", "ats"]) {
      expect(within(ats).getByTestId(`availability-${id}`)).toBeDefined();
    }
    const outside = group("Not part of available to sell");
    for (const id of ["in-transit-inbound", "in-transit-outbound", "on-order"]) {
      expect(within(outside).getByTestId(`availability-${id}`)).toBeDefined();
    }
    expect(within(ats).queryByTestId("availability-in-transit-inbound")).toBeNull();
  });

  test("a negative Available To Sell is shown negative, with a warning, never raised to zero", async () => {
    api.getOnHand.mockResolvedValue(
      ok(onHandWith({ availability: negativeAvailability(), quantity: "-1.2500" })),
    );
    renderPage();
    expect(await screen.findByText(/Available to sell is below zero/)).toBeDefined();
    expect(figure("ats")).toBe("-1.2500 kg");
    expect(figure("primary-sellable")).toBe("-1.2500 kg");
    expect(screen.getByTestId("availability-ats").textContent).not.toMatch(/Unknown/);
  });

  test("a positive Available To Sell carries no warning", async () => {
    renderPage();
    await screen.findByTestId("availability-ats");
    expect(screen.queryByText(/Available to sell is below zero/)).toBeNull();
  });

  test("On Order is 'not available yet' while null, and is not Unknown", async () => {
    renderPage();
    await screen.findByTestId("availability-ats");
    const onOrder = screen.getByTestId("availability-on-order");
    expect(onOrder.textContent).toBe("Not available yet");
    expect(onOrder.querySelector(".inventory__unknown")).toBeNull();
  });

  test("On Order shows a quantity verbatim once the server sends one", async () => {
    api.getOnHand.mockResolvedValue(
      ok(onHandWith({ availability: availability({ onOrder: "12.5000" }) })),
    );
    renderPage();
    await screen.findByTestId("availability-ats");
    expect(screen.getByTestId("availability-on-order").textContent).toBe("12.5000 kg");
  });

  test("the as-of time is the API's, in the store's time zone", async () => {
    renderPage();
    const asOf = await screen.findByTestId("availability-as-of");
    await screen.findByText(/12:30/);
    expect(asOf.textContent).toMatch(/^As of /);
    const time = asOf.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(AVAILABILITY_AS_OF);
    // 10:30 UTC is 12:30 in Cairo in November.
    expect(time?.textContent).toMatch(/12:30/);
  });

  test("an answer without availability is Unknown, never zero, and shows no as-of", async () => {
    api.getOnHand.mockResolvedValue(ok(onHandWith({})));
    renderPage();
    await screen.findByRole("region", { name: "Stock quantities" });
    expect(await screen.findByTestId("availability-ats")).toBeDefined();
    expect(screen.getByTestId("availability-ats").textContent).toMatch(/Unknown/);
    expect(screen.queryByTestId("availability-as-of")).toBeNull();
    expect(screen.queryByTestId("availability-reserved")).toBeNull();
    // The figures the server did send stay shown.
    expect(figure("physical")).toBe("11.0000 kg");
  });

  test("a failed read leaves Unknown, no number and no as-of", async () => {
    api.getOnHand.mockResolvedValue({ status: 500, error: {} });
    renderPage();
    await screen.findByText(/The balance is unknown/);
    const panel = screen.getByRole("region", { name: "Stock quantities" });
    expect(within(panel).getByTestId("availability-ats").textContent).toMatch(/Unknown/);
    expect(panel.textContent).not.toMatch(/\d\.\d{4}/);
    expect(screen.queryByTestId("availability-as-of")).toBeNull();
  });

  test("while the read is loading the panel says so and shows no figure", async () => {
    api.getOnHand.mockImplementation(never);
    renderPage();
    const panel = await screen.findByRole("region", { name: "Stock quantities" });
    expect(panel.textContent).toMatch(/stock quantities/i);
    expect(within(panel).queryByTestId("availability-ats")).toBeNull();
    expect(screen.queryByTestId("availability-as-of")).toBeNull();
  });
});
