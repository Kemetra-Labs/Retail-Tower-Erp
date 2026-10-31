import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-1016 (v4.0 «Ink & Receipt») on the Inventory screens: the header band's
 * facts come only from a served read (and are absent while it loads or fails),
 * the panels are numbered by what renders for the role, an unknown balance is
 * never drawn as a number, and the status-move outcome reads above the submit.
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
import { InventoryStore } from "@/inventory/InventoryStore";
import { InventoryStores } from "@/inventory/InventoryStores";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const MAIN = "0190f000-0000-7000-8000-0000000007d1";
const SHELF = "0190f000-0000-7000-8000-0000000007d2";
const ROOF = "0190f000-0000-7000-8000-0000000007d3";

function ctx(role: string) {
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
const location = (id: string, kind: string, name: string, isActive: boolean) => ({
  id,
  storeId: STORE,
  code: name.toUpperCase(),
  name,
  kind,
  isActive,
});
const locations = {
  items: [
    location(MAIN, "primary", "Main", true),
    location(SHELF, "storage", "Shelf", true),
    location(ROOF, "storage", "Roof", false),
  ],
};
const negativeOnHand = {
  storeId: STORE,
  productId: PRODUCT,
  quantity: "-1.2500",
  stockingUnit: "kg",
  negativeBalance: true,
  sellableQuantity: "-1.2500",
  statusQuantities: [{ inventoryStatus: "sellable", quantity: "-1.2500" }],
};
const stores = [
  { id: STORE, code: "CAI", name: "Cairo Festival", timezone: "Africa/Cairo", is_active: true },
];

function renderAt(entry: string): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/inventory" element={<InventoryStores />} />
          <Route path="/inventory/stores/:storeId" element={<InventoryStore />} />
          <Route
            path="/inventory/stores/:storeId/products/:productId"
            element={<InventoryProduct />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const badges = () => [...document.querySelectorAll(".section-index")].map((b) => b.textContent);
const never = () => new Promise(() => undefined);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  listStores.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  listStores.mockResolvedValue({ status: 200, data: stores });
  api.listStockLocations.mockResolvedValue(ok(locations));
  api.listStoreMovements.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.getOnHand.mockResolvedValue(ok(negativeOnHand));
  api.listTrackingIdentities.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.createStatusMove.mockResolvedValue({ status: 201, data: {} });
});
afterEach(cleanup);

describe("stores list band (RT-1016)", () => {
  test("the subtitle names the tenant, and the band carries no fact", async () => {
    renderAt("/inventory");
    await screen.findByRole("link", { name: "Cairo Festival" });
    const sub = document.querySelector(".list-band__sub");
    expect(sub?.textContent).toMatch(/^Stores of Northstar Retail\./);
    expect(sub?.querySelector("bdi")?.textContent).toBe("Northstar Retail");
    expect(document.querySelector(".list-band__facts")).toBeNull();
    // The read-only note stays unchanged under the band.
    expect(screen.getByText(/Read only\. No movement/)).toBeDefined();
  });
});

