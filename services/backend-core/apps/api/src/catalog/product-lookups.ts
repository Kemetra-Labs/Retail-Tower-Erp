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

/** Which of `productIds` are products of `tenantId`, each with whether it is live (not retired). */
export async function tenantProductLiveness(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  productIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (productIds.length === 0) return new Map();
  const r = await client.query<{ id: string; live: boolean }>(
    `SELECT id::text AS id, retired_at IS NULL AS live FROM tenant_products WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
    [tenantId, productIds],
  );
  return new Map(r.rows.map((row) => [row.id, row.live]));
}

/**
 * The live products of each category in `categoryIds` (v1 categories are flat, Q7: the "subtree"
 * is the category itself). A category the tenant does not have, or a retired one, holds none.
 */
export async function liveProductsOfCategories(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  categoryIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(categoryIds.map((id) => [id, []]));
  if (categoryIds.length === 0) return out;
  const r = await client.query<{ category_id: string; id: string }>(
    `SELECT p.category_id::text AS category_id, p.id::text AS id
       FROM tenant_products p
       JOIN tenant_product_categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id AND c.retired_at IS NULL
      WHERE p.tenant_id = $1::uuid AND p.category_id = ANY($2::uuid[]) AND p.retired_at IS NULL
      ORDER BY p.id`,
    [tenantId, categoryIds],
  );
  for (const row of r.rows) out.get(row.category_id)?.push(row.id);
  return out;
}

/** productId -> `tracking_mode` (`none` | `batch` | `serial`). A product that is not visible is absent (RT-1513). */
export async function trackingModesOfProducts(client: PoolClient, productIds: readonly string[]): Promise<Map<string, string>> {
  const r = await client.query<{ id: string; tracking_mode: string }>(
    `SELECT id, tracking_mode FROM tenant_products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  return new Map(r.rows.map((x) => [x.id, x.tracking_mode] as const));
}

/** Whether `productId` is visible to the caller's tenant (RLS-filtered: another tenant's product reads false). */
export async function tenantProductVisible(client: Pick<PoolClient, "query">, productId: string): Promise<boolean> {
  const r = await client.query<{ id: string }>(`SELECT id FROM tenant_products WHERE id = $1 LIMIT 1`, [productId]);
  return r.rows[0] !== undefined;
}

/** productId -> name, for the visible products among `ids` (tenant RLS). */
export async function productNamesByIds(client: Pick<PoolClient, "query">, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = await client.query<{ id: string; name: string }>(`SELECT id, name FROM tenant_products WHERE id = ANY($1::uuid[])`, [ids]);
  for (const r of rows.rows) names.set(r.id, r.name);
  return names;
}

/** The Tracking Profile facts of the visible products among `ids` (ids as lower-case text), keyed by id. */
export async function productTrackingProfiles(
  client: Pick<PoolClient, "query">,
  ids: readonly string[],
): Promise<Map<string, { readonly id: string; readonly tracking_mode: string; readonly expiry_required: boolean }>> {
  if (ids.length === 0) return new Map();
  const r = await client.query<{ id: string; tracking_mode: string; expiry_required: boolean }>(
    `SELECT id::text AS id, tracking_mode, expiry_required FROM tenant_products WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(r.rows.map((row) => [row.id, row]));
}
