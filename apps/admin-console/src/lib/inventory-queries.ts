/**
 * RT-728 data layer: typed wrappers over the generated `apiClient` for the four
 * READ operations of the Backend-Core inventory contract
 * (`inventory/inventory.yaml`):
 *
 *   - `listStockMovements`: a store's movement ledger, newest first, keyset
 *     paged. Always sent with `scope=all` (RT-731: every movement of the store,
 *     across every product and ad-hoc) and never with `productId`, which the
 *     API refuses together with `scope`.
 *   - `listStockLocations`: a store's stock locations, primary first.
 *   - `getOnHand`: the derived on-hand of one (store, product).
 *   - `listTrackingIdentities`: a product's batches / serials (owner /
 *     tenant_admin; any other role is a non-disclosing 404).
 *
 * RT-436 adds the one write the status-disposition action needs:
 * `createStatusMove` (RT-435). Boundary: `createStockMovement`,
 * `createStockTransfer`, `recordStockCount`, `createRelocation` and the
 * sale-linked backfill are NOT wrapped and NOT called here; the tracking holds,
 * recalls and identity reads and commands live in `tracking-queries.ts` (RT-455).
 *
 * RT-1515 (PR 1) adds the three shipment-Transfer READS of 1.21.0-draft:
 * `listShipmentTransfers`, `getShipmentTransfer` and
 * `listShipmentTransferReceipts`. PR 2 adds the four writes of a Transfer's
 * first half: `createShipmentTransfer`, `approveShipmentTransfer`,
 * `cancelShipmentTransfer` and `dispatchShipmentTransfer`, each with the
 * required Idempotency-Key. Receive and close are a later PR. Until the
 * tenant's shipment workflow is switched on, each answers the non-disclosing 404.
 * Same `{ status, data?, error?, retryAfter? }`
 * shape as `src/lib/sale-sync-ops-queries.ts`. Cookie transport is on the
 * generated client.
 */
import { apiClient } from "@/generated/client";
import type { InventorySchema } from "@/generated/schema";
import { classifyRateLimit } from "@/lib/rate-limit";

type Schemas = InventorySchema.components["schemas"];

// --- Generated projections (no hand-typed shapes) -----------------------------

export type StockMovement = Schemas["StockMovement"];
export type StockMovementList = Schemas["StockMovementList"];
export type StockLocation = Schemas["StockLocation"];
export type StockLocationList = Schemas["StockLocationList"];
export type OnHand = Schemas["OnHand"];
export type InventoryStatus = Schemas["InventoryStatus"];
export type TrackingIdentity = Schemas["TrackingIdentity"];
export type TrackingIdentityList = Schemas["TrackingIdentityList"];
export type InventoryReasonCode = Schemas["InventoryReasonCode"];
export type CreateStatusMoveCommand = Schemas["CreateStatusMoveCommand"];
export type InventoryPositionEvent = Schemas["InventoryPositionEvent"];
export type ShipmentTransfer = Schemas["ShipmentTransfer"];
export type ShipmentTransferList = Schemas["ShipmentTransferList"];
export type ShipmentTransferLine = Schemas["ShipmentTransferLine"];
export type ShipmentTransferState = Schemas["ShipmentTransferState"];
export type ShipmentLegIntegrationState = Schemas["ShipmentLegIntegrationState"];
export type ShipmentTransferReceipt = Schemas["ShipmentTransferReceipt"];
export type ShipmentTransferReceiptList = Schemas["ShipmentTransferReceiptList"];
export type CreateShipmentTransferCommand = Schemas["CreateShipmentTransferCommand"];
export type CreateShipmentTransferLine = Schemas["CreateShipmentTransferLine"];
export type ApproveShipmentTransferCommand = Schemas["ApproveShipmentTransferCommand"];
export type CancelShipmentTransferCommand = Schemas["CancelShipmentTransferCommand"];
export type DispatchShipmentTransferCommand = Schemas["DispatchShipmentTransferCommand"];

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

/** The list filters `listShipmentTransfers` offers; `direction` only means something with `storeId`. */
export interface ShipmentTransferFilter {
  storeId?: string;
  direction?: "outbound" | "inbound" | "any";
  state?: ShipmentTransferState;
}

