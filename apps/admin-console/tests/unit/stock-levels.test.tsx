import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consoleGetProductStockLevels = vi.fn();
const consoleSetTenantStockLevel = vi.fn();
const consoleRetireTenantStockLevel = vi.fn();
const consoleSetStoreStockLevel = vi.fn();
const consoleRetireStoreStockLevel = vi.fn();
vi.mock("@/lib/stock-level-queries", () => ({
  consoleGetProductStockLevels: (...a: unknown[]) => consoleGetProductStockLevels(...a),
  consoleSetTenantStockLevel: (...a: unknown[]) => consoleSetTenantStockLevel(...a),
  consoleRetireTenantStockLevel: (...a: unknown[]) => consoleRetireTenantStockLevel(...a),
  consoleSetStoreStockLevel: (...a: unknown[]) => consoleSetStoreStockLevel(...a),
  consoleRetireStoreStockLevel: (...a: unknown[]) => consoleRetireStoreStockLevel(...a),
}));
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rf2-queries")>()),
  listStores: (...a: unknown[]) => listStores(...a),
}));

import { createQueryClient } from "@/lib/query";
import { ProductStockLevels } from "@/stock-levels/ProductStockLevels";

/**
 * RT-1074 stock-level section and editor (RT-1064 TH-2 to TH-4), AC1: role
 * visibility for the four roles, exact decimal bodies, critical <= reorder and
 * the 422 mapping, 409 stale_write (reload, never overwrite) and
 * product_retired, the Idempotency-Key lifecycle, and the retire confirmation
 * with its 404-already-gone case.
 */
const PRODUCT = "0190f000-0000-7000-8000-0000000007b1";
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const GIZA = "0190f000-0000-7000-8000-0000000007a2";
const SEEN_AT = "2026-11-01T09:00:00.000Z";
const LATER = "2026-11-02T10:00:00.000Z";

function tenantLevel(over: Record<string, unknown> = {}) {
  return { reorderLevel: "12.5000", criticalLevel: "3", updatedAt: SEEN_AT, ...over };
}

function storeLevel(over: Record<string, unknown> = {}) {
  return { storeId: CAIRO, reorderLevel: "4", criticalLevel: null, updatedAt: SEEN_AT, ...over };
}

function levels(tenant: unknown = null, stores: unknown[] = []) {
  return { productId: PRODUCT, tenantLevel: tenant, storeLevels: stores };
}

const ok = (data: unknown, replayed = false) => ({ status: 200, data, replayed });
const fail = (status: number, code: string, requestId = "req-s1") => ({
  status,
  error: { error: { code, message: "m", request_id: requestId } },
});

function renderSection(
  role: string,
  opts: { activeStoreId?: string | null; retired?: boolean } = {},
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ProductStockLevels
        productId={PRODUCT}
        retired={opts.retired ?? false}
        tenantId="t1"
        role={role}
        activeStoreId={opts.activeStoreId === undefined ? CAIRO : opts.activeStoreId}
        activeStoreName="Cairo Festival"
        index={4}
      />
    </QueryClientProvider>,
  );
}

const section = () => screen.getByRole("region", { name: "Stock levels" });
const tenantDrawer = () => screen.getByRole("dialog", { name: "Tenant stock level" });
const storeDrawer = () => screen.getByRole("dialog", { name: "Stock level for Cairo Festival" });
const field = (dialog: HTMLElement, name: string) => within(dialog).getByRole("textbox", { name });
const type = (dialog: HTMLElement, name: string, value: string) =>
  fireEvent.change(field(dialog, name), { target: { value } });
const save = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole("button", { name: "Save level" }));

async function loaded(): Promise<void> {
  await screen.findByText("Tenant level");
}

async function openTenant(): Promise<HTMLElement> {
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: /the tenant level$/ }));
  return screen.findByRole("dialog", { name: "Tenant stock level" });
}

