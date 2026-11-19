/**
 * RT-1312 Phase 3(c) — the `sale_quarantine_upload` store (migration 0065) on the
 * production `DatabaseHandle`.
 *
 * One row per sale the till has tried to upload to the Backend-Core quarantine.
 * It never writes `sales`, `sale_sync_outbox` or `sale_sync_state`: it only reads
 * them to find the stranded sales, and keeps its own mark and retry state.
 *
 * The candidates are the current tenant and branch's stranded sales (decision P2),
 * oldest first:
 *   • dead-lettered with a reason the contract names (`permanent`,
 *     `payload_divergence`, `cashier_claim_refused`), from any of the branch's
 *     pairings: the till's dead-letter count is branch-wide;
 *   • held: unsent (no state row, or pending) and queued under an EARLIER pairing
 *     (a terminal other than the current one), as `readSyncStatus` counts them.
 * Excluded: a sale already uploaded or refused, and a pending one waiting for its
 * backoff. A row that is no longer `pending` is never changed again.
 *
 * Statements are prepared lazily: the table exists only after migration 0065.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { UploadedQuarantineCounts } from '../device-health/heartbeat-facts.js';
import type { QuarantineReceipt } from './quarantine-upload-client.js';
import type {
  QuarantineCandidate,
  QuarantineScope,
  QuarantineUploadStore,
} from './quarantine-upload-drain.js';

/** The scope of a count: the heartbeat reads it with a null terminal while unpaired. */
interface CountScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string | null;
}

export interface SaleQuarantineUploadStore extends QuarantineUploadStore {
  /** The uploaded rows, by what `readSyncStatus` would count them as. */
  countUploaded(scope: CountScope): UploadedQuarantineCounts;
}

type RunStmt = { run(...params: unknown[]): unknown };
type AllStmt = { all(...params: unknown[]): unknown[] };
type GetStmt = { get(...params: unknown[]): unknown };

const DEAD_LETTER_REASONS = "('permanent', 'payload_divergence', 'cashier_claim_refused')";

const NOT_SETTLED = `(q.sale_id IS NULL OR (q.state = 'pending' AND q.next_attempt_at <= ?))`;

const LIST_SQL = `
  SELECT o.sale_id AS sale_id, o.enqueued_at AS enqueued_at, 'dead_letter' AS kind,
         s.last_error_category AS category, s.updated_at AS recorded_at,
         COALESCE(q.attempts, 0) AS attempts
  FROM sale_sync_state s
  JOIN sale_sync_outbox o ON o.sale_id = s.sale_id
  LEFT JOIN sale_quarantine_upload q ON q.sale_id = s.sale_id
  WHERE s.tenant_id = ? AND s.branch_id = ? AND s.sync_status = 'dead_letter'
    AND s.last_error_category IN ${DEAD_LETTER_REASONS}
    AND ${NOT_SETTLED}
  UNION ALL
  SELECT o.sale_id, o.enqueued_at, 'held', NULL, NULL, COALESCE(q.attempts, 0)
  FROM sale_sync_outbox o
  LEFT JOIN sale_sync_state s ON s.sale_id = o.sale_id
  LEFT JOIN sale_quarantine_upload q ON q.sale_id = o.sale_id
  WHERE o.tenant_id = ? AND o.branch_id = ? AND o.terminal_id IS NOT ?
    AND (s.sale_id IS NULL OR s.sync_status = 'pending')
    AND ${NOT_SETTLED}
  ORDER BY enqueued_at, sale_id`;

const UPLOADED_SQL = `
  INSERT INTO sale_quarantine_upload
    (sale_id, tenant_id, branch_id, state, attempts, next_attempt_at, last_status,
     quarantine_ref, quarantine_state, created_at, updated_at, settled_at)
  VALUES (?, ?, ?, 'uploaded', 0, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (sale_id) DO UPDATE SET
    state = 'uploaded', last_status = excluded.last_status,
    quarantine_ref = excluded.quarantine_ref, quarantine_state = excluded.quarantine_state,
    updated_at = excluded.updated_at, settled_at = excluded.settled_at
  WHERE sale_quarantine_upload.state = 'pending'`;

const REFUSED_SQL = `
  INSERT INTO sale_quarantine_upload
    (sale_id, tenant_id, branch_id, state, attempts, next_attempt_at, last_status,
     created_at, updated_at, settled_at)
  VALUES (?, ?, ?, 'refused', 0, ?, ?, ?, ?, ?)
  ON CONFLICT (sale_id) DO UPDATE SET
    state = 'refused', last_status = excluded.last_status,
    updated_at = excluded.updated_at, settled_at = excluded.settled_at
  WHERE sale_quarantine_upload.state = 'pending'`;

