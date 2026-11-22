import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page as catalogPage, product } from "./catalog-fixtures";

const api = {
  listStoreMovements: vi.fn(),
  listStockLocations: vi.fn(),
  getOnHand: vi.fn(),
  listTrackingIdentities: vi.fn(),
  listShipmentTransfers: vi.fn(),
  getShipmentTransfer: vi.fn(),
  listShipmentTransferReceipts: vi.fn(),
  createShipmentTransfer: vi.fn(),
  approveShipmentTransfer: vi.fn(),
  cancelShipmentTransfer: vi.fn(),
  dispatchShipmentTransfer: vi.fn(),
};
vi.mock("@/lib/inventory-queries", () => ({
  listStoreMovements: (...a: unknown[]) => api.listStoreMovements(...a),
  listStockLocations: (...a: unknown[]) => api.listStockLocations(...a),
  getOnHand: (...a: unknown[]) => api.getOnHand(...a),
  listTrackingIdentities: (...a: unknown[]) => api.listTrackingIdentities(...a),
  listShipmentTransfers: (...a: unknown[]) => api.listShipmentTransfers(...a),
  getShipmentTransfer: (...a: unknown[]) => api.getShipmentTransfer(...a),
  listShipmentTransferReceipts: (...a: unknown[]) => api.listShipmentTransferReceipts(...a),
  createShipmentTransfer: (...a: unknown[]) => api.createShipmentTransfer(...a),
  approveShipmentTransfer: (...a: unknown[]) => api.approveShipmentTransfer(...a),
  cancelShipmentTransfer: (...a: unknown[]) => api.cancelShipmentTransfer(...a),
  dispatchShipmentTransfer: (...a: unknown[]) => api.dispatchShipmentTransfer(...a),
}));
const consoleListCatalogProducts = vi.fn();
vi.mock("@/lib/catalog-queries", () => ({
  consoleListCatalogProducts: (...a: unknown[]) => consoleListCatalogProducts(...a),
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

import { InventoryTransfers } from "@/inventory/transfers/InventoryTransfers";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";

const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const ALEX = "0190f000-0000-7000-8000-0000000007a2";
const T1 = "0190f000-0000-7000-8000-00000000a001";
const T_NEW = "0190f000-0000-7000-8000-00000000a0ff";
const LINE = "0190f000-0000-7000-8000-00000000b001";
const OIL = "0190f000-0000-7000-8000-0000000007c1";
const MILK = "0190f000-0000-7000-8000-0000000007c2";
const SERIAL = "0190f000-0000-7000-8000-0000000007c3";
const BATCH_A = "0190f000-0000-7000-8000-0000000007f1";
const BATCH_B = "0190f000-0000-7000-8000-0000000007f2";
const ME = "0190f000-0000-7000-8000-0000000000a1";
const REQUEST_ID = "0190f000-0000-7000-8000-0000000007e1";
const KEY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
const failure = (status: number, code?: string, retryAfter?: number) => ({
  status,
  retryAfter,
  error: code ? { error: { code, message: "server words", request_id: REQUEST_ID } } : undefined,
});

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    id: T1,
    sourceStoreId: CAIRO,
    destinationStoreId: ALEX,
    state: "draft",
    lines: [
      {
        id: LINE,
        lineSeq: 1,
        tenantProductRef: OIL,
        stockingUnit: "kg",
        trackingIdentityId: null,
        quantity: "10.0000",
        dispatchedQuantity: "0.0000",
        receivedQuantity: "0.0000",
        shortClosedQuantity: "0.0000",
        inTransitQuantity: "0.0000",
        dispatchMovementId: null,
      },
    ],
    reason: null,
    createdBy: ME,
    createdAt: "2026-11-20T08:00:00Z",
    approval: null,
    reservation: null,
    dispatch: null,
    dispatchIntegrationState: null,
    shortClose: null,
    closure: null,
    cancellation: null,
    receiptCount: 0,
    updatedAt: "2026-11-20T08:00:00Z",
    ...overrides,
  };
}

const stores = [
  { id: CAIRO, code: "CAI", name: "Cairo Festival", timezone: "Africa/Cairo", is_active: true },
  { id: ALEX, code: "ALX", name: "Alexandria", timezone: "Africa/Cairo", is_active: true },
];

const products = [
  product({ productId: OIL, name: "Olive oil", trackingMode: "none" }),
  product({ productId: MILK, name: "Fresh milk", trackingMode: "batch" }),
  product({ productId: SERIAL, name: "Router", trackingMode: "serial" }),
];

const onHandOf = (storeId: string, productId: string, over: Record<string, unknown> = {}) => ({
  storeId,
  productId,
  quantity: "10.0000",
  stockingUnit: "kg",
  negativeBalance: false,
  sellableQuantity: "8.0000",
  statusQuantities: [],
  ...over,
});

function renderPage(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/inventory/transfers"]}>
        <Routes>
          <Route path="/inventory/transfers" element={<InventoryTransfers />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  consoleListCatalogProducts.mockReset();
  listStores.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  listStores.mockResolvedValue({ status: 200, data: stores });
  consoleListCatalogProducts.mockResolvedValue(catalogPage(products));
  api.listShipmentTransfers.mockResolvedValue(page([transfer()]));
  api.getShipmentTransfer.mockResolvedValue(ok(transfer()));
  api.listShipmentTransferReceipts.mockResolvedValue(page([]));
  api.getOnHand.mockImplementation(async (storeId: string, productId: string) =>
    ok(onHandOf(storeId, productId)),
  );
  api.listTrackingIdentities.mockResolvedValue(
    page([
      { id: BATCH_A, productId: MILK, kind: "batch", code: "LOT-A", expiryDate: null },
      { id: BATCH_B, productId: MILK, kind: "batch", code: "LOT-B", expiryDate: null },
    ]),
  );
  api.createShipmentTransfer.mockResolvedValue({
    status: 201,
    data: transfer({ id: T_NEW }),
  });
});
afterEach(cleanup);

// --- Create ------------------------------------------------------------------------------

async function openCreate() {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "New transfer" }));
  return screen.getByRole("dialog", { name: "New transfer" });
}

