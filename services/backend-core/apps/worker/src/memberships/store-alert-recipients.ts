/**
 * RT-1525 — who receives a store's sync-failure alert, owned by `memberships` (module-map.json:
 * `memberships`, `roles`, `store_access`). Moved from sync-failure-alert.repository.ts (RT-1034); the
 * rule is unchanged: the tenant's `owner` and `tenant_admin`, plus a `store_manager` with access to
 * the store (all stores, or this one through `store_access`), with a live membership.
 *
 * It returns user ids only: whether a user is live, and their address, are `auth`'s (`users`). It
 * runs on the CALLER's client, so the caller's transaction and tenant GUC stay in force.
 */
import type { PoolClient } from "pg";

const RECIPIENT_IDS_SQL = `
  SELECT m.user_id
    FROM memberships m
    JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
   WHERE m.tenant_id = $1
     AND m.revoked_at IS NULL AND m.deleted_at IS NULL
     AND (
       r.code IN ('owner', 'tenant_admin')
       OR (r.code = 'store_manager'
           AND (m.store_access_kind = 'all'
                OR (m.store_access_kind = 'specific'
                    AND EXISTS (SELECT 1 FROM store_access sa
                                 WHERE sa.tenant_id = m.tenant_id
                                   AND sa.membership_id = m.id
                                   AND sa.store_id = $2))))
     )`;

/** The user ids the rule admits for the store; with `onlyUserId`, that user's id or nothing. */
export async function storeAlertRecipientUserIds(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  storeId: string,
  onlyUserId?: string,
): Promise<string[]> {
  const r =
    onlyUserId === undefined
      ? await client.query<{ user_id: string }>(RECIPIENT_IDS_SQL, [tenantId, storeId])
      : await client.query<{ user_id: string }>(`${RECIPIENT_IDS_SQL} AND m.user_id = $3`, [tenantId, storeId, onlyUserId]);
  return [...new Set(r.rows.map((row) => row.user_id))];
}
