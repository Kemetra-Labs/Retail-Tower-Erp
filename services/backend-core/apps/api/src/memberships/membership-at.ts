/**
 * Whether a user was a member of a tenant at a past instant, as a public port of `memberships` (RT-1453).
 *
 * RT-1312 slice C (decision C2): a Console repair of a quarantined sale attributes the sale to the cashier its
 * body names, but only when that user held a membership of the tenant at the sale's `occurredAt`. A
 * membership removed or revoked LATER does not matter (a later removal never blocks repairing a
 * historical sale), so this reads the row's own lifetime, `created_at` up to the earlier of `revoked_at` and
 * `deleted_at`, and not whether it is live now. Runs on the caller's tenant-scoped client (RLS).
 */
import type { PoolClient } from "pg";

export async function wasTenantMemberAt(
  client: PoolClient,
  member: { readonly tenantId: string; readonly userId: string },
  at: Date,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1
       FROM memberships
      WHERE tenant_id = $1::uuid AND user_id = $2::uuid
        AND created_at <= $3::timestamptz
        AND (revoked_at IS NULL OR revoked_at > $3::timestamptz)
        AND (deleted_at IS NULL OR deleted_at > $3::timestamptz)
      LIMIT 1`,
    [member.tenantId, member.userId, at],
  );
  return (r.rowCount ?? 0) > 0;
}
