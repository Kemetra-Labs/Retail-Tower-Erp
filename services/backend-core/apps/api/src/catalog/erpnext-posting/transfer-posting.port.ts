/**
 * RT-1513: the `catalog`-owned reads and the one write the shipment Transfer emission (inventory) needs, as a public port
 * of `catalog` (RT-1453). Inventory used to have to name `erpnext_posting_status`, `erpnext_item_map`,
 * `erpnext_tracking_map`, `erpnext_warehouse_map` and `tenant_products` itself; it asks here instead, on the caller's
 * client (so the caller's transaction and RLS context stay in force).
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

export interface TransferWarehouseRefs {
  readonly source: string | null;
  readonly destination: string | null;
  /** The tenant's transit warehouse (owner ruling O2): a map row with no store. */
  readonly transit: string | null;
}

/** The active ERP warehouse references of a Transfer's two stores and of the tenant transit warehouse. */
export async function transferWarehouseRefs(
  client: PoolClient,
  sourceStoreId: string,
  destinationStoreId: string,
): Promise<TransferWarehouseRefs> {
  const r = await client.query<{ store_id: string | null; purpose: string; erpnext_warehouse_ref: string }>(
    `SELECT store_id, purpose, erpnext_warehouse_ref FROM erpnext_warehouse_map
      WHERE retired_at IS NULL
        AND ((purpose = 'stock' AND store_id = ANY($1::uuid[])) OR purpose = 'transit')`,
    [[sourceStoreId, destinationStoreId]],
  );
  const find = (purpose: string, storeId: string | null): string | null =>
    r.rows.find((x) => x.purpose === purpose && x.store_id === storeId)?.erpnext_warehouse_ref ?? null;
  return {
    source: find("stock", sourceStoreId),
    destination: find("stock", destinationStoreId),
    transit: find("transit", null),
  };
}

/** Whether the tenant has an active transit warehouse mapping (RLS scopes the read to the caller's tenant). */
export async function hasActiveTransitWarehouse(client: PoolClient, tenantId: string): Promise<boolean> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erpnext_warehouse_map WHERE tenant_id = $1 AND purpose = 'transit' AND retired_at IS NULL`,
    [tenantId],
  );
  return Number(r.rows[0]?.n ?? "0") > 0;
}

/** productId -> the confirmed, active ERPNext item reference. A product with none is absent. */
export async function confirmedItemRefs(client: PoolClient, productIds: readonly string[]): Promise<Map<string, string>> {
  const r = await client.query<{ tenant_product_id: string; erpnext_item_ref: string }>(
    `SELECT tenant_product_id, erpnext_item_ref FROM erpnext_item_map
      WHERE tenant_product_id = ANY($1::uuid[]) AND state = 'confirmed' AND retired_at IS NULL`,
    [productIds],
  );
  return new Map(r.rows.map((x) => [x.tenant_product_id, x.erpnext_item_ref] as const));
}

/** identityId -> the ERPNext Batch from the edge map (885). An identity with no edge-map row is absent. */
export async function batchRefsOfIdentities(client: PoolClient, identityIds: readonly string[]): Promise<Map<string, string>> {
  if (identityIds.length === 0) return new Map();
  const r = await client.query<{ tracking_identity_id: string; erpnext_ref: string }>(
    `SELECT tracking_identity_id, erpnext_ref FROM erpnext_tracking_map
      WHERE tracking_identity_id = ANY($1::uuid[]) AND kind = 'batch'`,
    [identityIds],
  );
  return new Map(r.rows.map((x) => [x.tracking_identity_id, x.erpnext_ref] as const));
}

/** productId -> `tracking_mode` (`none` | `batch` | `serial`). A product that is not visible is absent. */
export async function trackingModesOfProducts(client: PoolClient, productIds: readonly string[]): Promise<Map<string, string>> {
  const r = await client.query<{ id: string; tracking_mode: string }>(
    `SELECT id, tracking_mode FROM tenant_products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  return new Map(r.rows.map((x) => [x.id, x.tracking_mode] as const));
}

/**
 * Insert one transfer leg work item (`transfer_dispatch` or `transfer_receive`) as a `pending` posting row whose
 * `externalId` is the leg-level provenance key (888, 889). `ON CONFLICT DO NOTHING` on the unique leg key (migration
 * 0125): a replay returns the existing row with `fresh = false` and writes nothing.
 */
export async function insertTransferLeg(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly kind: "transfer_dispatch" | "transfer_receive";
    readonly sourceSystem: string;
    readonly externalId: string;
    readonly payloadHash: string;
  },
): Promise<{ readonly id: string; readonly fresh: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, 'pending')
     ON CONFLICT (tenant_id, external_id) WHERE kind IN ('transfer_dispatch', 'transfer_receive') DO NOTHING
     RETURNING id`,
    [newId(), input.tenantId, input.storeId, input.kind, newId(), input.sourceSystem, input.externalId, input.payloadHash],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, fresh: true };
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM erpnext_posting_status
      WHERE tenant_id = $1 AND external_id = $2 AND kind IN ('transfer_dispatch', 'transfer_receive')`,
    [input.tenantId, input.externalId],
  );
  const found = existing.rows[0]?.id;
  if (!found) throw new Error("TransferPosting: the leg neither inserted nor exists");
  return { id: found, fresh: false };
}

/** The status and the ERPNext document reference (`{doctype, name}` JSON text, once posted) of a posting row. */
export async function postingLegStatus(
  client: PoolClient,
  intentId: string,
): Promise<{ readonly status: string; readonly documentRef: string | null } | null> {
  const r = await client.query<{ status: string; document_ref: string | null }>(
    `SELECT status, document_ref FROM erpnext_posting_status WHERE id = $1`,
    [intentId],
  );
  const row = r.rows[0];
  return row ? { status: row.status, documentRef: row.document_ref } : null;
}