async function chooseStore(dialog: HTMLElement, label: string, id: string, name: string) {
  const select = within(dialog).getByLabelText(label);
  await within(select).findByRole("option", { name });
  fireEvent.change(select, { target: { value: id } });
}

async function addProduct(dialog: HTMLElement, name: string) {
  fireEvent.click(await within(dialog).findByRole("option", { name: new RegExp(name) }));
}

const sendButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: /Save transfer draft|Send the same request again/ });

/** A source, a destination and one untracked product with a quantity, ready to send. */
async function fillReady(dialog: HTMLElement, quantity = "2.5") {
  await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
  await chooseStore(dialog, "Destination store", ALEX, "Alexandria");
  await addProduct(dialog, "Olive oil");
  await waitFor(() => expect(within(dialog).getByText("kg", { selector: "bdi" })).toBeDefined());
  fireEvent.change(within(dialog).getByLabelText(/^Quantity/), { target: { value: quantity } });
}

describe("the New transfer control (RT-1515 PR 2)", () => {
  test.each(["owner", "tenant_admin", "store_manager"])("%s sees it", async (role) => {
    activeContext.mockReturnValue(ctx(role));
    renderPage();
    expect(await screen.findByRole("button", { name: "New transfer" })).toBeDefined();
    expect(screen.getByText(/Here you can draft, approve, cancel and dispatch/)).toBeDefined();
  });

  test.each(["store_staff", "cashier", null])("%s gets no page and no control", (role) => {
    activeContext.mockReturnValue(ctx(role));
    renderPage();
    expect(screen.queryByRole("button", { name: "New transfer" })).toBeNull();
    expect(api.listShipmentTransfers).not.toHaveBeenCalled();
  });
});

