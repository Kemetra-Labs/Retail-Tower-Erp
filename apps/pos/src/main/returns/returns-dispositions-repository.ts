/**
 * RT-1498 S4 — the return dispositions repository (migration 0070).
 *
 * One append-only row per decision about a permanently-unknown return (RT-196 design §3.4):
 * a terminal close (`not_recorded_closed`) or a restrict-only `needs_support` flag. The table's
 * CHECKs and triggers are the authority on what may be written (the closed combinations, the
 * spent approval bound to this return AND this disposition, no write after a close); this class
 * only reads and appends, so a bug here cannot write a row the database would refuse.
 *
 * `retry_hold` is part of the table (its CHECK is in 0070 so the append-only table never needs a
 * rebuild) but has no writer yet: that is the owed status read. It is therefore not a state.
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

/** What a return's dispositions add up to: `closed` is terminal and wins over `needs_support`. */
type DispositionState = 'closed' | 'needs_support';

export interface ReturnDispositionsRepository {
  /** Append one disposition. Throws what the 0070 CHECKs and triggers refuse. */
  insert(disposition: NewDisposition): void;
  /** Every disposition of a return, oldest first. */
  listFor(returnId: string): NewDisposition[];
  /** The state of one return, or null when it has none. */
  stateOf(returnId: string): DispositionState | null;
  /** The state of each listed return that has one (a return with none is absent). */
  statesOf(returnIds: readonly string[]): Map<string, DispositionState>;
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

/** `closed` beats `needs_support`: a close stays the state whatever was written before it. */
function stronger(current: DispositionState | undefined, kind: DispositionKind): DispositionState {
  return kind === 'not_recorded_closed' || current === 'closed' ? 'closed' : 'needs_support';
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
        WHERE return_id IN (${marks}) AND kind IN ('not_recorded_closed', 'needs_support')`,
    ).all(...returnIds) as StateRow[];
    // The query lists only the two kinds that are a state (a `retry_hold` is not one yet).
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
  };
}
