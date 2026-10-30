import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CAIRO_STORE,
  NEW_YORK_STORE,
  PRODUCT_1,
  ctx,
  detail,
  one,
  override,
  writeFailure,
} from "./catalog-fixtures";

const consoleGetCatalogProduct = vi.fn();
const consoleUpsertStoreOverride = vi.fn();
const consoleRetireStoreOverride = vi.fn();
vi.mock("@/lib/catalog-queries", () => ({
  consoleGetCatalogProduct: (...a: unknown[]) => consoleGetCatalogProduct(...a),
  consoleUpsertStoreOverride: (...a: unknown[]) => consoleUpsertStoreOverride(...a),
  consoleRetireStoreOverride: (...a: unknown[]) => consoleRetireStoreOverride(...a),
  consoleRetireCatalogProduct: vi.fn(),
  consoleUpdateCatalogProduct: vi.fn(),
  consoleListCatalogProducts: vi.fn(),
  consoleListCatalogCategories: vi.fn(),
}));
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rf2-queries")>()),
  listStores: (...a: unknown[]) => listStores(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { CatalogProductDetail } from "@/catalog/CatalogProductDetail";
import { createQueryClient } from "@/lib/query";

/**
 * RT-770 store overrides on the item detail (CAT-C2c): the drawer that sets or
 * clears one store's availability / tax category. Tests first: the tri-state
 * wire values, the role-shaped controls, every error code of the two writes,
 * the stale write that keeps input, and the refresh of the raw deviations.
 */
const SEEN_AT = "2026-10-05T09:00:00Z";
const LATER = "2026-10-09T11:00:00Z";

function renderDetail(client = createQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/catalog/products/${PRODUCT_1}`]}>
        <Routes>
          <Route path="/catalog/products/:productId" element={<CatalogProductDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function loaded(): Promise<void> {
  await screen.findByRole("heading", { level: 1, name: "Mineral water 1.5L" });
}

const overrides = () => screen.getByRole("region", { name: "Store overrides" });
const drawer = () => screen.getByRole("dialog", { name: "Values for Cairo Festival" });
const radio = (name: string) => within(drawer()).getByRole("radio", { name });
const taxInput = () =>
  within(drawer()).getByRole("textbox", { name: "Tax category in this store" });
const save = () => within(drawer()).getByRole("button", { name: "Save store values" });

async function openChange(): Promise<void> {
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Change values for Cairo Festival" }));
  await screen.findByRole("dialog", { name: "Values for Cairo Festival" });
}

async function openAdd(): Promise<void> {
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Set values for Cairo Festival" }));
  await screen.findByRole("dialog", { name: "Values for Cairo Festival" });
}

function withOverride(over: Record<string, unknown> = {}) {
  return detail({ storeOverrides: [override({ isActive: false, ...over })] });
}

describe("store overrides on the item detail (RT-770, CAT-C2c)", () => {
  beforeEach(() => {
    for (const fn of [
      consoleGetCatalogProduct,
      consoleUpsertStoreOverride,
      consoleRetireStoreOverride,
      listStores,
      activeContext,
    ]) {
      fn.mockReset();
    }
    activeContext.mockReturnValue(ctx("owner", "t1", CAIRO_STORE));
    consoleGetCatalogProduct.mockResolvedValue(one(withOverride()));
    listStores.mockResolvedValue({ status: 200, data: [] });
  });

  // --- Where the controls are ---------------------------------------------------------------

  test("each store deviation has a Change control; opening it writes nothing", async () => {
    renderDetail();
    await openChange();
    expect(consoleUpsertStoreOverride).not.toHaveBeenCalled();
    expect(consoleRetireStoreOverride).not.toHaveBeenCalled();
    expect(within(drawer()).getByText(/The store's price is not changed here/)).toBeDefined();
  });

  test("the store in scope without a deviation gets Set values; with All stores, a hint", async () => {
    consoleGetCatalogProduct.mockResolvedValue(one(detail()));
    const first = renderDetail();
    await loaded();
    expect(screen.getByRole("button", { name: "Set values for Cairo Festival" })).toBeDefined();
    first.unmount();
    activeContext.mockReturnValue(ctx("owner"));
    renderDetail();
    await loaded();
    expect(screen.queryByRole("button", { name: /Set values/ })).toBeNull();
    expect(within(overrides()).getByText(/choose that store in the scope bar/)).toBeDefined();
  });

  test("a retired item shows its deviations with no control at all", async () => {
    consoleGetCatalogProduct.mockResolvedValue(
      one(detail({ storeOverrides: [override({ isActive: false })] }, { status: "retired" })),
    );
    renderDetail();
    await loaded();
    expect(screen.queryByRole("button", { name: /Change values|Set values/ })).toBeNull();
    expect(screen.queryByText(/choose that store in the scope bar/)).toBeNull();
  });

  test("a role outside the catalog gets the non-disclosing page and no control", async () => {
    activeContext.mockReturnValue(ctx("cashier", "t1", CAIRO_STORE));
    renderDetail();
    expect(await screen.findByText("This item is not available to you.")).toBeDefined();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(consoleGetCatalogProduct).not.toHaveBeenCalled();
  });

  // --- Role-shaped controls -------------------------------------------------------------------

  test.each(["owner", "tenant_admin"])(
    "%s: availability tri-state, the tax category and Remove",
    async (role) => {
      activeContext.mockReturnValue(ctx(role, "t1", CAIRO_STORE));
      renderDetail();
      await openChange();
      expect(
        within(drawer())
          .getAllByRole("radio")
          .map((r) => r.closest("label")?.textContent),
      ).toEqual(["Follow the tenant", "Available", "Not available"]);
      expect((radio("Not available") as HTMLInputElement).checked).toBe(true);
      expect(taxInput().getAttribute("dir")).toBe("ltr");
      expect(
        within(drawer()).getByRole("button", { name: "Remove store deviation" }),
      ).toBeDefined();
    },
  );

  test("store_manager: availability only; the tax category is read-only text", async () => {
    activeContext.mockReturnValue(ctx("store_manager", "t1", CAIRO_STORE));
    consoleGetCatalogProduct.mockResolvedValue(one(withOverride({ taxCategory: "zero" })));
    renderDetail();
    await openChange();
    expect(within(drawer()).getAllByRole("radio")).toHaveLength(3);
    expect(within(drawer()).queryByRole("textbox")).toBeNull();
    expect(within(drawer()).getByText(/Only owners and tenant admins can change it/)).toBeDefined();
  });

  test("store_manager: no Remove on a deviation that has a tax category (would be 403)", async () => {
    activeContext.mockReturnValue(ctx("store_manager", "t1", CAIRO_STORE));
    consoleGetCatalogProduct.mockResolvedValue(one(withOverride({ taxCategory: "zero" })));
    renderDetail();
    await openChange();
    expect(within(drawer()).queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  test("store_manager: Remove on a deviation without a tax category", async () => {
    activeContext.mockReturnValue(ctx("store_manager", "t1", CAIRO_STORE));
    renderDetail();
    await openChange();
    expect(within(drawer()).getByRole("button", { name: "Remove store deviation" })).toBeDefined();
  });

  test("store_manager sends isActive only, never a taxCategory key", async () => {
    activeContext.mockReturnValue(ctx("store_manager", "t1", CAIRO_STORE));
    consoleGetCatalogProduct.mockResolvedValue(one(withOverride({ taxCategory: "zero" })));
    consoleUpsertStoreOverride.mockResolvedValue(one(withOverride({ isActive: true })));
    renderDetail();
    await openChange();
    fireEvent.click(radio("Available"));
    fireEvent.click(save());
    await waitFor(() => expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(1));
    expect(consoleUpsertStoreOverride).toHaveBeenCalledWith(PRODUCT_1, CAIRO_STORE, {
      expectedUpdatedAt: SEEN_AT,
      isActive: true,
    });
  });

  // --- Wire values ------------------------------------------------------------------------------

  test.each([
    ["Follow the tenant", null],
    ["Available", true],
  ] as const)(
    "availability %s sends isActive %s with the override's updatedAt",
    async (label, wire) => {
      consoleUpsertStoreOverride.mockResolvedValue(one(withOverride({ isActive: wire })));
      renderDetail();
      await openChange();
      fireEvent.click(radio(label));
      fireEvent.click(save());
      await waitFor(() => expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(1));
      expect(consoleUpsertStoreOverride).toHaveBeenCalledWith(PRODUCT_1, CAIRO_STORE, {
        expectedUpdatedAt: SEEN_AT,
        isActive: wire,
      });
    },
  );

  test("a new deviation sends expectedUpdatedAt null, not available as false, the tax trimmed", async () => {
    consoleGetCatalogProduct.mockResolvedValue(one(detail()));
    consoleUpsertStoreOverride.mockResolvedValue(one(withOverride({ taxCategory: "zero" })));
    renderDetail();
    await openAdd();
    expect((radio("Follow the tenant") as HTMLInputElement).checked).toBe(true);
    expect((taxInput() as HTMLInputElement).value).toBe("");
    fireEvent.click(radio("Not available"));
    fireEvent.change(taxInput(), { target: { value: "  zero " } });
    fireEvent.click(save());
    await waitFor(() => expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(1));
    expect(consoleUpsertStoreOverride).toHaveBeenCalledWith(PRODUCT_1, CAIRO_STORE, {
      expectedUpdatedAt: null,
      isActive: false,
      taxCategory: "zero",
    });
  });

  test("clearing the tax category sends null", async () => {
    consoleGetCatalogProduct.mockResolvedValue(one(withOverride({ taxCategory: "zero" })));
    consoleUpsertStoreOverride.mockResolvedValue(one(withOverride()));
    renderDetail();
    await openChange();
    fireEvent.change(taxInput(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(1));
    expect(consoleUpsertStoreOverride.mock.calls[0][2]).toEqual({
      expectedUpdatedAt: SEEN_AT,
      taxCategory: null,
    });
  });

  test("no change submits nothing and says so", async () => {
    renderDetail();
    await openChange();
    fireEvent.click(save());
    expect(await within(drawer()).findByText("There are no changes to save.")).toBeDefined();
    expect(consoleUpsertStoreOverride).not.toHaveBeenCalled();
  });

  test("a tax category over 50 characters is an inline error on the field, focused; nothing is sent", async () => {
    renderDetail();
    await openChange();
    fireEvent.change(taxInput(), { target: { value: "x".repeat(51) } });
    fireEvent.click(save());
    expect(await within(drawer()).findByText(/at most 50 characters/)).toBeDefined();
    expect(taxInput().getAttribute("aria-invalid")).toBe("true");
    expect(taxInput().getAttribute("aria-describedby")).toContain("override-tax-category-error");
    expect(document.activeElement).toBe(taxInput());
    expect(consoleUpsertStoreOverride).not.toHaveBeenCalled();
    // No error summary in a drawer (D7); fixing the value clears the error live.
    expect(document.querySelector(".form-error-summary")).toBeNull();
    fireEvent.change(taxInput(), { target: { value: "zero" } });
    expect(taxInput().getAttribute("aria-invalid")).toBeNull();
  });

  // --- After a write ------------------------------------------------------------------------------

  test("a saved write closes the drawer and the raw deviation section shows the server's answer", async () => {
    consoleUpsertStoreOverride.mockResolvedValue(
      one(withOverride({ isActive: true, taxCategory: "reduced", updatedAt: LATER })),
    );
    renderDetail();
    await openChange();
    fireEvent.click(radio("Available"));
    fireEvent.change(taxInput(), { target: { value: "reduced" } });
    fireEvent.click(save());
    expect(await screen.findByText("The values for Cairo Festival are saved.")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    const table = within(overrides()).getByRole("table", {
      name: "Store override for Cairo Festival",
    });
    expect(within(table).getByText("reduced")).toBeDefined();
    // The detail was not re-read: the write answered with it.
    expect(consoleGetCatalogProduct).toHaveBeenCalledTimes(1);
  });

  test("a write marks the item lists stale (their store view may change)", async () => {
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    consoleUpsertStoreOverride.mockResolvedValue(one(withOverride({ isActive: true })));
    renderDetail(client);
    await openChange();
    fireEvent.click(radio("Available"));
    fireEvent.click(save());
    await screen.findByText(/are saved/);
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toContain(JSON.stringify(["catalog", "products", "t1"]));
  });

  test("Remove asks first (Cancel has focus), then retires with the override's updatedAt", async () => {
    consoleRetireStoreOverride.mockResolvedValue(one(detail()));
    renderDetail();
    await openChange();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Remove store deviation" }));
    const region = within(drawer()).getByRole("region", {
      name: "Confirm: remove the store deviation",
    });
    expect(document.activeElement).toBe(within(region).getByRole("button", { name: "Cancel" }));
    expect(consoleRetireStoreOverride).not.toHaveBeenCalled();
    fireEvent.click(within(region).getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(consoleRetireStoreOverride).toHaveBeenCalledTimes(1));
    expect(consoleRetireStoreOverride).toHaveBeenCalledWith(PRODUCT_1, CAIRO_STORE, SEEN_AT);
    expect(
      await screen.findByText("Cairo Festival now follows the tenant values for this item."),
    ).toBeDefined();
    expect(
      within(overrides()).getByText(/No store in your scope has its own values/),
    ).toBeDefined();
  });

  test("another store's deviation opens its own drawer, by its id when no name is known", async () => {
    consoleGetCatalogProduct.mockResolvedValue(
      one(detail({ storeOverrides: [override({ storeId: NEW_YORK_STORE, isActive: true })] })),
    );
    consoleUpsertStoreOverride.mockResolvedValue(one(detail()));
    renderDetail();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: `Change values for ${NEW_YORK_STORE}` }));
    const dialog = await screen.findByRole("dialog", { name: `Values for ${NEW_YORK_STORE}` });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Not available" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save store values" }));
    await waitFor(() => expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(1));
    expect(consoleUpsertStoreOverride.mock.calls[0][1]).toBe(NEW_YORK_STORE);
  });

  // --- Every error code ------------------------------------------------------------------------

  test("422 override_empty explains and offers to remove the store deviation instead", async () => {
    consoleUpsertStoreOverride.mockResolvedValue(writeFailure(422, "override_empty", "req-e"));
    consoleRetireStoreOverride.mockResolvedValue(one(detail()));
    renderDetail();
    await openChange();
    fireEvent.click(radio("Follow the tenant"));
    fireEvent.click(save());
    const alert = (await within(drawer()).findByText(/Nothing would be left/)).closest(
      "[role='alert']",
    ) as HTMLElement;
    expect(alert.textContent).toContain("req-e");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Remove the store deviation instead" }),
    );
    const region = within(drawer()).getByRole("region", {
      name: "Confirm: remove the store deviation",
    });
    fireEvent.click(within(region).getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(consoleRetireStoreOverride).toHaveBeenCalledTimes(1));
  });

  test("409 price_override_present on Remove: the store price is kept; the drawer stays", async () => {
    consoleGetCatalogProduct.mockResolvedValue(
      one(withOverride({ price: { amount: "12.0000", currencyCode: "EGP" } })),
    );
    consoleRetireStoreOverride.mockResolvedValue(
      writeFailure(409, "price_override_present", "req-p"),
    );
    renderDetail();
    await openChange();
    expect(within(drawer()).getByText(/This store has its own price/)).toBeDefined();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Remove store deviation" }));
    fireEvent.click(within(drawer()).getByRole("button", { name: "Yes, remove" }));
    const alert = (await within(drawer()).findByText(/cannot be removed here/)).closest(
      "[role='alert']",
    ) as HTMLElement;
    expect(alert.textContent).toContain("req-p");
    expect(drawer()).toBeDefined();
    // Focus returns to the Remove starter.
    expect(document.activeElement).toBe(
      within(drawer()).getByRole("button", { name: "Remove store deviation" }),
    );
  });

  test("409 stale_write keeps what was chosen; Reload re-reads and the next write carries the new updatedAt", async () => {
    consoleUpsertStoreOverride.mockResolvedValueOnce(writeFailure(409, "stale_write", "req-s"));
    renderDetail();
    await openChange();
    fireEvent.click(radio("Available"));
    fireEvent.change(taxInput(), { target: { value: "mine" } });
    fireEvent.click(save());
    expect(await within(drawer()).findByText(/changed since you opened them/)).toBeDefined();
    expect((radio("Available") as HTMLInputElement).checked).toBe(true);
    expect((taxInput() as HTMLInputElement).value).toBe("mine");

    consoleGetCatalogProduct.mockResolvedValue(
      one(withOverride({ isActive: false, taxCategory: "theirs", updatedAt: LATER })),
    );
    fireEvent.click(within(drawer()).getByRole("button", { name: "Reload" }));
    expect(await within(drawer()).findByText(/The latest values are loaded/)).toBeDefined();
    expect((radio("Available") as HTMLInputElement).checked).toBe(true);
    expect((taxInput() as HTMLInputElement).value).toBe("mine");

    consoleUpsertStoreOverride.mockResolvedValue(one(withOverride({ isActive: true })));
    fireEvent.click(save());
    await waitFor(() => expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(2));
    expect(consoleUpsertStoreOverride.mock.calls[1][2]).toEqual({
      expectedUpdatedAt: LATER,
      isActive: true,
      taxCategory: "mine",
    });
  });

  test("409 stale_write after the override was removed meanwhile: the next write creates it (null)", async () => {
    consoleUpsertStoreOverride.mockResolvedValueOnce(writeFailure(409, "stale_write"));
    renderDetail();
    await openChange();
    fireEvent.click(radio("Available"));
    fireEvent.click(save());
    await within(drawer()).findByText(/changed since you opened them/);
    consoleGetCatalogProduct.mockResolvedValue(one(detail()));
    fireEvent.click(within(drawer()).getByRole("button", { name: "Reload" }));
    await within(drawer()).findByText(/The latest values are loaded/);
    expect(within(drawer()).queryByRole("button", { name: /Remove/ })).toBeNull();
    consoleUpsertStoreOverride.mockResolvedValue(one(withOverride({ isActive: true })));
    fireEvent.click(save());
    await waitFor(() => expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(2));
    expect(consoleUpsertStoreOverride.mock.calls[1][2]).toEqual({
      expectedUpdatedAt: null,
      isActive: true,
    });
  });

  test("409 stale_write on Remove asks to reload and decide again", async () => {
    consoleRetireStoreOverride.mockResolvedValue(writeFailure(409, "stale_write"));
    renderDetail();
    await openChange();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Remove store deviation" }));
    fireEvent.click(within(drawer()).getByRole("button", { name: "Yes, remove" }));
    expect(await within(drawer()).findByText(/then decide again/)).toBeDefined();
  });

  test("409 product_retired: says so, locks the drawer and the page reads the item again", async () => {
    consoleUpsertStoreOverride.mockResolvedValue(writeFailure(409, "product_retired"));
    renderDetail();
    await openChange();
    consoleGetCatalogProduct.mockResolvedValue(
      one(detail({ storeOverrides: [override({ isActive: false })] }, { status: "retired" })),
    );
    fireEvent.click(radio("Available"));
    fireEvent.click(save());
    expect(
      await within(drawer()).findByText(/store values can no longer be changed/),
    ).toBeDefined();
    await waitFor(() => expect(consoleGetCatalogProduct).toHaveBeenCalledTimes(2));
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(radio("Available").matches(":disabled")).toBe(true);
  });

  test.each([
    [400, "validation_error", /server rejected these values/],
    [401, "unauthorized", /session has expired/],
    [403, "tax_override_forbidden", /Only owners and tenant admins can change a store's tax/],
    [403, "origin_rejected", /did not come from this console/],
    [403, "forbidden", /permission to change this store's values/],
    [404, "not_found", /no longer available to you/],
    [409, "something_else", /does not allow this change/],
    [429, "rate_limited", /Too many requests/],
    [500, "internal_error", /nothing was saved/],
  ] as const)(
    "upsert %i %s: a banner in the drawer with the request id, input kept",
    async (status, code, message) => {
      consoleUpsertStoreOverride.mockResolvedValue(writeFailure(status, code, "req-xyz"));
      renderDetail();
      await openChange();
      fireEvent.click(radio("Available"));
      fireEvent.click(save());
      const alert = (await within(drawer()).findByText(message)).closest("[role='alert']");
      expect(alert?.textContent).toContain("req-xyz");
      expect((radio("Available") as HTMLInputElement).checked).toBe(true);
    },
  );

  test.each([
    [403, "tax_override_forbidden", /Only owners and tenant admins/],
    [404, "not_found", /no longer available to you/],
    [500, "internal_error", /nothing was saved/],
  ] as const)("retire %i %s: a banner in the drawer", async (status, code, message) => {
    consoleRetireStoreOverride.mockResolvedValue(writeFailure(status, code));
    renderDetail();
    await openChange();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Remove store deviation" }));
    fireEvent.click(within(drawer()).getByRole("button", { name: "Yes, remove" }));
    expect(await within(drawer()).findByText(message)).toBeDefined();
  });

  test("a request that never completed is a banner too", async () => {
    consoleUpsertStoreOverride.mockRejectedValue(new TypeError("Failed to fetch"));
    renderDetail();
    await openChange();
    fireEvent.click(radio("Available"));
    fireEvent.click(save());
    expect(await within(drawer()).findByText(/nothing was saved/)).toBeDefined();
  });

  test("Save is busy in flight: one request only", async () => {
    let finish: (v: unknown) => void = () => undefined;
    consoleUpsertStoreOverride.mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    renderDetail();
    await openChange();
    fireEvent.click(radio("Available"));
    fireEvent.click(save());
    // RT-959: busy, not disabled: it keeps focus and ignores repeat presses.
    await waitFor(() => expect(save().getAttribute("aria-busy")).toBe("true"));
    expect(save().hasAttribute("disabled")).toBe(false);
    fireEvent.click(save());
    expect(consoleUpsertStoreOverride).toHaveBeenCalledTimes(1);
    finish(one(withOverride({ isActive: true })));
    await screen.findByText(/are saved/);
  });
});
