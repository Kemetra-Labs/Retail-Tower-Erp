/**
 * RT-1463 — what the shipment Transfer emission needs from the ERP sync side, declared by Inventory (an
 * inverted port, like `stores/store-pricing-lifecycle.port.ts`).
 *
 * The ERP posting code imports Inventory (the posting ack releases receipt legs and drives the inventory
 * effects), so Inventory may not import it back: that closes a module cycle (RT-1454). Inventory declares
 * this interface and its DI token instead. The ERP posting side implements it
 * (`erpnext-posting/transfer-erp.adapter.ts`) and provides the token from a `@Global()` module that only
 * the composition root (`app.module.ts`) imports.
 *
 * Every method runs on the CALLER's client, so the caller's transaction and RLS context stay in force. The
 * SQL (`erpnext_posting_status`, `erpnext_item_map`, `erpnext_tracking_map`, `erpnext_warehouse_map`) stays
 * in the module that owns those tables (RT-1513 moved it there from Inventory).
 */
import type { PoolClient } from "pg";

/** The DI token the ERP posting side provides `TransferErpPort` under. */
export const TRANSFER_ERP_PORT = "TRANSFER_ERP_PORT";

export interface TransferWarehouseRefs {
  readonly source: string | null;
  readonly destination: string | null;
  /** The tenant's transit warehouse (owner ruling O2): a map row with no store. */
  readonly transit: string | null;
}

interface TransferLegInsert {
  readonly tenantId: string;
  readonly storeId: string;
  readonly kind: "transfer_dispatch" | "transfer_receive";
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly payloadHash: string;
}

export interface TransferErpPort {
  /** The active ERP warehouse references of a Transfer's two stores and of the tenant transit warehouse. */
  transferWarehouseRefs(client: PoolClient, sourceStoreId: string, destinationStoreId: string): Promise<TransferWarehouseRefs>;
  /** Whether the tenant has an active transit warehouse mapping. */
  hasActiveTransitWarehouse(client: PoolClient, tenantId: string): Promise<boolean>;
  /** productId -> the confirmed, active ERPNext item reference. A product with none is absent. */
  confirmedItemRefs(client: PoolClient, productIds: readonly string[]): Promise<Map<string, string>>;
  /** identityId -> the ERPNext Batch from the edge map (885). An identity with no edge-map row is absent. */
  batchRefsOfIdentities(client: PoolClient, identityIds: readonly string[]): Promise<Map<string, string>>;
  /** Insert one transfer leg work item as a `pending` posting row; a replay returns the existing row, `fresh = false`. */
  insertTransferLeg(client: PoolClient, input: TransferLegInsert): Promise<{ readonly id: string; readonly fresh: boolean }>;
  /** The status and the ERPNext document reference (once posted) of a posting row. */
  postingLegStatus(
    client: PoolClient,
    intentId: string,
  ): Promise<{ readonly status: string; readonly documentRef: string | null } | null>;
}