describe("stock levels on the item detail (RT-1074)", () => {
  beforeEach(() => {
    for (const fn of [
      consoleGetProductStockLevels,
      consoleSetTenantStockLevel,
      consoleRetireTenantStockLevel,
      consoleSetStoreStockLevel,
      consoleRetireStoreStockLevel,
      listStores,
    ]) {
      fn.mockReset();
    }
    consoleGetProductStockLevels.mockResolvedValue(ok(levels(tenantLevel(), [storeLevel()])));
    listStores.mockResolvedValue({
      status: 200,
      data: [
        { id: CAIRO, code: "CAI", name: "Cairo Festival" },
        { id: GIZA, code: "GIZ", name: "Giza Mall" },
      ],
    });
  });

  // --- Read and role visibility ------------------------------------------------------------

  test("shows each value exactly as the server holds it", async () => {
    renderSection("owner");
    await loaded();
    const s = section();
    expect(within(s).getByText("12.5000")).toBeDefined();
    expect(within(s).getByText("3")).toBeDefined();
    expect(within(s).getByText("4")).toBeDefined();
    expect(within(s).getByText("None")).toBeDefined();
    expect(consoleGetProductStockLevels).toHaveBeenCalledWith(PRODUCT);
  });

  test("owner and tenant_admin get the tenant and store controls", async () => {
    for (const role of ["owner", "tenant_admin"]) {
      const view = renderSection(role);
      await loaded();
      expect(screen.getByRole("button", { name: "Change the tenant level" })).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Change the level for Cairo Festival" }),
      ).toBeDefined();
      view.unmount();
    }
  });

  test("store_manager gets the store controls only, never the tenant level's", async () => {
    renderSection("store_manager");
    await loaded();
    expect(screen.queryByRole("button", { name: /tenant level/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Change the level for Cairo Festival" }),
    ).toBeDefined();
  });

  test("store_staff reads nothing and sees no section", async () => {
    renderSection("store_staff");
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
    expect(consoleGetProductStockLevels).not.toHaveBeenCalled();
  });

  test("a retired item shows its levels with no control", async () => {
    renderSection("owner", { retired: true });
    await loaded();
    expect(within(section()).queryByRole("button")).toBeNull();
    expect(within(section()).getByText(/This item is retired/)).toBeDefined();
  });

  test("the active store without a level gets Set; with no active store, a hint", async () => {
    consoleGetProductStockLevels.mockResolvedValue(ok(levels(null, [])));
    const first = renderSection("store_manager");
    await loaded();
    expect(screen.getByRole("button", { name: "Set a level for Cairo Festival" })).toBeDefined();
    expect(screen.getByText(/No tenant level is set/)).toBeDefined();
    first.unmount();
    renderSection("owner", { activeStoreId: null });
    await loaded();
    expect(screen.getByRole("button", { name: "Set the tenant level" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Set a level for/ })).toBeNull();
    expect(screen.getByText(/choose that store in the scope bar/)).toBeDefined();
  });

  test("a read refused as not found is a quiet note; a failure offers a retry", async () => {
    consoleGetProductStockLevels.mockResolvedValue(fail(404, "not_found"));
    const first = renderSection("owner");
    expect(await screen.findByText(/not available for this item/)).toBeDefined();
    first.unmount();
    consoleGetProductStockLevels.mockResolvedValue(fail(500, "internal"));
    renderSection("owner");
    const retry = await screen.findByRole("button", { name: "Reload stock levels" });
    consoleGetProductStockLevels.mockResolvedValue(ok(levels()));
    fireEvent.click(retry);
    await loaded();
  });

  // --- Set: exact decimals, validation, 422 ----------------------------------------------------

  test("sets the tenant level with the exact strings, the precondition and a key", async () => {
    consoleSetTenantStockLevel.mockResolvedValue(
      ok(levels(tenantLevel({ reorderLevel: "20.25", criticalLevel: null, updatedAt: LATER }))),
    );
    renderSection("owner");
    const d = await openTenant();
    expect((field(d, "Reorder level") as HTMLInputElement).value).toBe("12.5000");
    type(d, "Reorder level", " 20.25 ");
    type(d, "Critical level", "");
    save(d);
    await screen.findByText("The tenant level is saved.");
    const [productId, body, sentKey] = consoleSetTenantStockLevel.mock.calls[0] ?? [];
    expect(productId).toBe(PRODUCT);
    expect(body).toEqual({
      expectedUpdatedAt: SEEN_AT,
      reorderLevel: "20.25",
      criticalLevel: null,
    });
    expect(String(sentKey)).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(within(section()).getByText("20.25")).toBeDefined();
  });

  test("a first level sends expectedUpdatedAt null", async () => {
    consoleGetProductStockLevels.mockResolvedValue(ok(levels(null, [])));
    consoleSetStoreStockLevel.mockResolvedValue(ok(levels(null, [storeLevel()])));
    renderSection("store_manager");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Set a level for Cairo Festival" }));
    const d = await screen.findByRole("dialog", { name: "Stock level for Cairo Festival" });
    type(d, "Reorder level", "4");
    save(d);
    await screen.findByText("The level for Cairo Festival is saved.");
    const [productId, storeId, body] = consoleSetStoreStockLevel.mock.calls[0] ?? [];
    expect([productId, storeId]).toEqual([PRODUCT, CAIRO]);
    expect(body).toEqual({ expectedUpdatedAt: null, reorderLevel: "4", criticalLevel: null });
  });

  test("critical above reorder is stopped on the field; nothing is sent", async () => {
    renderSection("owner");
    const d = await openTenant();
    type(d, "Reorder level", "10");
    type(d, "Critical level", "10.0001");
    save(d);
    expect(
      within(d).getByText("The critical level cannot be above the reorder level."),
    ).toBeDefined();
    expect(field(d, "Critical level").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field(d, "Critical level"));
    expect(consoleSetTenantStockLevel).not.toHaveBeenCalled();
    // Fixing it clears the error at once.
    type(d, "Critical level", "10");
    expect(within(d).queryByText(/cannot be above/)).toBeNull();
  });

  test("a malformed level is stopped on the field", async () => {
    renderSection("owner");
    const d = await openTenant();
    type(d, "Reorder level", "1.23456");
    save(d);
    expect(within(d).getByText("Use at most 4 decimal places.")).toBeDefined();
    expect(document.activeElement).toBe(field(d, "Reorder level"));
    expect(consoleSetTenantStockLevel).not.toHaveBeenCalled();
  });

  test("422 critical_above_reorder from the server lands on the critical field", async () => {
    consoleSetTenantStockLevel.mockResolvedValue(fail(422, "critical_above_reorder"));
    renderSection("owner");
    const d = await openTenant();
    type(d, "Critical level", "4");
    save(d);
    await within(d).findByText("The critical level cannot be above the reorder level.");
    expect(field(d, "Critical level").getAttribute("aria-invalid")).toBe("true");
    // Focus moves there once the form is enabled again after the request.
    await waitFor(() => expect(document.activeElement).toBe(field(d, "Critical level")));
  });

  test("unchanged values send nothing", async () => {
    renderSection("owner");
    const d = await openTenant();
    type(d, "Reorder level", "12.5");
    save(d);
    expect(await within(d).findByText(/There are no changes to save/)).toBeDefined();
    expect(consoleSetTenantStockLevel).not.toHaveBeenCalled();
  });

  // --- 409 ----------------------------------------------------------------------------------------

  test("409 stale_write reloads, says so, keeps the typed change and never overwrites", async () => {
    consoleSetTenantStockLevel.mockResolvedValueOnce(fail(409, "stale_write"));
    renderSection("owner");
    const d = await openTenant();
    consoleGetProductStockLevels.mockResolvedValue(
      ok(levels(tenantLevel({ reorderLevel: "30", criticalLevel: "9", updatedAt: LATER }))),
    );
    type(d, "Reorder level", "15");
    save(d);
    await within(d).findByText(/Someone else changed this level/);
    // Only one write: nothing was retried behind the person's back.
    expect(consoleSetTenantStockLevel).toHaveBeenCalledTimes(1);
    expect((field(d, "Reorder level") as HTMLInputElement).value).toBe("15");
    expect((field(d, "Critical level") as HTMLInputElement).value).toBe("9");
    // The next save is a new intent with the fresh precondition and a new key.
    consoleSetTenantStockLevel.mockResolvedValueOnce(ok(levels(tenantLevel({ updatedAt: LATER }))));
    save(d);
    await screen.findByText("The tenant level is saved.");
    const [, firstBody, firstSent] = consoleSetTenantStockLevel.mock.calls[0] ?? [];
    const [, secondBody, secondSent] = consoleSetTenantStockLevel.mock.calls[1] ?? [];
    expect((firstBody as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(SEEN_AT);
    expect(secondBody).toEqual({
      expectedUpdatedAt: LATER,
      reorderLevel: "15",
      criticalLevel: "9",
    });
    expect(secondSent).not.toBe(firstSent);
  });

  test("409 product_retired locks the editor", async () => {
    consoleSetTenantStockLevel.mockResolvedValue(fail(409, "product_retired"));
    renderSection("owner");
    const d = await openTenant();
    type(d, "Reorder level", "15");
    save(d);
    await within(d).findByText(
      "This item is retired, so its stock levels can no longer be changed.",
    );
    expect(field(d, "Reorder level").closest("fieldset")?.disabled).toBe(true);
    expect(within(d).queryByRole("button", { name: "Remove level" })).toBeNull();
  });

  // --- Idempotency-Key lifecycle ------------------------------------------------------------------

  test("a retry of the same intent reuses its key; a changed intent gets a new one", async () => {
    consoleSetTenantStockLevel
      .mockResolvedValueOnce(fail(503, "unavailable"))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(fail(429, "rate_limited"))
      .mockResolvedValueOnce(ok(levels(tenantLevel({ reorderLevel: "16", updatedAt: LATER }))));
    renderSection("owner");
    const d = await openTenant();
    type(d, "Reorder level", "15");
    save(d);
    await within(d).findByText(/Something went wrong/);
    save(d);
    await waitFor(() => expect(consoleSetTenantStockLevel).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(d).getByText(/Something went wrong/)).toBeDefined());
    save(d);
    await within(d).findByText(/Too many requests/);
    // A different body is a new intent.
    type(d, "Reorder level", "16");
    save(d);
    await screen.findByText("The tenant level is saved.");
    const sent = consoleSetTenantStockLevel.mock.calls.map((c) => c[2]);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[2]).toBe(sent[0]);
    expect(sent[3]).not.toBe(sent[0]);
  });

  test("a final refusal drops the key: saving the same values again is a new intent", async () => {
    consoleSetTenantStockLevel
      .mockResolvedValueOnce(fail(409, "idempotency_key_conflict"))
      .mockResolvedValueOnce(ok(levels(tenantLevel({ reorderLevel: "15", updatedAt: LATER }))));
    renderSection("owner");
    const d = await openTenant();
    type(d, "Reorder level", "15");
    save(d);
    await within(d).findByText(/could not be matched to the earlier attempt/);
    save(d);
    await screen.findByText("The tenant level is saved.");
    const sent = consoleSetTenantStockLevel.mock.calls.map((c) => c[2]);
    expect(sent[1]).not.toBe(sent[0]);
  });

  test("425 in progress keeps the key for the retry", async () => {
    consoleSetTenantStockLevel
      .mockResolvedValueOnce({
        status: 425,
        error: { error: "idempotency_in_progress", retryAfterSec: 2 },
      })
      .mockResolvedValueOnce(
        ok(levels(tenantLevel({ reorderLevel: "15", updatedAt: LATER }), []), true),
      );
    renderSection("owner");
    const d = await openTenant();
    type(d, "Reorder level", "15");
    save(d);
    await within(d).findByText(/still being processed/);
    save(d);
    await screen.findByText("The tenant level is saved.");
    const sent = consoleSetTenantStockLevel.mock.calls.map((c) => c[2]);
    expect(sent[1]).toBe(sent[0]);
    // A replayed answer may be old: the levels are read again.
    await waitFor(() => expect(consoleGetProductStockLevels).toHaveBeenCalledTimes(2));
  });

  // --- Retire ---------------------------------------------------------------------------------------

  test("remove asks first, Cancel has focus and sends nothing; confirm sends the precondition", async () => {
    consoleRetireStoreStockLevel.mockResolvedValue(ok(levels(tenantLevel(), [])));
    renderSection("store_manager");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Change the level for Cairo Festival" }));
    const d = await screen.findByRole("dialog", { name: "Stock level for Cairo Festival" });
    fireEvent.click(within(d).getByRole("button", { name: "Remove level" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    const confirm = within(d).getByRole("region", { name: "Confirm: remove the stock level" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(consoleRetireStoreStockLevel).not.toHaveBeenCalled();
    fireEvent.click(within(d).getByRole("button", { name: "Remove level" }));
    fireEvent.click(within(storeDrawer()).getByRole("button", { name: "Yes, remove the level" }));
    await screen.findByText(
      "The level for Cairo Festival is removed. The store now follows the tenant level.",
    );
    expect(consoleRetireStoreStockLevel).toHaveBeenCalledWith(PRODUCT, CAIRO, SEEN_AT);
  });

  test("a 404 on remove reads as already gone, and the levels are read again", async () => {
    consoleRetireTenantStockLevel.mockResolvedValue(fail(404, "not_found"));
    renderSection("owner");
    const d = await openTenant();
    consoleGetProductStockLevels.mockResolvedValue(ok(levels(null, [storeLevel()])));
    fireEvent.click(within(d).getByRole("button", { name: "Remove level" }));
    fireEvent.click(within(tenantDrawer()).getByRole("button", { name: "Yes, remove the level" }));
    await screen.findByText("This level had already been removed. The levels shown are current.");
    expect(consoleRetireTenantStockLevel).toHaveBeenCalledWith(PRODUCT, SEEN_AT);
    expect(consoleGetProductStockLevels).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/No tenant level is set/)).toBeDefined();
  });

  test("409 stale_write on remove reloads and says so; nothing is removed", async () => {
    consoleRetireTenantStockLevel.mockResolvedValue(fail(409, "stale_write"));
    renderSection("owner");
    const d = await openTenant();
    consoleGetProductStockLevels.mockResolvedValue(
      ok(levels(tenantLevel({ reorderLevel: "30", updatedAt: LATER }))),
    );
    fireEvent.click(within(d).getByRole("button", { name: "Remove level" }));
    fireEvent.click(within(tenantDrawer()).getByRole("button", { name: "Yes, remove the level" }));
    await within(d).findByText(/Review them before removing it/);
    expect((field(d, "Reorder level") as HTMLInputElement).value).toBe("30");
    expect(consoleRetireTenantStockLevel).toHaveBeenCalledTimes(1);
  });

  test("no level, no Remove", async () => {
    consoleGetProductStockLevels.mockResolvedValue(ok(levels(null, [])));
    renderSection("owner");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Set the tenant level" }));
    const d = await screen.findByRole("dialog", { name: "Tenant stock level" });
    expect(within(d).queryByRole("button", { name: "Remove level" })).toBeNull();
  });
});
