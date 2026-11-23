/**
 * Which users were not deleted at an instant, as a public port of `auth` (the owner of `users`; RT-1453
 * boundaries; RT-1565, RT-285 F-1).
 *
 * A sale's seller or payment receiver must be a user who was not deleted at the sale's `occurredAt`; a later
 * deletion does not matter (an offline sale still syncs). Reads only `id` and `deleted_at`, the columns the
 * domain role may read (`users-columns.grants.ts`). Runs on the caller's client.
 */
import type { PoolClient } from "pg";

export async function usersLiveAt(
  client: PoolClient,
  query: { readonly userIds: readonly string[]; readonly at: string },
): Promise<ReadonlySet<string>> {
  if (query.userIds.length === 0) return new Set();
  const r = await client.query<{ id: string }>(
    `SELECT u.id::text AS id
       FROM users u
      WHERE u.id = ANY($1::uuid[])
        AND (u.deleted_at IS NULL OR u.deleted_at > $2::timestamptz)`,
    [[...query.userIds], query.at],
  );
  return new Set(r.rows.map((row) => row.id.toLowerCase()));
}
