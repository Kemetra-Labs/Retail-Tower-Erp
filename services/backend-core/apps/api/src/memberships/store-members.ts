/**
 * The live memberships with access to one store, as a public port of `memberships` (RT-1453).
 * Store deletion (its preview and its write: one evaluator) used to name `memberships`, `roles` and
 * `store_access` itself to find the members whose ONLY store is the one being deleted. It asks this port
 * instead, on the caller's client, and decides "only store" against its own `stores` rows: this port owns
 * only the membership side (who has specific access to the store, with what role, and which stores).
 */
import type { PoolClient } from "pg";

export interface StoreMemberAccess {
  readonly userId: string;
  readonly roleCode: string;
  /** Every store the membership has specific access to (the given store included), by no particular order. */
  readonly storeIds: readonly string[];
}

/**
 * Every live membership of `specific` store access that has access to `storeId`, by user id, with the
 * role code and the full list of stores it has access to. No row cap: the caller filters, then caps.
 */
export async function listSpecificAccessMembersOfStore(client: PoolClient, storeId: string): Promise<StoreMemberAccess[]> {
  const r = await client.query<{ user_id: string; role_code: string; store_ids: string[] }>(
    `SELECT m.user_id, r.code AS role_code,
            ARRAY(SELECT sb.store_id FROM store_access sb WHERE sb.membership_id = m.id) AS store_ids
       FROM memberships m
       JOIN roles r ON r.id = m.role_id AND r.tenant_id = m.tenant_id
      WHERE m.deleted_at IS NULL
        AND m.store_access_kind = 'specific'
        AND EXISTS (SELECT 1 FROM store_access sa WHERE sa.membership_id = m.id AND sa.store_id = $1)
      ORDER BY m.user_id`,
    [storeId],
  );
  return r.rows.map((row) => ({ userId: row.user_id, roleCode: row.role_code, storeIds: row.store_ids }));
}
