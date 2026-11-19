/**
 * RT-1490 — the `unknown_item_captures` store (migration 0064) on the
 * production `DatabaseHandle`.
 *
 * One row per barcode per store per business day (the client cap, enforced by
 * the table's UNIQUE constraint): `enqueue` is an INSERT OR IGNORE, so a rescan
 * the same day writes nothing and keeps the day row's key. A row is `pending`
 * until Backend-Core answers 2xx (`sent`) or a final 4xx (`refused`); a
 * retryable answer bumps `attempts` and moves `next_attempt_at`.
 *
 * Scope (as the audit and sale outboxes, RT-221): only the current pairing's
 * rows are listed. An earlier pairing's rows are held, never sent under the
 * new identity.
 *
 * Statements are prepared lazily: the table exists only after migration 0064.
 */
import type { DatabaseHandle } from '../db/client.js';
import { normalize } from '../catalogue/normalize.js';

export interface CaptureScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
}

interface EnqueueCaptureInput {
  /** UUIDv7 minted by the caller; also the `Idempotency-Key`. */
  readonly captureId: string;
  readonly scope: CaptureScope;
  readonly barcode: string;
  /** The store business day (YYYY-MM-DD) of the scan. */
  readonly day: string;
  /** ISO instant of the scan; the row is due at once. */
  readonly at: string;
}

interface PendingCapture {
  readonly capture_id: string;
  readonly barcode: string;
  readonly attempts: number;
}

export interface UnknownItemCaptureStore {
  /** `queued` for a new row; `capped` when the day already has one for this barcode. */
  enqueue(input: EnqueueCaptureInput): 'queued' | 'capped';
  /** The scope's pending rows due at `nowIso`, oldest first. */
  listDue(scope: CaptureScope, nowIso: string, limit: number): PendingCapture[];
  markSent(captureId: string, status: number, at: string): void;
  markRefused(captureId: string, status: number, at: string): void;
  /** One more attempt; next try at `nextAttemptAt`. `status` is null for no answer. */
  markRetry(captureId: string, status: number | null, nextAttemptAt: string): void;
  /**
   * Whether the tenant's local catalogue has this barcode on any product,
   * active or not: an inactive product's code is not an unknown item.
   */
  isKnownBarcode(tenantId: string, rawBarcode: string): boolean;
}

type RunStmt = { run(...params: unknown[]): { changes: number } };
type AllStmt = { all(...params: unknown[]): unknown[] };
type GetStmt = { get(...params: unknown[]): unknown };

const INSERT_SQL = `
  INSERT OR IGNORE INTO unknown_item_captures
    (capture_id, tenant_id, branch_id, terminal_id, barcode, capture_day, state,
     attempts, next_attempt_at, enqueued_at)
  VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`;

const LIST_DUE_SQL = `
  SELECT capture_id, barcode, attempts
  FROM unknown_item_captures
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
    AND state = 'pending' AND next_attempt_at <= ?
  ORDER BY enqueued_at, capture_id
  LIMIT ?`;

const SETTLE_SQL = `
  UPDATE unknown_item_captures
  SET state = ?, last_status = ?, settled_at = ?
  WHERE capture_id = ? AND state = 'pending'`;

const RETRY_SQL = `
  UPDATE unknown_item_captures
  SET attempts = attempts + 1, last_status = ?, next_attempt_at = ?
  WHERE capture_id = ? AND state = 'pending'`;

const KNOWN_SQL = `
  SELECT 1 AS known FROM product_barcodes
  WHERE tenant_id = ? AND barcode_norm = ?
  LIMIT 1`;

export function bindUnknownItemCaptureStore(handle: DatabaseHandle): UnknownItemCaptureStore {
  let insertStmt: RunStmt | null = null;
  let listStmt: AllStmt | null = null;
  let settleStmt: RunStmt | null = null;
  let retryStmt: RunStmt | null = null;
  let knownStmt: GetStmt | null = null;

  const settle = (state: 'sent' | 'refused', captureId: string, status: number, at: string) => {
    settleStmt ??= handle.prepare(SETTLE_SQL) as RunStmt;
    settleStmt.run(state, status, at, captureId);
  };

  return {
    enqueue(input) {
      insertStmt ??= handle.prepare(INSERT_SQL) as RunStmt;
      const { scope } = input;
      const result = insertStmt.run(
        input.captureId,
        scope.tenantId,
        scope.branchId,
        scope.terminalId,
        input.barcode,
        input.day,
        input.at,
        input.at,
      );
      return result.changes > 0 ? 'queued' : 'capped';
    },

    listDue(scope, nowIso, limit) {
      listStmt ??= handle.prepare(LIST_DUE_SQL) as AllStmt;
      const rows = listStmt.all(
        scope.tenantId,
        scope.branchId,
        scope.terminalId,
        nowIso,
        limit,
      ) as PendingCapture[];
      return rows.map((r) => ({
        capture_id: r.capture_id,
        barcode: r.barcode,
        attempts: r.attempts,
      }));
    },

    markSent(captureId, status, at) {
      settle('sent', captureId, status, at);
    },

    markRefused(captureId, status, at) {
      settle('refused', captureId, status, at);
    },

    markRetry(captureId, status, nextAttemptAt) {
      retryStmt ??= handle.prepare(RETRY_SQL) as RunStmt;
      retryStmt.run(status, nextAttemptAt, captureId);
    },

    isKnownBarcode(tenantId, rawBarcode) {
      knownStmt ??= handle.prepare(KNOWN_SQL) as GetStmt;
      return knownStmt.get(tenantId, normalize(rawBarcode)) !== undefined;
    },
  };
}
