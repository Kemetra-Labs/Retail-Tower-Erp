/**
 * RT-1484 — a read-only lookup of the tenant catalogue for other modules, on the caller's client
 * inside its tenant transaction (RLS). The catalog module owns `tenant_products` (RT-1453), so
 * pricing asks here whether a product id is the tenant's instead of naming the table.
 */
import type { PoolClient } from "pg";

/** Whether `productId` is a product of `tenantId`, retired ones included (their price history still resolves). */
export async function isTenantProduct(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  productId: string,
): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM tenant_products WHERE tenant_id = $1::uuid AND id = $2::uuid`, [
    tenantId,
    productId,
  ]);
  return (r.rowCount ?? 0) > 0;
}
