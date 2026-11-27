/**
 * RT-1498 (migration 0073) — durable capture of the originating operator's `users.id`
 * (`return_journal_origin`), written in the journal insert transaction so `return.resolve_unknown`
 * enforces four-eyes against the return originator too (RT-196 §3.3).
 *
 * Legacy pre-0073 returns have no row here (`originUserIdOf` returns `null`): four-eyes falls back
 * to excluding the requester, and the audit carries `origin_user_unknown: true` (RT-196 §9).
 */
import type { DatabaseHandle } from '../db/client.js';

export interface ReturnOriginRepository {
  /** Record the normalized lower-case `users.id` of the operator who journaled `returnId`. */
  recordOrigin(returnId: string, originUserId: string, createdAt: string): void;
  /** The normalized lower-case `users.id` that originated `returnId`, or `null` for legacy rows. */
  originUserIdOf(returnId: string): string | null;
}

interface OriginRow {
  origin_user_id: string;
}

interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
}

export function createReturnOriginRepository(db: DatabaseHandle): ReturnOriginRepository {
  const prepare = (sql: string): Stmt => db.prepare(sql) as Stmt;

  return {
    recordOrigin(returnId, originUserId, createdAt) {
      prepare(
        `INSERT INTO return_journal_origin (return_id, origin_user_id, created_at)
         VALUES (?, ?, ?)`,
      ).run(returnId, originUserId.trim().toLowerCase(), createdAt);
    },

    originUserIdOf(returnId) {
      const row = prepare(
        'SELECT origin_user_id FROM return_journal_origin WHERE return_id = ?',
      ).get(returnId) as OriginRow | undefined;
      return row?.origin_user_id ?? null;
    },
  };
}