describe("create a Draft (RT-1515 PR 2)", () => {
  test("the destination offers every other store, never the source", async () => {
    const dialog = await openCreate();
    await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
    const destination = within(dialog).getByLabelText("Destination store");
    await within(destination).findByRole("option", { name: "Alexandria" });
    expect(within(destination).queryByRole("option", { name: "Cairo Festival" })).toBeNull();
    // Choosing the destination as the new source clears it.
    fireEvent.change(destination, { target: { value: ALEX } });
    fireEvent.change(within(dialog).getByLabelText("Source store"), { target: { value: ALEX } });
    expect((within(dialog).getByLabelText("Destination store") as HTMLSelectElement).value).toBe(
      "",
    );
  });

  test("sends the strict command with a key, then opens the new Transfer read from the server", async () => {
    const dialog = await openCreate();
    await fillReady(dialog);
    fireEvent.change(within(dialog).getByLabelText(/^Reason for the transfer/), {
      target: { value: "  Weekend restock " },
    });
    fireEvent.click(sendButton(dialog));
    await waitFor(() => expect(api.createShipmentTransfer).toHaveBeenCalledTimes(1));
    const [command, key] = api.createShipmentTransfer.mock.calls[0] ?? [];
    expect(command).toEqual({
      sourceStoreId: CAIRO,
      destinationStoreId: ALEX,
      lines: [
        { tenantProductRef: OIL, quantity: "2.5", stockingUnit: "kg", trackingIdentityId: null },
      ],
      reason: "Weekend restock",
    });
    expect(key).toMatch(KEY_SHAPE);
    const detail = await screen.findByRole("dialog", { name: "Transfer details" });
    expect(detail).toBeDefined();
    expect(api.getShipmentTransfer).toHaveBeenCalledWith(T_NEW);
    // The list is read again after the recorded write; nothing is edited locally.
    await waitFor(() => expect(api.listShipmentTransfers.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByRole("dialog", { name: "New transfer" })).toBeNull();
  });

  test("a line shows the source's Physical on-hand and Sellable, labelled separately, no ATS", async () => {
    const dialog = await openCreate();
    await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
    await addProduct(dialog, "Olive oil");
    await waitFor(() => expect(api.getOnHand).toHaveBeenCalledWith(CAIRO, OIL));
    const line = await within(dialog).findByTestId("transfer-create-line");
    expect(within(line).getByText("Physical on-hand at source")).toBeDefined();
    expect(within(line).getByText("10.0000")).toBeDefined();
    expect(within(line).getByText("Sellable at source")).toBeDefined();
    expect(within(line).getByText("8.0000")).toBeDefined();
    expect(line.textContent).not.toMatch(/\bStock\b|available to sell/i);
  });

  test("changing the source store reads each line's on-hand again", async () => {
    const dialog = await openCreate();
    await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
    await addProduct(dialog, "Olive oil");
    await waitFor(() => expect(api.getOnHand).toHaveBeenCalledWith(CAIRO, OIL));
    fireEvent.change(within(dialog).getByLabelText("Source store"), { target: { value: ALEX } });
    await waitFor(() => expect(api.getOnHand).toHaveBeenCalledWith(ALEX, OIL));
  });

  test("an unknown stocking unit says why and blocks the send", async () => {
    api.getOnHand.mockImplementation(async (s: string, p: string) =>
      ok(onHandOf(s, p, { stockingUnit: null })),
    );
    const dialog = await openCreate();
    await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
    await chooseStore(dialog, "Destination store", ALEX, "Alexandria");
    await addProduct(dialog, "Olive oil");
    expect(await within(dialog).findByText(/Unknown: no unit is recorded/)).toBeDefined();
    fireEvent.change(within(dialog).getByLabelText(/^Quantity/), { target: { value: "1" } });
    fireEvent.click(sendButton(dialog));
    expect(
      await within(dialog).findByText(
        /stocking unit of this product at the source store is unknown/,
      ),
    ).toBeDefined();
    expect(api.createShipmentTransfer).not.toHaveBeenCalled();
  });

  test("a failed stock read says why, offers a retry, and blocks the send", async () => {
    api.getOnHand.mockResolvedValue(failure(500, "internal_error"));
    const dialog = await openCreate();
    await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
    await chooseStore(dialog, "Destination store", ALEX, "Alexandria");
    await addProduct(dialog, "Olive oil");
    expect(await within(dialog).findByText(/stock could not be read/)).toBeDefined();
    fireEvent.change(within(dialog).getByLabelText(/^Quantity/), { target: { value: "1" } });
    fireEvent.click(sendButton(dialog));
    await within(dialog).findByText(/stocking unit of this product at the source store is unknown/);
    expect(api.createShipmentTransfer).not.toHaveBeenCalled();
    api.getOnHand.mockImplementation(async (s: string, p: string) => ok(onHandOf(s, p)));
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await within(dialog).findByText("Physical on-hand at source");
  });

  test("a serial product is not added, with copy that says so", async () => {
    const dialog = await openCreate();
    await addProduct(dialog, "Router");
    expect(
      await within(dialog).findByText(/Serial-tracked products cannot be transferred yet/),
    ).toBeDefined();
    expect(within(dialog).queryByTestId("transfer-create-line")).toBeNull();
  });

  test("an untracked product is one line only", async () => {
    const dialog = await openCreate();
    await addProduct(dialog, "Olive oil");
    await addProduct(dialog, "Olive oil");
    expect(await within(dialog).findByText(/already added/)).toBeDefined();
    expect(within(dialog).getAllByTestId("transfer-create-line")).toHaveLength(1);
  });

  test("a batch product needs exactly one chosen batch; the choice is sent", async () => {
    const dialog = await openCreate();
    await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
    await chooseStore(dialog, "Destination store", ALEX, "Alexandria");
    await addProduct(dialog, "Fresh milk");
    await waitFor(() => expect(within(dialog).getByText("kg", { selector: "bdi" })).toBeDefined());
    fireEvent.change(within(dialog).getByLabelText(/^Quantity/), { target: { value: "3" } });
    fireEvent.click(sendButton(dialog));
    expect(await within(dialog).findByText("Choose a batch for this product.")).toBeDefined();
    expect(api.createShipmentTransfer).not.toHaveBeenCalled();
    fireEvent.click(await within(dialog).findByRole("radio", { name: "LOT-B" }));
    fireEvent.click(sendButton(dialog));
    await waitFor(() => expect(api.createShipmentTransfer).toHaveBeenCalledTimes(1));
    expect(api.createShipmentTransfer.mock.calls[0]?.[0].lines[0].trackingIdentityId).toBe(BATCH_B);
  });

  test("the same batch of one product on two lines is refused in the form", async () => {
    const dialog = await openCreate();
    await chooseStore(dialog, "Source store", CAIRO, "Cairo Festival");
    await chooseStore(dialog, "Destination store", ALEX, "Alexandria");
    await addProduct(dialog, "Fresh milk");
    await addProduct(dialog, "Fresh milk");
    await waitFor(() =>
      expect(within(dialog).getAllByTestId("transfer-create-line")).toHaveLength(2),
    );
    const lines = within(dialog).getAllByTestId("transfer-create-line");
    for (const line of lines) {
      fireEvent.click(await within(line).findByRole("radio", { name: "LOT-A" }));
      fireEvent.change(within(line).getByLabelText(/^Quantity/), { target: { value: "1" } });
    }
    fireEvent.click(sendButton(dialog));
    expect(await within(dialog).findByText(/repeated on another line/)).toBeDefined();
    expect(api.createShipmentTransfer).not.toHaveBeenCalled();
  });

  test("an invalid quantity and no lines are refused before anything is sent", async () => {
    const dialog = await openCreate();
    fireEvent.click(sendButton(dialog));
    expect(await within(dialog).findByText("Choose the source store.")).toBeDefined();
    expect(within(dialog).getByText("Choose the destination store.")).toBeDefined();
    expect(within(dialog).getByText("Add at least one product.")).toBeDefined();
    await fillReady(dialog, "0");
    fireEvent.click(sendButton(dialog));
    expect(
      await within(dialog).findByText("Enter a quantity above zero, up to 4 decimal places."),
    ).toBeDefined();
    expect(api.createShipmentTransfer).not.toHaveBeenCalled();
  });

  test("no answer: unknown if recorded, and the retry reuses the same key and body", async () => {
    api.createShipmentTransfer
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ status: 201, data: transfer({ id: T_NEW }) });
    const dialog = await openCreate();
    await fillReady(dialog);
    fireEvent.click(sendButton(dialog));
    expect(
      await within(dialog).findByText(/it is unknown whether the request was recorded/),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the same request again" }));
    await waitFor(() => expect(api.createShipmentTransfer).toHaveBeenCalledTimes(2));
    const [first, second] = api.createShipmentTransfer.mock.calls;
    expect(second?.[1]).toBe(first?.[1]);
    expect(second?.[0]).toEqual(first?.[0]);
    await screen.findByRole("dialog", { name: "Transfer details" });
  });

  test("an edit after a refusal starts a new key", async () => {
    api.createShipmentTransfer.mockResolvedValue(failure(400, "validation_error"));
    const dialog = await openCreate();
    await fillReady(dialog);
    fireEvent.click(sendButton(dialog));
    await within(dialog).findByText(/rejected the request data/);
    fireEvent.change(within(dialog).getByLabelText(/^Quantity/), { target: { value: "3" } });
    fireEvent.click(sendButton(dialog));
    await waitFor(() => expect(api.createShipmentTransfer).toHaveBeenCalledTimes(2));
    expect(api.createShipmentTransfer.mock.calls[1]?.[1]).not.toBe(
      api.createShipmentTransfer.mock.calls[0]?.[1],
    );
  });

  test("a refusal is worded by code with the request id, never the server's message", async () => {
    api.createShipmentTransfer.mockResolvedValue(failure(409, "transfer_warehouse_unmapped"));
    const dialog = await openCreate();
    await fillReady(dialog);
    fireEvent.click(sendButton(dialog));
    expect(await within(dialog).findByText(/not mapped to an ERPNext warehouse/)).toBeDefined();
    expect(within(dialog).getByText(REQUEST_ID)).toBeDefined();
    expect(within(dialog).queryByText("server words")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Transfer details" })).toBeNull();
  });

  test("an unknown code shows generic copy plus the code, LTR-isolated", async () => {
    api.createShipmentTransfer.mockResolvedValue(failure(409, "brand_new_code"));
    const dialog = await openCreate();
    await fillReady(dialog);
    fireEvent.click(sendButton(dialog));
    expect(await within(dialog).findByText(/could not complete the request/)).toBeDefined();
    const code = within(dialog).getByText("brand_new_code");
    expect(code.getAttribute("dir")).toBe("ltr");
    expect(within(dialog).queryByText("server words")).toBeNull();
  });

  test("a 429 says the wait the server sent", async () => {
    api.createShipmentTransfer.mockResolvedValue(failure(429, "rate_limited", 12));
    const dialog = await openCreate();
    await fillReady(dialog);
    fireEvent.click(sendButton(dialog));
    expect(await within(dialog).findByText(/Retry in 12 seconds/)).toBeDefined();
  });

  test("a key conflict is refused in words and the next submit sends a new key", async () => {
    api.createShipmentTransfer.mockResolvedValueOnce(failure(409, "idempotency_key_conflict"));
    const dialog = await openCreate();
    await fillReady(dialog);
    fireEvent.click(sendButton(dialog));
    expect(
      await within(dialog).findByText(/could not be confirmed and was not recorded/),
    ).toBeDefined();
    fireEvent.click(sendButton(dialog));
    await waitFor(() => expect(api.createShipmentTransfer).toHaveBeenCalledTimes(2));
    expect(api.createShipmentTransfer.mock.calls[1]?.[1]).not.toBe(
      api.createShipmentTransfer.mock.calls[0]?.[1],
    );
  });
});

// --- The Transfer drawer's actions -------------------------------------------------------------

async function openTransfer() {
  renderPage();
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Open transfer details/ }))[0] as HTMLElement,
  );
  const dialog = screen.getByRole("dialog", { name: "Transfer details" });
  await within(dialog)
    .findByRole("heading", { name: "Actions" })
    .catch(() => undefined);
  return dialog;
}

