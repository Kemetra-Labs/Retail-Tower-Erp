/**
 * RT-196 S1 — the last cause of an unknown return, read from the local audit.
 *
 * `return_journal` stores no cause (migration 0039, left untouched): each send
 * that leaves a row unknown writes a `sale.return.attempt_unknown` event, and
 * the newest one per return is its last cause. One batched query serves the
 * rows `returns.list` shows. A value outside the closed set reads as null
 * (fail closed): the renderer never shows a cause main did not name.
 */
import { RETURN_UNKNOWN_CAUSES, type ReturnUnknownCause } from '../../shared/returns/types.js';
import type { DatabaseHandle } from '../db/client.js';

export interface ReturnCauseReader {
  /** The newest recorded cause per return id; ids without one are absent. */
  lastCauses(returnIds: readonly string[]): Map<string, ReturnUnknownCause>;
}

interface CauseRow {
  return_id: string;
  cause: string | null;
}

const KNOWN: ReadonlySet<string> = new Set(RETURN_UNKNOWN_CAUSES);

function isCause(value: string | null): value is ReturnUnknownCause {
  return value !== null && KNOWN.has(value);
}

interface Stmt {
  all(...params: unknown[]): unknown[];
}

/**
 * RT-1498 (RT-196 §3.6, OD-196-6) — has this return's sending failed on authentication long enough to
 * hand it to support by itself? True when its newest `attempt_unknown` causes are an unbroken run of
 * pre-replay 401/403 (`AUTH_FAILURE_CAUSES`) of at least `AUTH_FAILURE_ATTEMPTS` attempts, and that run
 * spans at least `spanMs` from its first failure to its newest. Any other cause, a pre-replay 404 (the
 * gate is off, U-2) included, ends the run. The span is read from the persisted audit times, so it
 * survives a restart; an unparseable or backwards time never qualifies (fail closed: no flag).
 */
export interface AuthFailureStreak {
  reached(returnId: string): boolean;
}

/** OD-196-6: three consecutive pre-replay authentication failures. */
export const AUTH_FAILURE_ATTEMPTS = 3;
export const AUTH_FAILURE_CAUSES: ReadonlySet<ReturnUnknownCause> = new Set([
  'pre_replay_401',
  'pre_replay_403',
]);

interface StreakRow {
  cause: string | null;
  created_at: string;
}

export function createAuthFailureStreak(db: DatabaseHandle, spanMs: number): AuthFailureStreak {
  return {
    reached(returnId) {
      const statement = db.prepare(
        `SELECT json_extract(payload, '$.cause') AS cause, created_at
           FROM audit_events
          WHERE action_category = 'sale.return.attempt_unknown'
            AND json_extract(payload, '$.return_id') = ?
          ORDER BY rowid DESC`,
      ) as Stmt;
      // Newest first: the run ends at the first cause that is not an authentication failure.
      const run: StreakRow[] = [];
      for (const row of statement.all(returnId) as StreakRow[]) {
        if (!isCause(row.cause) || !AUTH_FAILURE_CAUSES.has(row.cause)) break;
        run.push(row);
      }
      if (run.length < AUTH_FAILURE_ATTEMPTS) return false;
      const newest = Date.parse(run[0]?.created_at ?? '');
      const first = Date.parse(run.at(-1)?.created_at ?? '');
      if (Number.isNaN(newest) || Number.isNaN(first)) return false;
      return newest - first >= spanMs;
    },
  };
}

export function createReturnCauseReader(db: DatabaseHandle): ReturnCauseReader {
  return {
    lastCauses(returnIds) {
      const causes = new Map<string, ReturnUnknownCause>();
      if (returnIds.length === 0) return causes;
      const marks = returnIds.map(() => '?').join(', ');
      const statement = db.prepare(
        `SELECT json_extract(payload, '$.return_id') AS return_id,
                json_extract(payload, '$.cause') AS cause
           FROM audit_events
          WHERE action_category = 'sale.return.attempt_unknown'
            AND json_extract(payload, '$.return_id') IN (${marks})
          ORDER BY rowid ASC`,
      ) as Stmt;
      // Oldest first: a later row overwrites an earlier one for the same return.
      for (const row of statement.all(...returnIds) as CauseRow[]) {
        if (isCause(row.cause)) causes.set(row.return_id, row.cause);
        else causes.delete(row.return_id);
      }
      return causes;
    },
  };
}