describe("store page band and panels (RT-1016)", () => {
  test("the band's facts are the served locations: how many, how many active", async () => {
    renderAt(`/inventory/stores/${STORE}`);
    const facts = await screen.findByLabelText("Store summary");
    expect(within(facts).getByText("Stock locations").parentElement?.textContent).toContain("3");
    expect(within(facts).getByText("Active").parentElement?.textContent).toContain("2");
    expect(facts.closest("header")?.querySelector("h1")?.textContent).toBe("Cairo Festival");
  });

  test.each([
    ["still loading", () => never()],
    ["failed", () => Promise.resolve({ status: 500, error: {} })],
  ])("no band fact while locations are %s", async (_name, answer) => {
    api.listStockLocations.mockImplementation(answer);
    renderAt(`/inventory/stores/${STORE}`);
    await screen.findByRole("heading", { name: "Cairo Festival" });
    if (_name === "failed") {
      expect(await screen.findByText("Stock locations could not be loaded.")).toBeDefined();
    }
    expect(screen.queryByLabelText("Store summary")).toBeNull();
  });

  test("locations and the ledger are panels 01 and 02, each named by its heading", async () => {
    renderAt(`/inventory/stores/${STORE}`);
    await screen.findByRole("heading", { name: "Stock locations" });
    expect(badges()).toEqual(["01", "02"]);
    expect(screen.getByRole("region", { name: "Stock locations" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Stock movement ledger" })).toBeDefined();
    // The badge is decoration: it never becomes part of a heading's name.
    expect(screen.queryByRole("heading", { name: /^0[12]/ })).toBeNull();
  });

  test("a posting state is a text pill: confirmed reads in the success role", async () => {
    api.listStoreMovements.mockResolvedValue(
      ok({
        items: [
          {
            id: "0190f000-0000-7000-8000-000000000f01",
            storeId: STORE,
            movementType: "inbound",
            quantity: "4.0000",
            stockingUnit: "kg",
            tenantProductRef: PRODUCT,
            reason: null,
            occurredAt: "2026-10-18T09:00:00Z",
            receivedAt: "2026-10-18T09:00:01Z",
            createdBy: "0190f000-0000-7000-8000-000000000a01",
            origin: "retail",
            integrationState: "confirmed",
            erpConfirmedAt: null,
            stockLocationId: MAIN,
            inventoryStatus: "sellable",
            positionInterpreted: false,
            trackingIdentityId: null,
          },
        ],
        nextCursor: null,
      }),
    );
    renderAt(`/inventory/stores/${STORE}`);
    const pill = await screen.findByText("Confirmed by ERPNext");
    expect(pill.className).toContain("badge--success");
  });
});

describe("product page band and panels (RT-1016)", () => {
  const PRODUCT_URL = `/inventory/stores/${STORE}/products/${PRODUCT}`;

  test("the band shows the served physical and sellable; a negative one is shown, never hidden", async () => {
    renderAt(PRODUCT_URL);
    const facts = await screen.findByLabelText("On-hand summary");
    expect(within(facts).getByTestId("on-hand-quantity").textContent).toBe("-1.2500 kg");
    expect(within(facts).getByTestId("on-hand-sellable").textContent).toBe("-1.2500 kg");
    // The warning is a banner in the panel; the band never carries state.
    const band = facts.closest("header");
    expect(band?.textContent).not.toMatch(/below zero/);
    expect(await screen.findByText(/On-hand is below zero/)).toBeDefined();
  });

  test.each([
    ["still loading", () => never()],
    ["failed", () => Promise.resolve({ status: 500, error: {} })],
  ])("no band fact, and no number, while on-hand is %s", async (name, answer) => {
    api.getOnHand.mockImplementation(answer);
    renderAt(PRODUCT_URL);
    await screen.findByRole("heading", { name: "Product on-hand at this store" });
    if (name === "failed") {
      expect(await screen.findByText(/The balance is unknown/)).toBeDefined();
      expect(screen.getByTestId("on-hand-quantity").textContent).toMatch(/Unknown/);
      // The failed read never turns into a number, zero or otherwise.
      expect(document.body.textContent).not.toMatch(/\b0\.0000\b/);
    }
    expect(screen.queryByLabelText("On-hand summary")).toBeNull();
    expect(screen.queryByTestId("on-hand-sellable")).toBeNull();
  });

  test("an owner sees three numbered panels; the move is 02 and tracking 03", async () => {
    renderAt(PRODUCT_URL);
    await screen.findByRole("heading", { name: "Batches and serials" });
    expect(badges()).toEqual(["01", "02", "03"]);
    const labelled = (name: string) => screen.getByRole("region", { name });
    expect(labelled("Physical on-hand")).toBeDefined();
    expect(labelled("Move stock between statuses")).toBeDefined();
  });

  test("a store manager has no tracking panel: two numbered panels, no tracking read", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderAt(PRODUCT_URL);
    await screen.findByRole("heading", { name: "Move stock between statuses" });
    expect(badges()).toEqual(["01", "02"]);
    expect(screen.queryByRole("heading", { name: "Batches and serials" })).toBeNull();
    expect(api.listTrackingIdentities).not.toHaveBeenCalled();
  });

  test("a tracking read the API refuses drops the panel and leaves 01 and 02", async () => {
    api.listTrackingIdentities.mockResolvedValue({ status: 404, error: {} });
    renderAt(PRODUCT_URL);
    await screen.findByRole("heading", { name: "Move stock between statuses" });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Batches and serials" })).toBeNull(),
    );
    expect(badges()).toEqual(["01", "02"]);
  });

  test("ERP Book is the snapshot link, never a number", async () => {
    renderAt(PRODUCT_URL);
    const erp = await screen.findByTestId("on-hand-erp-book");
    expect(erp.textContent).not.toMatch(/\d/);
  });

  test("the move's outcome reads above the submit button; the balance is stated unchanged", async () => {
    renderAt(PRODUCT_URL);
    await waitFor(() => expect(screen.getByTestId("on-hand-quantity").textContent).toContain("kg"));
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Record status move" }));
    const recorded = await screen.findByText(/Status move recorded/);
    const submit = screen.getByRole("button", { name: "Record status move" });
    // The outcome precedes the submit in the document, inside the same form.
    expect(
      recorded.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(recorded.closest("form")).toBe(submit.closest("form"));
    expect(screen.getByText(/Physical on-hand does not change/)).toBeDefined();
  });
});
