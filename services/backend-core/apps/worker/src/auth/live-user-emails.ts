/**
 * RT-1525 — the worker's read of live users' addresses, owned by `auth` (module-map.json: `users`).
 *
 * Runs on the CALLER's client, so the caller's transaction and tenant GUC stay in force.
 */
import type { PoolClient } from "pg";

/** `{ userId, email }` of each of `userIds` that is not deleted, ordered by user id. */
export async function liveUserEmails(
  client: Pick<PoolClient, "query">,
  userIds: readonly string[],
): Promise<Array<{ userId: string; email: string }>> {
  if (userIds.length === 0) return [];
  const r = await client.query<{ user_id: string; email: string }>(
    `SELECT u.id AS user_id, u.email FROM users u WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL ORDER BY u.id`,
    [userIds],
  );
  return r.rows.map((row) => ({ userId: row.user_id, email: row.email }));
}
