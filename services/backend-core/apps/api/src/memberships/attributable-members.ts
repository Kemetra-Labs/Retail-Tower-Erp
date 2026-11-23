/**
 * The members a sale may be attributed to, as a public port of `memberships` (RT-1453 boundaries;
 * RT-1565, RT-285 F-1).
 *
 * A sale line's seller or a tender's payment receiver must be a member of the sale's tenant whose
 * membership was neither revoked nor soft-deleted at the sale's `occurredAt`, with access to the sale's
 * store as it stands now (`store_access_kind = 'all'`, or a `store_access` row). Checked at `occurredAt`,
 * like {@link wasTenantMemberAt}, so a sale rung offline still syncs after the member later leaves. The
 * membership's start does not decide eligibility: `created_at` is the server's clock and `occurredAt` the
 * till's.
 *
 * It does decide WHICH membership's role is frozen (Policy §8: the role at sale time). Among a user's
 * qualifying memberships, the role comes from:
 *   1. a membership in effect at `at`: created no later than `at` plus {@link START_SKEW_SECONDS} (the
 *      cashier-admission clock-skew tolerance, rev709 F2); the newest of them, if there are several;
 *   2. otherwise (none had started yet, a till clock far behind), the EARLIEST membership created after
 *      `at`, the closest to the sale, never a later replacement.
 * So a member who left and came back is frozen with the role they held when the sale was rung.
 *
 * Runs on the caller's tenant-scoped client (RLS); `tenantId` is also explicit.
 */
import type { PoolClient } from "pg";

/** The clock-skew allowance on a membership's start, equal to the cashier-admission tolerance (120 s). */
const START_SKEW_SECONDS = 120;

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
      ORDER BY m.user_id,
               (m.created_at <= $4::timestamptz + make_interval(secs => $5::float8)) DESC,
               CASE WHEN m.created_at <= $4::timestamptz + make_interval(secs => $5::float8) THEN m.created_at END DESC NULLS LAST,
               m.created_at ASC,
               m.id`,
    [query.tenantId, query.storeId, [...query.userIds], query.at, START_SKEW_SECONDS],
  );
  return new Map(r.rows.map((row) => [row.user_id.toLowerCase(), row.role_id]));
}
