/**
 * The open Count Sessions of a store, as a public port of `inventory` (RT-1453). Store deletion (its
 * preview and its write: one evaluator) used to name `count_sessions` and import the open-state list
 * from `count-sessions-setting.service`. It asks this port instead, on the caller's client.
 *
 * Open = not finished: `OPEN_COUNT_SESSION_STATES`, the one list the Count Sessions switch-off guard uses.
 */
import type { PoolClient } from "pg";

import { OPEN_COUNT_SESSION_STATES } from "./count-sessions/count-sessions-setting.service";

interface OpenCountSessionRecord {
  readonly sessionId: string;
  readonly status: string;
}

/** Every open Count Session of the store, with no row cap: the exact count a deletion guard decides on. */
export async function countOpenCountSessionsOfStore(client: PoolClient, storeId: string): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM count_sessions WHERE store_id = $1 AND state = ANY($2::text[])`,
    [storeId, OPEN_COUNT_SESSION_STATES],
  );
  return r.rows[0]?.n ?? 0;
}

/** The open Count Sessions of the store by id, capped at `limit` (a preview list, never the guard). */
export async function listOpenCountSessionsOfStore(
  client: PoolClient,
  storeId: string,
  limit: number,
): Promise<OpenCountSessionRecord[]> {
  const r = await client.query<{ id: string; state: string }>(
    `SELECT id, state FROM count_sessions
      WHERE store_id = $1 AND state = ANY($2::text[]) ORDER BY id LIMIT $3`,
    [storeId, OPEN_COUNT_SESSION_STATES, limit],
  );
  return r.rows.map((row) => ({ sessionId: row.id, status: row.state }));
}