const approved = () =>
  transfer({
    state: "approved",
    approval: { by: ME, at: "2026-11-20T09:00:00Z" },
  });

describe("approve, cancel and dispatch gating by state (RT-1515 PR 2)", () => {
  test("a draft offers Approve and Cancel, never Dispatch", async () => {
    const dialog = await openTransfer();
    expect(await within(dialog).findByRole("button", { name: "Approve transfer" })).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Cancel transfer" })).toBeDefined();
    expect(within(dialog).queryByRole("button", { name: "Dispatch transfer" })).toBeNull();
  });

  test("an approved Transfer offers Dispatch and Cancel, never Approve", async () => {
    api.getShipmentTransfer.mockResolvedValue(ok(approved()));
    const dialog = await openTransfer();
    expect(await within(dialog).findByRole("button", { name: "Dispatch transfer" })).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Cancel transfer" })).toBeDefined();
    expect(within(dialog).queryByRole("button", { name: "Approve transfer" })).toBeNull();
  });

  test.each(["in_transit", "partially_received", "received", "closed", "cancelled"])(
    "a %s Transfer offers no write action",
    async (state) => {
      api.getShipmentTransfer.mockResolvedValue(ok(transfer({ state })));
      const dialog = await openTransfer();
      await within(dialog).findByRole("table", {
        name: "The transfer's lines and their quantities",
      });
      expect(within(dialog).queryByRole("heading", { name: "Actions" })).toBeNull();
      expect(
        within(dialog).queryByRole("button", { name: /Approve|Dispatch|Cancel transfer/ }),
      ).toBeNull();
    },
  );
});

