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
 * hand it to support by itself?
 *
 * The run: the return's `attempt_unknown` audits, newest first, whose `attempt_no` are ADJACENT and end
 * at the journal's current attempt number, each with a pre-replay 401/403 cause (`AUTH_FAILURE_CAUSES`).
 * A gap (an attempt whose audit is missing: a shutdown, a failed audit write), an invalid number, or any
 * other cause (a pre-replay 404, the gate off, U-2, included) ends it.
 *
 * The span: ELAPSED time, never a wall-clock difference. Each attempt is marked in memory on the
 * monotonic clock as it is sent (`markAttempt`); the run counts only attempts this process marked, and
 * the flag needs `AUTH_FAILURE_ATTEMPTS` of them spanning at least `spanMs` of monotonic time. So a
 * stepped wall clock proves nothing, and after a restart the flag waits for new failures (fail closed:
 * an unproven span never raises it; the cost is a later flag, never a wrong one).
 */
export interface AuthFailureStreak {
  /** Attempt `attemptNo` of `returnId` is being sent now. */
  markAttempt(returnId: string, attemptNo: number): void;
  /** Whether the run ending at the journal's `currentAttemptNo` reached the flag. */
  reached(returnId: string, currentAttemptNo: number): boolean;
}

/** OD-196-6: three consecutive pre-replay authentication failures. */
const AUTH_FAILURE_ATTEMPTS = 3;
export const AUTH_FAILURE_CAUSES: ReadonlySet<ReturnUnknownCause> = new Set([
  'pre_replay_401',
  'pre_replay_403',
]);

/**
 * The newest attempts read per check. Newest-first by rowid, so SQLite stops once it has this many: the
 * check never walks a return's whole history (it runs inside the unknown transition's write). A run
 * longer than this is judged on its newest part only, which can only understate the span (fail closed);
 * with resends minutes apart it is far longer than the quiet period needs.
 */
const STREAK_READ_LIMIT = 20;

/** The most returns whose attempt marks are kept (the oldest is forgotten first). */
const MAX_MARKED_RETURNS = 1000;

interface StreakRow {
  cause: string | null;
  attempt_no: unknown;
}

function isAuthFailure(cause: string | null): boolean {
  return isCause(cause) && AUTH_FAILURE_CAUSES.has(cause);
}

export function createAuthFailureStreak(
  db: DatabaseHandle,
  spanMs: number,
  mono: () => number = () => performance.now(),
): AuthFailureStreak {
  /** returnId → attempt number → the monotonic instant it was sent (this process only). */
  const marks = new Map<string, Map<number, number>>();

  /** The monotonic instants of the run, newest first (attempts this process did not mark end it). */
  function runOf(returnId: string, currentAttemptNo: number): number[] {
    const statement = db.prepare(
      `SELECT json_extract(payload, '$.cause') AS cause,
              json_extract(payload, '$.attempt_no') AS attempt_no
         FROM audit_events
        WHERE action_category = 'sale.return.attempt_unknown'
          AND json_extract(payload, '$.return_id') = ?
        ORDER BY rowid DESC
        LIMIT ${String(STREAK_READ_LIMIT)}`,
    ) as Stmt;
    const sent = marks.get(returnId);
    const run: number[] = [];
    let expected = currentAttemptNo;
    for (const row of statement.all(returnId) as StreakRow[]) {
      if (row.attempt_no !== expected || !isAuthFailure(row.cause)) break;
      const at = sent?.get(expected);
      if (at === undefined) break;
      run.push(at);
      expected -= 1;
    }
    return run;
  }

  return {
    markAttempt(returnId, attemptNo) {
      const at = mono();
      if (!Number.isSafeInteger(attemptNo) || !Number.isFinite(at)) return;
      const sent = marks.get(returnId) ?? new Map<number, number>();
      marks.delete(returnId); // re-insert: the newest return is the last to be forgotten
      sent.set(attemptNo, at);
      for (const n of sent.keys()) {
        if (sent.size <= STREAK_READ_LIMIT) break;
        sent.delete(n);
      }
      marks.set(returnId, sent);
      const oldest = marks.size > MAX_MARKED_RETURNS ? marks.keys().next() : null;
      if (oldest !== null && oldest.done !== true) marks.delete(oldest.value);
    },

    reached(returnId, currentAttemptNo) {
      const run = runOf(returnId, currentAttemptNo);
      if (run.length < AUTH_FAILURE_ATTEMPTS) return false;
      return (run[0] ?? 0) - (run.at(-1) ?? 0) >= spanMs;
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
