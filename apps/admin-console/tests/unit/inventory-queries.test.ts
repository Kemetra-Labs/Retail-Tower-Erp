import { beforeEach, describe, expect, test, vi } from "vitest";

const GET = vi.fn();
const POST = vi.fn();
vi.mock("@/generated/client", () => ({
  apiClient: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));

import {
  approveShipmentTransfer,
  cancelShipmentTransfer,
  closeShipmentTransfer,
  createShipmentTransfer,
  dispatchShipmentTransfer,
  getOnHand,
  getShipmentTransfer,
  listShipmentTransferReceipts,
  listShipmentTransfers,
  listStockLocations,
  listStoreMovements,
  listTrackingIdentities,
  recordShipmentTransferReceipt,
} from "@/lib/inventory-queries";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";

function response(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers) };
}

/**
 * RT-728 wrappers: each calls exactly its generated path with the contract's
 * params and returns `{ status, data, error, retryAfter }`.
 */
describe("inventory read wrappers", () => {
  beforeEach(() => GET.mockReset());

  test("the store ledger always asks for scope=all and never sends productId", async () => {
    GET.mockResolvedValue({ data: { items: [], nextCursor: null }, response: response(200) });
    const res = await listStoreMovements(STORE, { cursor: "c1" });
    expect(GET).toHaveBeenCalledWith("/api/inventory/v1/stores/{storeId}/movements", {
      params: { path: { storeId: STORE }, query: { cursor: "c1", scope: "all" } },
    });
    expect(res).toEqual({
      status: 200,
      data: { items: [], nextCursor: null },
      error: undefined,
      retryAfter: undefined,
    });
  });

  test("a 429 carries the server's Retry-After through the shared classifier", async () => {
    GET.mockResolvedValue({
      error: { error: { code: "rate_limited", message: "x" } },
      response: response(429, { "Retry-After": "12" }),
    });
    expect((await listStoreMovements(STORE)).retryAfter).toBe(12);
    GET.mockResolvedValue({ error: {}, response: response(429) });
    expect((await listStockLocations(STORE)).retryAfter).toBe(30);
  });

  test("listStockLocations reads the store's locations", async () => {
    GET.mockResolvedValue({ data: { items: [] }, response: response(200) });
    await listStockLocations(STORE);
    expect(GET).toHaveBeenCalledWith("/api/inventory/v1/stores/{storeId}/locations", {
      params: { path: { storeId: STORE } },
    });
  });

  test("getOnHand reads one (store, product)", async () => {
    GET.mockResolvedValue({ data: {}, response: response(200) });
    await getOnHand(STORE, PRODUCT);
    expect(GET).toHaveBeenCalledWith("/api/inventory/v1/on-hand/{storeId}/{productId}", {
      params: { path: { storeId: STORE, productId: PRODUCT } },
    });
  });

  test("listTrackingIdentities pages one product's identities", async () => {
    GET.mockResolvedValue({ data: { items: [], nextCursor: null }, response: response(200) });
    await listTrackingIdentities(PRODUCT, { cursor: "n2" });
    expect(GET).toHaveBeenCalledWith("/api/inventory/v1/products/{productId}/tracking-identities", {
      params: { path: { productId: PRODUCT }, query: { cursor: "n2" } },
    });
  });

  // RT-1515 (PR 1): the three shipment-Transfer reads.
  test("listShipmentTransfers sends only the filters it was given; direction only with a store", async () => {
    const TRANSFER_LIST = "/api/inventory/v1/shipment-transfers";
    GET.mockResolvedValue({ data: { items: [], nextCursor: null }, response: response(200) });
    await listShipmentTransfers();
    expect(GET).toHaveBeenLastCalledWith(TRANSFER_LIST, { params: { query: {} } });
    await listShipmentTransfers(
      { storeId: STORE, direction: "inbound", state: "in_transit" },
      { cursor: "c2" },
    );
    expect(GET).toHaveBeenLastCalledWith(TRANSFER_LIST, {
      params: {
        query: { cursor: "c2", storeId: STORE, direction: "inbound", state: "in_transit" },
      },
    });
    await listShipmentTransfers({ direction: "outbound" });
    expect(GET).toHaveBeenLastCalledWith(TRANSFER_LIST, { params: { query: {} } });
    await listShipmentTransfers({ storeId: STORE });
    expect(GET).toHaveBeenLastCalledWith(TRANSFER_LIST, { params: { query: { storeId: STORE } } });
  });

  test("getShipmentTransfer reads one Transfer; its receipts page by cursor", async () => {
    const TRANSFER = "0190f000-0000-7000-8000-00000000a001";
    GET.mockResolvedValue({ data: {}, response: response(200) });
    await getShipmentTransfer(TRANSFER);
    expect(GET).toHaveBeenLastCalledWith("/api/inventory/v1/shipment-transfers/{transferId}", {
      params: { path: { transferId: TRANSFER } },
    });
    GET.mockResolvedValue({ data: { items: [], nextCursor: null }, response: response(200) });
    await listShipmentTransferReceipts(TRANSFER, { cursor: "r2" });
    expect(GET).toHaveBeenLastCalledWith(
      "/api/inventory/v1/shipment-transfers/{transferId}/receipts",
      { params: { path: { transferId: TRANSFER }, query: { cursor: "r2" } } },
    );
    await listShipmentTransferReceipts(TRANSFER);
    expect(GET).toHaveBeenLastCalledWith(
      "/api/inventory/v1/shipment-transfers/{transferId}/receipts",
      { params: { path: { transferId: TRANSFER }, query: {} } },
    );
  });
});

