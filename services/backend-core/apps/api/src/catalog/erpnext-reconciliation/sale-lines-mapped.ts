/**
 * 015-RESOLVE: every line of the sale resolves to a confirmed, non-retired item map (a line with no product,
 * or whose product has no such map, is unmapped). Extracted from `erpnext-reconciliation.service.ts`
 * (RT-1463) so the catalog split's before/after guard can compare it with its frozen copy.
 */
import type { PoolClient } from "pg";

export async function allSaleLinesMapped(client: PoolClient, saleId: string): Promise<boolean> {
  const unmapped = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM sale_lines sl
       LEFT JOIN erpnext_item_map m
         ON m.tenant_product_id = sl.tenant_product_ref
        AND m.state = 'confirmed'
        AND m.retired_at IS NULL
      WHERE sl.sale_id = $1
        AND (sl.tenant_product_ref IS NULL OR m.id IS NULL)`,
    [saleId],
  );
  return Number(unmapped.rows[0]!.count) === 0;
}
