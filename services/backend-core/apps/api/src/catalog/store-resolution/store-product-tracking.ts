/**
 * RT-1463: the product as a store resolves it, for the tracked-selling reads of sale capture (the lot
 * lookup and the TLV). Moved here from `sales/tracked-lines/tracked-lots.service.ts` because it reads
 * only `catalog` tables (`tenant_products` and the store's override). Runs on the caller's client,
 * inside its tenant transaction.
 */
import type { PoolClient } from "pg";

import { pinOverrideStore, storeOverrideJoinSql } from "./store-product-resolution";

export interface StoreProductTracking {
  readonly tracking_mode: string;
  readonly expiry_required: boolean;
  /** Not retired and active at the store: the Store Override's `is_active`, else the product's. */
  readonly sellable_at_store: boolean;
}

/**
 * `$1` product, `$2` tenant, `$3` store: the product as the store resolves it
 * (`store-product-resolution.ts`). RT-451 (comment 16246): the lot lookup and
 * the TLV share it, so a product inactive at the store by its Store Override
 * lists no lots, as the TLV refuses them (`not_sellable`).
 */
const PRODUCT_SQL = `
  SELECT tp.tracking_mode, tp.expiry_required,
         (tp.retired_at IS NULL AND COALESCE(spo.is_active, tp.is_active)) AS sellable_at_store
    FROM tenant_products tp
    ${storeOverrideJoinSql("$3::uuid")}
   WHERE tp.id = $1 AND tp.tenant_id = $2`;

/**
 * The product as the caller's store resolves it, or null when it is not in the
 * tenant. Pins `app.current_store` (transaction-local) so the store's override
 * rows are visible to the join; only the catalog override policies read it.
 */
export async function readStoreProductTracking(
  client: PoolClient,
  input: { readonly tenantId: string; readonly storeId: string; readonly productId: string },
): Promise<StoreProductTracking | null> {
  await pinOverrideStore(client, input.storeId);
  const rows = await client.query<StoreProductTracking>(PRODUCT_SQL, [input.productId, input.tenantId, input.storeId]);
  return rows.rows[0] ?? null;
}
