/**
 * RT-1498 S4 — the return dispositions repository (migration 0070).
 *
 * One append-only row per decision about a permanently-unknown return (RT-196 design §3.4):
 * a terminal close (`not_recorded_closed`) or a restrict-only `needs_support` flag. The table's
 * CHECKs and triggers are the authority on what may be written (the closed combinations, the
 * spent approval bound to this return AND this disposition, no write after a close); this class
 * only reads and appends, so a bug here cannot write a row the database would refuse.
 *
 * `retry_hold` (RT-1498 close slice) is the restrict-only flag a status read that answered "not
 * recorded" writes, so the background and bar resends stop and the quiet period can elapse. It is not
 * a state: it never frees the sale. It is effective only while it is newer than the return's last
 * attempt (`hasEffectiveHold`), so only an explicit per-row resend, which moves the last attempt, voids it.
 *
 * RT-1553 (migration 0071): after a close, one `needs_support` from a status read that saw the return
 * recorded may follow it (the late commit). The rows are ordered by rowid (append-only: a later row has
 * a larger rowid), and a close followed by that row is the `late_commit` state: a SUPPORT state that
 * blocks the sale again, while the return stays closed for every flow decision (never sent, never
 * re-closed, never confirmed, so never paid out).
 */
import type { DatabaseHandle } from '../db/client.js';

/** The closed sets of migration 0070's CHECKs (the table is the authority on their combinations). */
type DispositionKind = 'not_recorded_closed' | 'needs_support' | 'retry_hold';
type DispositionSource = 'provenance_read' | 'send_response' | 'auth_failure' | 'operator';
type DispositionReason = 'not_recorded' | 'mismatch' | 'auth_failure' | 'operator';

export interface NewDisposition {
  readonly dispositionId: string;
  readonly returnId: string;
  readonly kind: DispositionKind;
  readonly verdictSource: DispositionSource;
  readonly reason: DispositionReason;
  /** When the status read answered; set exactly for a `provenance_read` source. */
  readonly readVerdictAt: string | null;
  /** The spent `return.resolve_unknown` approval; null only for the automatic kinds. */
  readonly approvalId: string | null;
  /** The operator session that wrote it; null for the automatic raises. */
  readonly actorOperatorId: string | null;
  readonly createdAt: string;
}

/**
 * What a return's dispositions add up to: `closed` is terminal and wins over an earlier `needs_support`;
 * `late_commit` (RT-1553) is a close followed by a `needs_support`: closed for the flow, support for the
 * sale (it blocks it again).
 */
type DispositionState = 'closed' | 'needs_support' | 'late_commit';

/** RT-1553: true when the return was closed (with or without a later late-commit raise). */
export function isClosedState(state: DispositionState | null | undefined): boolean {
  return state === 'closed' || state === 'late_commit';
}

/**
 * RT-1553: SQL that is true when the journal row aliased `row` was closed and NO late-commit
 * `needs_support` followed the close, i.e. the close still frees the sale. A late commit (migration
 * 0071) makes it false again, so every reader that frees a sale on a close re-blocks it.
 */
export function releasedByCloseSql(row: string): string {
  return `EXISTS (
    SELECT 1 FROM return_journal_dispositions c
     WHERE c.return_id = ${row}.return_id AND c.kind = 'not_recorded_closed'
       AND NOT EXISTS (
         SELECT 1 FROM return_journal_dispositions s
          WHERE s.return_id = c.return_id AND s.kind = 'needs_support' AND s.rowid > c.rowid))`;
}

