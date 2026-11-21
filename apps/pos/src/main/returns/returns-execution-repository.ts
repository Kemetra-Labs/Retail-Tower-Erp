/**
 * RT-1543 — the refund-execution outbox repository (migration 0068).
 *
 * One row per allocation of a paid-out return, written in the SAME transaction as the payout's
 * completion (`enqueue`), carrying the exact request bytes. Every state change is a guarded
 * UPDATE that only moves a row out of `pending` / `unknown`, so a second confirmation (a resolver
 * racing the post-payout send, a replayed answer) changes nothing and reports `false`; the schema
 * triggers are the backstop (final rows, immutable body, paid-out parents only).
 *
 * `DatabaseHandle` is injected so tests run on sql.js.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { ReturnScope } from './returns-repository.js';

type ExecutionState = 'pending' | 'unknown' | 'recorded' | 'refused';

/** The closed codes a refused execution is recorded with (the contract's final refusals). */
export type ExecutionRefusal = 'not_found' | 'conflict' | 'exceeds_allocation';

export interface NewExecution {
  readonly executionId: string;
  readonly returnId: string;
  readonly serverSaleRef: string;
  readonly returnRef: string;
  readonly allocationRef: string;
  readonly externalId: string;
  readonly requestBodyJson: string;
  readonly now: string;
}

export interface ExecutionEntry extends Omit<NewExecution, 'now'> {
  readonly state: ExecutionState;
  readonly refusalReason: ExecutionRefusal | null;
  readonly attemptCount: number;
  /** When the last send was attempted (the resolver's backoff anchor); null if never. */
  readonly lastAttemptAt: string | null;
  readonly createdAt: string;
  readonly recordedAt: string | null;
}

interface ExecutionStamp {
  readonly executionId: string;
  readonly now: string;
}

interface RefuseExecutionInput extends ExecutionStamp {
  readonly reason: ExecutionRefusal;
}

export interface ReturnExecutionsRepository {
  /** Insert the rows of one paid-out return (call inside the payout's transaction). */
  enqueue(rows: readonly NewExecution[]): void;
  read(executionId: string): ExecutionEntry | null;
  /** The executions of one return, oldest first. */
  listForReturn(returnId: string): ExecutionEntry[];
  /** This terminal's `pending` / `unknown` executions, oldest first (resolver order). */
  listUnrecorded(scope: ReturnScope): ExecutionEntry[];
  recordAttempt(stamp: ExecutionStamp): void;
  /** pending/unknown -> unknown. False when the row was already final. */
  markUnknown(stamp: ExecutionStamp): boolean;
  /** pending/unknown -> recorded. False when already final. */
  markRecorded(stamp: ExecutionStamp): boolean;
  /** pending/unknown -> refused. False when already final. */
  markRefused(input: RefuseExecutionInput): boolean;
}

/** The slice of a prepared statement this repository uses. */
type Stmt = {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => { changes: number };
};

interface Row {
  execution_id: string;
  return_id: string;
  server_sale_ref: string;
  return_ref: string;
  allocation_ref: string;
  external_id: string;
  request_body_json: string;
  state: ExecutionState;
  refusal_reason: ExecutionRefusal | null;
  attempt_count: number;
  last_attempt_at: string | null;
  created_at: string;
  recorded_at: string | null;
}

const OPEN = `state IN ('pending', 'unknown')`;

function toEntry(row: Row): ExecutionEntry {
  return {
    executionId: row.execution_id,
    returnId: row.return_id,
    serverSaleRef: row.server_sale_ref,
    returnRef: row.return_ref,
    allocationRef: row.allocation_ref,
    externalId: row.external_id,
    requestBodyJson: row.request_body_json,
    state: row.state,
    refusalReason: row.refusal_reason,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    recordedAt: row.recorded_at,
  };
}

class SqlReturnExecutionsRepository implements ReturnExecutionsRepository {
  constructor(private readonly db: DatabaseHandle) {}

  private prepare(sql: string): Stmt {
    return this.db.prepare(sql) as Stmt;
  }

  private update(sql: string, params: unknown[]): boolean {
    return this.prepare(sql).run(...params).changes > 0;
  }

  enqueue(rows: readonly NewExecution[]): void {
    const insert = this.prepare(
      `INSERT INTO return_refund_executions
         (execution_id, return_id, server_sale_ref, return_ref, allocation_ref, external_id,
          request_body_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        r.executionId,
        r.returnId,
        r.serverSaleRef,
        r.returnRef,
        r.allocationRef,
        r.externalId,
        r.requestBodyJson,
        r.now,
        r.now,
      );
    }
  }

  read(executionId: string): ExecutionEntry | null {
    const row = this.prepare('SELECT * FROM return_refund_executions WHERE execution_id = ?').get(
      executionId,
    );
    return row === undefined ? null : toEntry(row as Row);
  }

  listForReturn(returnId: string): ExecutionEntry[] {
    const sql = `SELECT * FROM return_refund_executions WHERE return_id = ?
                 ORDER BY created_at ASC, execution_id ASC`;
    return (this.prepare(sql).all(returnId) as Row[]).map(toEntry);
  }

  listUnrecorded(scope: ReturnScope): ExecutionEntry[] {
    const sql = `SELECT e.* FROM return_refund_executions e
                 JOIN return_journal j ON j.return_id = e.return_id
                 WHERE j.tenant_id = ? AND j.branch_id = ? AND j.terminal_id = ? AND e.${OPEN}
                 ORDER BY e.created_at ASC, e.execution_id ASC`;
    const rows = this.prepare(sql).all(scope.tenantId, scope.branchId, scope.terminalId);
    return (rows as Row[]).map(toEntry);
  }

  recordAttempt({ executionId, now }: ExecutionStamp): void {
    this.update(
      `UPDATE return_refund_executions SET attempt_count = attempt_count + 1,
         last_attempt_at = ?, updated_at = ? WHERE execution_id = ? AND ${OPEN}`,
      [now, now, executionId],
    );
  }

  markUnknown({ executionId, now }: ExecutionStamp): boolean {
    return this.update(
      `UPDATE return_refund_executions SET state = 'unknown', updated_at = ?
       WHERE execution_id = ? AND ${OPEN}`,
      [now, executionId],
    );
  }

  markRecorded({ executionId, now }: ExecutionStamp): boolean {
    return this.update(
      `UPDATE return_refund_executions SET state = 'recorded', recorded_at = ?,
         updated_at = ? WHERE execution_id = ? AND ${OPEN}`,
      [now, now, executionId],
    );
  }

  markRefused({ executionId, reason, now }: RefuseExecutionInput): boolean {
    return this.update(
      `UPDATE return_refund_executions SET state = 'refused', refusal_reason = ?,
         updated_at = ? WHERE execution_id = ? AND ${OPEN}`,
      [reason, now, executionId],
    );
  }
}

export function createReturnExecutionsRepository(db: DatabaseHandle): ReturnExecutionsRepository {
  return new SqlReturnExecutionsRepository(db);
}
