import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page as catalogPage, ctx, product } from "./catalog-fixtures";
import { CAIRO_STORE, item as saleItem, page as salePage, stores } from "./sale-fixtures";

const consoleListCatalogProducts = vi.fn();
vi.mock("@/lib/catalog-queries", () => ({
  consoleListCatalogProducts: (...a: unknown[]) => consoleListCatalogProducts(...a),
}));
const consoleListSales = vi.fn();
vi.mock("@/lib/sale-queries", () => ({
  consoleListSales: (...a: unknown[]) => consoleListSales(...a),
}));
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listStores: (...a: unknown[]) => listStores(...a) };
});
const listMembers = vi.fn();
vi.mock("@/lib/client", () => ({
  listMembers: (...a: unknown[]) => listMembers(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { createQueryClient } from "@/lib/query";
import { SearchPage } from "@/search/SearchPage";

const MEMBER = {
  membership_id: "m1",
  user: { id: "u1", email: "ops@example.test", display_name: "Ops One" },
  role_code: "store_manager",
  store_access_kind: "all",
  accessible_store_ids: [],
  revoked_at: null,
};

function renderSearch(entry: string): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
          <Route path="/catalog/products/:productId" element={<p>product detail</p>} />
          <Route path="/sales/:saleRef" element={<p>sale detail</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T09:00:00Z"));
    consoleListCatalogProducts.mockReset();
    consoleListSales.mockReset();
    listStores.mockReset();
    listMembers.mockReset();
    activeContext.mockReset();
    // One store id everywhere: the sale fixtures' Cairo store (the catalog
    // fixtures use a different id for the same store name).
    activeContext.mockReturnValue(ctx("owner", "t1", CAIRO_STORE));
    listStores.mockResolvedValue({ status: 200, data: stores });
    consoleListCatalogProducts.mockResolvedValue(catalogPage([product()]));
    consoleListSales.mockResolvedValue(salePage([saleItem()]));
    listMembers.mockResolvedValue({ status: 200, data: [MEMBER] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("one term searches products, sales and operators, each linking on", async () => {
    // A cursor on the products page, so the "see all" link renders.
    consoleListCatalogProducts.mockResolvedValue(catalogPage([product()], "c1"));
    renderSearch("/search?q=ops");
    const productLink = await screen.findByRole("link", { name: "Mineral water 1.5L" });
    expect(productLink.getAttribute("href")).toBe(
      "/catalog/products/0190f000-0000-7000-8000-0000000007b1",
    );
    const saleLink = await screen.findByRole("link", { name: "R-0042" });
    expect(saleLink.getAttribute("href")).toBe("/sales/0190f000-0000-7000-8000-0000000005b1");
    expect(await screen.findByText("Ops One")).toBeDefined();
    expect(screen.getByText("ops@example.test")).toBeDefined();
    // The sales read asks for the receipt in the active store's last 31 days.
    expect(consoleListSales).toHaveBeenCalled();
    expect(consoleListSales.mock.calls[0]?.[0]).toMatchObject({
      store_id: CAIRO_STORE,
      from: "2026-09-23",
      to: "2026-10-23",
      sale_number: "ops",
      page_size: 10,
    });
    // Products are a first page with a link to the full list.
    const seeAll = screen.getByRole("link", { name: /see all matches in the catalog/i });
    expect(seeAll.getAttribute("href")).toBe("/catalog/products?q=ops");
  });

  test("no term: the intro explains what can be searched and nothing is read", async () => {
    renderSearch("/search");
    expect(await screen.findByText(/what you can search/i)).toBeDefined();
    expect(consoleListCatalogProducts).not.toHaveBeenCalled();
    expect(consoleListSales).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });

  test("no active store: the sales section says so and is not read", async () => {
    activeContext.mockReturnValue(ctx("owner", "t1"));
    renderSearch("/search?q=ops");
    expect(
      await screen.findByText(/pick a store in the scope header to look up a receipt number/i),
    ).toBeDefined();
    expect(consoleListSales).not.toHaveBeenCalled();
    expect(await screen.findByText("Mineral water 1.5L")).toBeDefined();
  });

  test("a refused role sees only the operators section", async () => {
    activeContext.mockReturnValue(ctx("store_staff", "t1", CAIRO_STORE));
    renderSearch("/search?q=ops");
    expect(await screen.findByText("Ops One")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Products" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sales" })).toBeNull();
    expect(consoleListCatalogProducts).not.toHaveBeenCalled();
    expect(consoleListSales).not.toHaveBeenCalled();
  });

  test("a term past the limit shows the error and reads nothing", async () => {
    renderSearch(`/search?q=${"x".repeat(101)}`);
    expect(await screen.findByText(/at most 100 characters/i)).toBeDefined();
    expect(consoleListCatalogProducts).not.toHaveBeenCalled();
    expect(consoleListSales).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });

  test("a refused products read is omitted while the other sections stay", async () => {
    consoleListCatalogProducts.mockResolvedValue({
      status: 404,
      error: { error: { code: "x", message: "y", request_id: "req-1" } },
    });
    renderSearch("/search?q=ops");
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Products" })).toBeNull();
    });
    expect(await screen.findByText("R-0042")).toBeDefined();
    expect(await screen.findByText("Ops One")).toBeDefined();
  });
});