export interface ReturnDispositionsRepository {
  /** Append one disposition. Throws what the 0070 CHECKs and triggers refuse. */
  insert(disposition: NewDisposition): void;
  /** Every disposition of a return, oldest first. */
  listFor(returnId: string): NewDisposition[];
  /** The state of one return, or null when it has none. */
  stateOf(returnId: string): DispositionState | null;
  /** The state of each listed return that has one (a return with none is absent). */
  statesOf(returnIds: readonly string[]): Map<string, DispositionState>;
  /**
   * RT-1498: is a `retry_hold` of this return newer than its last attempt? With no recorded attempt
   * (`null`) any hold counts (it only restricts, so the unreadable case fails safe).
   */
  hasEffectiveHold(returnId: string, lastAttemptAt: string | null): boolean;
}

interface Stmt {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
}

interface Row {
  disposition_id: string;
  return_id: string;
  kind: DispositionKind;
  verdict_source: DispositionSource;
  reason: DispositionReason;
  read_verdict_at: string | null;
  approval_id: string | null;
  actor_operator_id: string | null;
  created_at: string;
}

interface StateRow {
  return_id: string;
  kind: DispositionKind;
}

function toRow(row: Row): NewDisposition {
  return {
    dispositionId: row.disposition_id,
    returnId: row.return_id,
    kind: row.kind,
    verdictSource: row.verdict_source,
    reason: row.reason,
    readVerdictAt: row.read_verdict_at,
    approvalId: row.approval_id,
    actorOperatorId: row.actor_operator_id,
    createdAt: row.created_at,
  };
}

/**
 * Fold one more row (in rowid order) into a return's state: a close wins over what came before it, and
 * a `needs_support` after a close makes it a late commit (RT-1553).
 */
function stronger(current: DispositionState | undefined, kind: DispositionKind): DispositionState {
  if (kind === 'not_recorded_closed') return 'closed';
  if (current === 'closed' || current === 'late_commit') return 'late_commit';
  return 'needs_support';
}

export function createReturnDispositionsRepository(
  db: DatabaseHandle,
): ReturnDispositionsRepository {
  const prepare = (sql: string): Stmt => db.prepare(sql) as Stmt;

  function statesOf(returnIds: readonly string[]): Map<string, DispositionState> {
    const states = new Map<string, DispositionState>();
    if (returnIds.length === 0) return states;
    const marks = returnIds.map(() => '?').join(', ');
    const rows = prepare(
      `SELECT return_id, kind FROM return_journal_dispositions
        WHERE return_id IN (${marks}) AND kind IN ('not_recorded_closed', 'needs_support')
        ORDER BY rowid ASC`,
    ).all(...returnIds) as StateRow[];
    // The query lists only the two kinds that are a state (a `retry_hold` is a flag, not one), in the
    // order they were written (RT-1553: a needs_support after the close is the late commit).
    for (const row of rows)
      states.set(row.return_id, stronger(states.get(row.return_id), row.kind));
    return states;
  }

  return {
    insert(d) {
      prepare(
        `INSERT INTO return_journal_dispositions
           (disposition_id, return_id, kind, verdict_source, reason, read_verdict_at,
            approval_id, actor_operator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        d.dispositionId,
        d.returnId,
        d.kind,
        d.verdictSource,
        d.reason,
        d.readVerdictAt,
        d.approvalId,
        d.actorOperatorId,
        d.createdAt,
      );
    },

    listFor(returnId) {
      const rows = prepare(
        `SELECT disposition_id, return_id, kind, verdict_source, reason, read_verdict_at,
                approval_id, actor_operator_id, created_at
           FROM return_journal_dispositions WHERE return_id = ? ORDER BY rowid ASC`,
      ).all(returnId) as Row[];
      return rows.map(toRow);
    },

    stateOf: (returnId) => statesOf([returnId]).get(returnId) ?? null,
    statesOf,

    hasEffectiveHold(returnId, lastAttemptAt) {
      const rows = prepare(
        `SELECT 1 FROM return_journal_dispositions
          WHERE return_id = ? AND kind = 'retry_hold' AND (? IS NULL OR created_at > ?) LIMIT 1`,
      ).all(returnId, lastAttemptAt, lastAttemptAt);
      return rows.length > 0;
    },
  };
}
