/**
 * The members a sale may be attributed to, as a public port of `memberships` (RT-1453 boundaries;
 * RT-1565, RT-285 F-1).
 *
 * A sale line's seller or a tender's payment receiver must be a member of the sale's tenant whose
 * membership was neither revoked nor soft-deleted at the sale's `occurredAt`, with access to the sale's
 * store as it stands now (`store_access_kind = 'all'`, or a `store_access` row). Checked at `occurredAt`,
 * like {@link wasTenantMemberAt}, so a sale rung offline still syncs after the member later leaves. The
 * membership's start is not checked: `created_at` is the server's clock and `occurredAt` the till's.
 *
 * Returns each eligible user with the role of the membership that covered `at` (the newest, if a member
 * left and came back). Runs on the caller's tenant-scoped client (RLS); `tenantId` is also explicit.
 */
import type { PoolClient } from "pg";

export async function attributableMembersAt(
  client: PoolClient,
  query: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly userIds: readonly string[];
    readonly at: string;
  },
): Promise<ReadonlyMap<string, string>> {
  if (query.userIds.length === 0) return new Map();
  const r = await client.query<{ user_id: string; role_id: string }>(
    `SELECT DISTINCT ON (m.user_id) m.user_id::text AS user_id, m.role_id::text AS role_id
       FROM memberships m
      WHERE m.tenant_id = $1::uuid
        AND m.user_id = ANY($3::uuid[])
        AND (m.revoked_at IS NULL OR m.revoked_at > $4::timestamptz)
        AND (m.deleted_at IS NULL OR m.deleted_at > $4::timestamptz)
        AND (m.store_access_kind = 'all'
             OR EXISTS (SELECT 1 FROM store_access sa WHERE sa.membership_id = m.id AND sa.store_id = $2::uuid))
      ORDER BY m.user_id, m.created_at DESC, m.id`,
    [query.tenantId, query.storeId, [...query.userIds], query.at],
  );
  return new Map(r.rows.map((row) => [row.user_id.toLowerCase(), row.role_id]));
}