/** A 429's wait in seconds via the shared RT-621 classifier (30 s fallback, [1, 3600]). */
function retryAfterOf(response: Response): number | undefined {
  return classifyRateLimit({
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
  })?.retryAfterSeconds;
}

function resultOf<D, E>(res: { data?: D; error?: E; response: Response }) {
  return {
    status: res.response.status,
    data: res.data,
    error: res.error,
    retryAfter: retryAfterOf(res.response),
  };
}

// --- Typed operation wrappers -------------------------------------------------

/** GET /api/inventory/v1/stores/{storeId}/movements?scope=all */
export async function listStoreMovements(storeId: string, query: PageQuery = {}) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/stores/{storeId}/movements", {
      params: { path: { storeId }, query: { ...query, scope: "all" } },
    }),
  );
}

/** GET /api/inventory/v1/stores/{storeId}/locations */
export async function listStockLocations(storeId: string) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/stores/{storeId}/locations", {
      params: { path: { storeId } },
    }),
  );
}

/** GET /api/inventory/v1/on-hand/{storeId}/{productId} */
export async function getOnHand(storeId: string, productId: string) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/on-hand/{storeId}/{productId}", {
      params: { path: { storeId, productId } },
    }),
  );
}

/** GET /api/inventory/v1/products/{productId}/tracking-identities */
export async function listTrackingIdentities(productId: string, query: PageQuery = {}) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/products/{productId}/tracking-identities", {
      params: { path: { productId }, query },
    }),
  );
}

/**
 * POST /api/inventory/v1/stores/{storeId}/status-moves (RT-435): one status move
 * (`-quantity` in `fromStatus`, `+quantity` in `toStatus`, same location).
 * `Idempotency-Key` is required; the same key with the same body replays.
 */
export async function createStatusMove(
  storeId: string,
  command: CreateStatusMoveCommand,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/stores/{storeId}/status-moves", {
      params: { path: { storeId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
    }),
  );
}

/**
 * GET /api/inventory/v1/shipment-transfers (RT-1512): the tenant's Transfers,
 * newest first, keyset paged. `direction` is sent only with `storeId` (the API
 * ignores it otherwise); the cursor is bound to these filters.
 */
export async function listShipmentTransfers(
  filter: ShipmentTransferFilter = {},
  query: PageQuery = {},
) {
  const { storeId, direction, state } = filter;
  return resultOf(
    await apiClient.GET("/api/inventory/v1/shipment-transfers", {
      params: {
        query: {
          ...query,
          ...(storeId ? { storeId, ...(direction ? { direction } : {}) } : {}),
          ...(state ? { state } : {}),
        },
      },
    }),
  );
}

/** GET /api/inventory/v1/shipment-transfers/{transferId} */
export async function getShipmentTransfer(transferId: string) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/shipment-transfers/{transferId}", {
      params: { path: { transferId } },
    }),
  );
}

/** GET /api/inventory/v1/shipment-transfers/{transferId}/receipts: oldest first, keyset paged. */
export async function listShipmentTransferReceipts(transferId: string, query: PageQuery = {}) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/shipment-transfers/{transferId}/receipts", {
      params: { path: { transferId }, query },
    }),
  );
}

// --- Shipment-Transfer writes (RT-1515 PR 2): Idempotency-Key required on each ---

/** POST /api/inventory/v1/shipment-transfers: a new Transfer in `draft` (201). */
export async function createShipmentTransfer(
  command: CreateShipmentTransferCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/shipment-transfers", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}

/** POST .../{transferId}/approve: draft to approved; reserves the source stock until the expiry. */
export async function approveShipmentTransfer(
  transferId: string,
  command: ApproveShipmentTransferCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/shipment-transfers/{transferId}/approve", {
      params: { path: { transferId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}

/** POST .../{transferId}/cancel: draft or approved to cancelled; the reason is required. */
export async function cancelShipmentTransfer(
  transferId: string,
  command: CancelShipmentTransferCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/shipment-transfers/{transferId}/cancel", {
      params: { path: { transferId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}

/** POST .../{transferId}/dispatch: approved to in_transit; the whole approved quantity leaves. */
export async function dispatchShipmentTransfer(
  transferId: string,
  command: DispatchShipmentTransferCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/shipment-transfers/{transferId}/dispatch", {
      params: { path: { transferId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}