const RETRY_SQL = `
  INSERT INTO sale_quarantine_upload
    (sale_id, tenant_id, branch_id, state, attempts, next_attempt_at, last_status,
     created_at, updated_at)
  VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?)
  ON CONFLICT (sale_id) DO UPDATE SET
    attempts = sale_quarantine_upload.attempts + 1,
    next_attempt_at = excluded.next_attempt_at, last_status = excluded.last_status,
    updated_at = excluded.updated_at
  WHERE sale_quarantine_upload.state = 'pending'`;

const COUNT_DEAD_SQL = `
  SELECT COUNT(*) AS n
  FROM sale_quarantine_upload q
  JOIN sale_sync_state s ON s.sale_id = q.sale_id
  WHERE q.state = 'uploaded' AND q.tenant_id = ? AND q.branch_id = ?
    AND s.tenant_id = ? AND s.branch_id = ? AND s.sync_status = 'dead_letter'`;

const COUNT_HELD_SQL = `
  SELECT COUNT(*) AS n
  FROM sale_quarantine_upload q
  JOIN sale_sync_outbox o ON o.sale_id = q.sale_id
  LEFT JOIN sale_sync_state s ON s.sale_id = q.sale_id
  WHERE q.state = 'uploaded' AND q.tenant_id = ? AND q.branch_id = ?
    AND o.terminal_id IS NOT ?
    AND (s.sale_id IS NULL OR s.sync_status = 'pending')`;

interface CandidateRow {
  readonly sale_id: string;
  readonly kind: 'dead_letter' | 'held';
  readonly category: string | null;
  readonly recorded_at: string | null;
  readonly attempts: number;
}

function candidateOf(row: CandidateRow): QuarantineCandidate {
  return {
    saleId: row.sale_id,
    attempts: row.attempts,
    source:
      row.kind === 'held'
        ? { kind: 'held' }
        : {
            kind: 'dead_letter',
            category: row.category ?? '',
            tillRecordedAt: row.recorded_at ?? '',
          },
  };
}

export function bindQuarantineUploadStore(handle: DatabaseHandle): SaleQuarantineUploadStore {
  let listStmt: AllStmt | null = null;
  let uploadedStmt: RunStmt | null = null;
  let refusedStmt: RunStmt | null = null;
  let retryStmt: RunStmt | null = null;
  let countDeadStmt: GetStmt | null = null;
  let countHeldStmt: GetStmt | null = null;

  const count = (stmt: GetStmt, ...params: unknown[]): number =>
    (stmt.get(...params) as { n: number } | undefined)?.n ?? 0;

  return {
    listCandidates(scope: QuarantineScope, nowIso: string): QuarantineCandidate[] {
      listStmt ??= handle.prepare(LIST_SQL) as AllStmt;
      const rows = listStmt.all(
        scope.tenantId,
        scope.branchId,
        nowIso,
        scope.tenantId,
        scope.branchId,
        scope.terminalId,
        nowIso,
      ) as CandidateRow[];
      return rows.map(candidateOf);
    },

    markUploaded(
      saleId: string,
      scope: QuarantineScope,
      status: number,
      receipt: QuarantineReceipt | null,
      atIso: string,
    ): void {
      uploadedStmt ??= handle.prepare(UPLOADED_SQL) as RunStmt;
      uploadedStmt.run(
        saleId,
        scope.tenantId,
        scope.branchId,
        atIso,
        status,
        receipt?.quarantineRef ?? null,
        receipt?.state ?? null,
        atIso,
        atIso,
        atIso,
      );
    },

    markRefused(saleId: string, scope: QuarantineScope, status: number, atIso: string): void {
      refusedStmt ??= handle.prepare(REFUSED_SQL) as RunStmt;
      refusedStmt.run(saleId, scope.tenantId, scope.branchId, atIso, status, atIso, atIso, atIso);
    },

    markRetry(
      saleId: string,
      scope: QuarantineScope,
      status: number | null,
      nextAttemptAtIso: string,
      atIso: string,
    ): void {
      retryStmt ??= handle.prepare(RETRY_SQL) as RunStmt;
      retryStmt.run(saleId, scope.tenantId, scope.branchId, nextAttemptAtIso, status, atIso, atIso);
    },

    countUploaded(scope: CountScope): UploadedQuarantineCounts {
      countDeadStmt ??= handle.prepare(COUNT_DEAD_SQL) as GetStmt;
      countHeldStmt ??= handle.prepare(COUNT_HELD_SQL) as GetStmt;
      return {
        deadLetter: count(
          countDeadStmt,
          scope.tenantId,
          scope.branchId,
          scope.tenantId,
          scope.branchId,
        ),
        heldPreviousPairing: count(countHeldStmt, scope.tenantId, scope.branchId, scope.terminalId),
      };
    },
  };
}