/**
 * RT-1515 (PR 2) shipment-Transfer writes: each POSTs exactly its generated path
 * with the command as the body and the required Idempotency-Key header, and
 * returns `{ status, data, error, retryAfter }`.
 */
describe("shipment-Transfer write wrappers", () => {
  const TRANSFER = "0190f000-0000-7000-8000-00000000a001";
  const KEY = "0190f000-0000-4000-8000-00000000cafe";

  beforeEach(() => POST.mockReset());

  test("createShipmentTransfer POSTs the command with its key and the abort signal", async () => {
    POST.mockResolvedValue({ data: { id: TRANSFER }, response: response(201) });
    const command = {
      sourceStoreId: STORE,
      destinationStoreId: "0190f000-0000-7000-8000-0000000007a2",
      lines: [
        { tenantProductRef: PRODUCT, quantity: "2", stockingUnit: "kg", trackingIdentityId: null },
      ],
      reason: null,
    };
    const signal = new AbortController().signal;
    const res = await createShipmentTransfer(command, KEY, signal);
    expect(POST).toHaveBeenCalledWith("/api/inventory/v1/shipment-transfers", {
      params: { header: { "Idempotency-Key": KEY } },
      body: command,
      signal,
    });
    expect(res).toEqual({
      status: 201,
      data: { id: TRANSFER },
      error: undefined,
      retryAfter: undefined,
    });
  });

  test.each([
    ["approve", approveShipmentTransfer, { reservationExpiresAt: "2026-12-01T10:00:00.000Z" }],
    ["cancel", cancelShipmentTransfer, { reason: "Wrong store" }],
    ["dispatch", dispatchShipmentTransfer, { note: null }],
  ] as const)("%s POSTs its path with the transfer id, body and key", async (op, send, body) => {
    POST.mockResolvedValue({ data: { id: TRANSFER }, response: response(200) });
    await (send as (id: string, b: unknown, k: string) => Promise<unknown>)(TRANSFER, body, KEY);
    expect(POST).toHaveBeenCalledWith(`/api/inventory/v1/shipment-transfers/{transferId}/${op}`, {
      params: { path: { transferId: TRANSFER }, header: { "Idempotency-Key": KEY } },
      body,
      signal: undefined,
    });
  });

  test("a refusal keeps its status and error body, and a 429 its Retry-After", async () => {
    POST.mockResolvedValue({
      error: { error: { code: "rate_limited", message: "x" } },
      response: response(429, { "Retry-After": "7" }),
    });
    const res = await cancelShipmentTransfer(TRANSFER, { reason: "r" }, KEY);
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe(7);
    expect(res.error).toEqual({ error: { code: "rate_limited", message: "x" } });
  });
});

/**
 * RT-1515 (PR 3) receive and close: each POSTs its generated path with the
 * command as the body, the required Idempotency-Key header and the abort signal.
 */
describe("shipment-Transfer receive and close wrappers", () => {
  const TRANSFER = "0190f000-0000-7000-8000-00000000a001";
  const LINE = "0190f000-0000-7000-8000-00000000b001";
  const KEY = "0190f000-0000-4000-8000-00000000cafe";

  beforeEach(() => POST.mockReset());

  test("recordShipmentTransferReceipt POSTs the receipt command to /receipts", async () => {
    POST.mockResolvedValue({ data: { id: "r1" }, response: response(201) });
    const command = {
      lines: [
        {
          transferLineId: LINE,
          quantity: "4",
          disposition: "damaged" as const,
          stockLocationId: null,
        },
      ],
      note: null,
    };
    const signal = new AbortController().signal;
    const res = await recordShipmentTransferReceipt(TRANSFER, command, KEY, signal);
    expect(POST).toHaveBeenCalledWith(
      "/api/inventory/v1/shipment-transfers/{transferId}/receipts",
      {
        params: { path: { transferId: TRANSFER }, header: { "Idempotency-Key": KEY } },
        body: command,
        signal,
      },
    );
    expect(res.status).toBe(201);
  });

  test.each([
    ["a full close", { shortCloseReason: null }],
    ["a short-close", { shortCloseReason: "Lost in transit" }],
  ])("closeShipmentTransfer sends %s to /close", async (_name, command) => {
    POST.mockResolvedValue({ data: { id: TRANSFER }, response: response(200) });
    const signal = new AbortController().signal;
    await closeShipmentTransfer(TRANSFER, command, KEY, signal);
    expect(POST).toHaveBeenCalledWith("/api/inventory/v1/shipment-transfers/{transferId}/close", {
      params: { path: { transferId: TRANSFER }, header: { "Idempotency-Key": KEY } },
      body: command,
      signal,
    });
  });

  test("a 409 refusal keeps its status and error body", async () => {
    POST.mockResolvedValue({
      error: { error: { code: "over_receipt_requires_approval", message: "x" } },
      response: response(409),
    });
    const res = await recordShipmentTransferReceipt(TRANSFER, { lines: [], note: null }, KEY);
    expect(res.status).toBe(409);
    expect(res.error).toEqual({ error: { code: "over_receipt_requires_approval", message: "x" } });
  });
});