describe("approve (RT-1515 PR 2)", () => {
  test("offers 1, 3 or 7 days (3 by default), shows the resulting date and sends it in the future", async () => {
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Approve transfer" }));
    const select = within(dialog).getByLabelText("Reservation window") as HTMLSelectElement;
    expect(select.value).toBe("3");
    expect([...select.options].map((o) => o.text)).toEqual(["1 day", "3 days", "7 days"]);
    expect(within(dialog).getByText(/The reservation ends around/)).toBeDefined();
    fireEvent.change(select, { target: { value: "7" } });
    api.approveShipmentTransfer.mockResolvedValue(ok(approved()));
    const before = Date.now();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.approveShipmentTransfer).toHaveBeenCalledTimes(1));
    const [id, command, key] = api.approveShipmentTransfer.mock.calls[0] ?? [];
    expect(id).toBe(T1);
    expect(key).toMatch(KEY_SHAPE);
    const at = new Date(command.reservationExpiresAt).getTime();
    expect(at).toBeGreaterThan(before);
    expect(at - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(at - before).toBeLessThan(7 * 86_400_000 + 60_000);
  });

  test("a recorded approval says so, re-reads the Transfer and then offers Dispatch", async () => {
    api.approveShipmentTransfer.mockImplementation(async () => {
      api.getShipmentTransfer.mockResolvedValue(ok(approved()));
      return ok(approved());
    });
    const dialog = await openTransfer();
    const reads = api.getShipmentTransfer.mock.calls.length;
    fireEvent.click(await within(dialog).findByRole("button", { name: "Approve transfer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await within(dialog).findByText("The approval was recorded.")).toBeDefined();
    await waitFor(() => expect(api.getShipmentTransfer.mock.calls.length).toBeGreaterThan(reads));
    expect(await within(dialog).findByRole("button", { name: "Dispatch transfer" })).toBeDefined();
    expect(within(dialog).queryByRole("button", { name: "Approve transfer" })).toBeNull();
  });

  test("no answer: the retry reuses the key and the very same expiry", async () => {
    api.approveShipmentTransfer
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(ok(approved()));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Approve transfer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(
      await within(dialog).findByText(/it is unknown whether the request was recorded/),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the same request again" }));
    await waitFor(() => expect(api.approveShipmentTransfer).toHaveBeenCalledTimes(2));
    const [first, second] = api.approveShipmentTransfer.mock.calls;
    expect(second?.[2]).toBe(first?.[2]);
    expect(second?.[1]).toEqual(first?.[1]);
  });

  test("a refusal in a state that changed is worded by its code, with the request id", async () => {
    api.approveShipmentTransfer.mockResolvedValue(failure(409, "shipment_transfer_not_in_state"));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Approve transfer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(
      await within(dialog).findByText(/state has changed and this action is no longer available/),
    ).toBeDefined();
    expect(within(dialog).getByText(REQUEST_ID)).toBeDefined();
    expect(within(dialog).queryByText("server words")).toBeNull();
    expect(within(dialog).queryByText("The approval was recorded.")).toBeNull();
  });

  test.each([
    ["tracking_identity_held_or_expired", /on hold or expired/],
    ["transfer_item_unmapped", /not mapped to its ERPNext counterpart/],
    ["cross_legal_entity_transfer", /different legal entities/],
    ["forbidden", /Your role does not allow this action/],
    ["not_found", /not available to you/],
  ])("%s has its own copy", async (code, copy) => {
    api.approveShipmentTransfer.mockResolvedValue(failure(code === "forbidden" ? 403 : 409, code));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Approve transfer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await within(dialog).findByText(copy)).toBeDefined();
  });
});

describe("cancel (RT-1515 PR 2)", () => {
  test("a reason is required; nothing is sent without one", async () => {
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Cancel transfer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
    expect(
      await within(dialog).findByText("Enter a reason for cancelling, 1 to 500 characters."),
    ).toBeDefined();
    expect(api.cancelShipmentTransfer).not.toHaveBeenCalled();
  });

  test("sends the trimmed reason with a key, and says it was recorded", async () => {
    api.cancelShipmentTransfer.mockResolvedValue(ok(transfer({ state: "cancelled" })));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Cancel transfer" }));
    fireEvent.change(within(dialog).getByLabelText("Reason for cancelling"), {
      target: { value: "  Wrong store " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(api.cancelShipmentTransfer).toHaveBeenCalledTimes(1));
    const [id, command, key] = api.cancelShipmentTransfer.mock.calls[0] ?? [];
    expect([id, command]).toEqual([T1, { reason: "Wrong store" }]);
    expect(key).toMatch(KEY_SHAPE);
    expect(await within(dialog).findByText("The cancellation was recorded.")).toBeDefined();
  });

  test("an approved Transfer can be cancelled too", async () => {
    api.getShipmentTransfer.mockResolvedValue(ok(approved()));
    api.cancelShipmentTransfer.mockResolvedValue(ok(transfer({ state: "cancelled" })));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Cancel transfer" }));
    fireEvent.change(within(dialog).getByLabelText("Reason for cancelling"), {
      target: { value: "Store closed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(api.cancelShipmentTransfer).toHaveBeenCalledTimes(1));
  });
});

describe("dispatch (RT-1515 PR 2)", () => {
  test("says the whole approved quantity leaves and goes In transit; the note is optional", async () => {
    api.getShipmentTransfer.mockResolvedValue(ok(approved()));
    api.dispatchShipmentTransfer.mockResolvedValue(ok(transfer({ state: "in_transit" })));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Dispatch transfer" }));
    expect(
      within(dialog).getByText(
        /whole approved quantity leaves the source store and goes In transit/,
      ),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm dispatch" }));
    await waitFor(() => expect(api.dispatchShipmentTransfer).toHaveBeenCalledTimes(1));
    const [id, command, key] = api.dispatchShipmentTransfer.mock.calls[0] ?? [];
    expect([id, command]).toEqual([T1, { note: null }]);
    expect(key).toMatch(KEY_SHAPE);
    expect(await within(dialog).findByText("The dispatch was recorded.")).toBeDefined();
  });

  test("sends the trimmed note when there is one", async () => {
    api.getShipmentTransfer.mockResolvedValue(ok(approved()));
    api.dispatchShipmentTransfer.mockResolvedValue(ok(transfer({ state: "in_transit" })));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Dispatch transfer" }));
    fireEvent.change(within(dialog).getByLabelText(/^Dispatch note/), {
      target: { value: " Two pallets " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm dispatch" }));
    await waitFor(() =>
      expect(api.dispatchShipmentTransfer.mock.calls[0]?.[1]).toEqual({ note: "Two pallets" }),
    );
  });

  test("a refusal shows its code copy and no success", async () => {
    api.getShipmentTransfer.mockResolvedValue(ok(approved()));
    api.dispatchShipmentTransfer.mockResolvedValue(failure(409, "transfer_warehouse_unmapped"));
    const dialog = await openTransfer();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Dispatch transfer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm dispatch" }));
    expect(await within(dialog).findByText(/not mapped to an ERPNext warehouse/)).toBeDefined();
    expect(within(dialog).queryByText("The dispatch was recorded.")).toBeNull();
  });
});
