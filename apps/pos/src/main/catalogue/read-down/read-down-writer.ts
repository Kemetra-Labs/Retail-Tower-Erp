/**
 * 010-pos-catalog-read-down-consumption T024/T027/T032/T035 — `read-down-writer`.
 *
 * The OFFLINE correctness core of the read-down. Given a fetched snapshot (a list
 * of backend `SellableCatalogRow`s) plus the injected device-principal scope
 * (`tenantId`/`branchId`), it:
 *
 *   1. clears staging at the START of the run (so a prior failed run's rows can
 *      never leak into this promote — data-model invariant 2);
 *   2. maps + validates each row (mapping rejections and validation rejections
 *      are counted UNIFORMLY — FR-9 skip-and-count);
 *   3. applies the abort-threshold: if the rejected fraction is implausibly high
 *      (suggesting a source-format break, not one bad row) the run FAILS with no
 *      promote and the prior catalogue is preserved (FR-7 / SC-5);
 *   4. otherwise stages the validated rows, computing the fold columns with 009's
 *      `normalize()` per the R1 composition rule (so the stored fold matches
 *      009's query fold — fold-parity, SC-9);
 *   5. promotes in ONE better-sqlite3 transaction: DELETE the tenant's live rows +
 *      INSERT … SELECT from staging + write `last_success_at` INSIDE the same tx
 *      (atomic — a throw rolls back the whole thing, SC-4 / FR-6; freshness can
 *      never claim a promote that didn't commit, SC-10).
 *
 * Tenant-scoped throughout (P17): every staging/promote statement filters the
 * injected tenant; rows are STAMPED with `tenantId`/`branchId` (the source rows
 * carry no tenant of their own — scope comes from the device principal, R8/AD-8).
 * A run with no resolvable store scope (empty `branchId`) is rejected before any
 * write (the §A2 NOT-NULL staging contract).
 *
 * Idempotent full-replace: re-running with the same snapshot converges to
 * identical state (DELETE+INSERT, no dedupe) — SC-3. Duplicate barcodes are
 * preserved faithfully (FR-4 ambiguity block is the reader's job, not the
 * writer's — it must NOT collapse the conflict).
 *
 * DI'd `DatabaseHandle` + `CatalogueSyncStateRepo` so tests run on sql.js without
 * the native better-sqlite3 binding.
 */

import type { DatabaseHandle } from '../../db/client.js';
import type { CatalogueSyncStateRepo, CatalogueSyncOutcome } from '../catalogue-sync-state-repo.js';
import { mapSellableRow, type MappedRecord, type SellableCatalogRow } from './map-sellable-row.js';
import { validateRecord } from './validate-record.js';
import { createDeltaApplier, type ApplyDeltasInput } from './read-down-delta-writer.js';
import { BARCODE_COLUMNS, PRODUCT_COLUMNS, prepareRecordInsert } from './record-insert.js';

/**
 * FR-9 / R-RISK-4 abort-threshold (the rejected FRACTION above which a run is
 * treated as a failed read-down rather than a skip-and-log).
 *
 * TODO(owner): abort-threshold value pending owner decision (R-RISK-4, S2 tuning
 * item). This 0.5 placeholder is CONSERVATIVE and NOT final — a run is failed
 * only when MORE THAN HALF the records are rejected (a strong signal of a
 * source-format break, not a handful of bad rows). The mechanism is implemented
 * and tested; the exact value is a deliberate placeholder. Do NOT treat this as
 * a ratified value.
 */
export const ABORT_THRESHOLD_REJECTED_FRACTION = 0.5;

/**
 * `delta-rejected` (RT-1487): a delta op failed mapping/validation, so the whole
 * delta apply was refused and the driver re-baselines with a full snapshot.
 */
export type ReadDownFailureCategory =
  | 'no-store-scope'
  | 'threshold-exceeded'
  | 'db-error'
  | 'delta-rejected';

export interface ReadDownRunInput {
  /** Injected device-principal tenant scope (P17). */
  tenantId: string;
  /** Injected device-principal store/branch scope (NOT NULL in staging, §A2 D6). */
  branchId: string;
  /** Opaque backend snapshot/version id (provenance). */
  sourceSnapshotId: string | null;
  /** ISO-8601 UTC timestamp for this run (injected for determinism). */
  now: string;
  /** The fetched snapshot rows. */
  rows: SellableCatalogRow[];
}

export interface ReadDownRunResult {
  outcome: CatalogueSyncOutcome | 'failed';
  productsWritten: number;
  recordsRejected: number;
  failureCategory: ReadDownFailureCategory | null;
}

export interface CreateReadDownWriterDeps {
  db: DatabaseHandle;
  syncStateRepo: CatalogueSyncStateRepo;
}

/** Inputs for recording a transport-failed fetch (the driver's responsibility). */
export interface RecordFetchFailureInput {
  tenantId: string;
  branchId: string;
  /** ISO-8601 UTC timestamp of the failed attempt. */
  now: string;
}

export type { ApplyDeltasInput } from './read-down-delta-writer.js';

export interface ReadDownWriter {
  run(input: ReadDownRunInput): ReadDownRunResult;
  /**
   * RT-1487 — apply ordered delta ops onto the live read model in ONE
   * transaction, with the advanced cursor and freshness written inside it. Any
   * rejected op refuses the whole apply (`delta-rejected`, nothing written).
   */
  applyDeltas(input: ApplyDeltasInput): ReadDownRunResult;
  /**
   * RT-1487 — the cursor of the last successful snapshot/delta for this store,
   * or `null` when there is none (first sync, or the stored row is another
   * store's), in which case the driver takes a full snapshot.
   */
  currentCursor(tenantId: string, branchId: string): string | null;
  /**
   * Record a FAILED fetch attempt (transport failure before any write). The
   * driver calls this when the client returns `no_connection` / `failed`: the
   * writer never runs, so the driver still needs the freshness clock to show a
   * failed attempt while `last_success_at` stays put (SC-10). Delegates to the
   * same diagnostics write `run()` uses for writer-side failures.
   */
  recordFetchFailure(input: RecordFetchFailureInput): void;
}

interface PrepareRun {
  run(...params: unknown[]): unknown;
}

export function createReadDownWriter(deps: CreateReadDownWriterDeps): ReadDownWriter {
  const { db, syncStateRepo } = deps;

  function clearStaging(tenantId: string): void {
    (db.prepare('DELETE FROM products_staging WHERE tenant_id = ?') as PrepareRun).run(tenantId);
    (db.prepare('DELETE FROM product_barcodes_staging WHERE tenant_id = ?') as PrepareRun).run(
      tenantId,
    );
  }

  /**
   * Stage the full validated set in ONE transaction (#411 perf fix). The prior
   * per-row autocommit path issued ~2 INSERTs/row in autocommit mode (~100k
   * separate WAL commits on a 50k snapshot), which blocked the single shared
   * main-thread connection for ~20 s — every barcode scan / lookup froze behind
   * it (T054 §A5, perf-bringup.md §6). That was measured at better-sqlite3's
   * default synchronous=NORMAL; since RT-1324 the connection runs FULL (a WAL
   * fsync per commit), so per-row autocommit would now cost even more. Wrapping
   * the loop in one `db.transaction()` collapses those to a single commit
   * (~20 s → ~1 s).
   *
   * Live tables are untouched here (staging only), so this does NOT affect FR-7
   * (the prior-catalogue-intact guarantee is a property of the promote tx — the
   * snapshot path's only live-table writer; the RT-1487 delta apply has its own
   * single transaction). A throw mid-loop rolls back the whole staging tx;
   * `run()`'s outer catch still maps it to `failed` and `promote()` never runs, so
   * the observable outcome is unchanged (single-flight, single thread — no consumer
   * ever reads a half-populated staging). The two prepared statements are now
   * prepared ONCE (not per row) — a side win.
   */
  function stageAll(tenantId: string, branchId: string, recs: MappedRecord[]): void {
    const insert = prepareRecordInsert(db, 'products_staging', 'product_barcodes_staging');
    const stageTx = db.transaction(() => {
      for (const rec of recs) {
        insert(tenantId, branchId, rec);
      }
    });
    stageTx();
  }

  function promote(
    input: ReadDownRunInput,
    outcome: 'succeeded' | 'skipped_with_rejections',
  ): void {
    const { tenantId, branchId, sourceSnapshotId, now } = input;
    // Single transaction: DELETE live (tenant-scoped) + INSERT…SELECT from
    // staging + write freshness — all atomic. A throw rolls back the whole thing.
    const tx = db.transaction(() => {
      (db.prepare('DELETE FROM products WHERE tenant_id = ?') as PrepareRun).run(tenantId);
      (db.prepare('DELETE FROM product_barcodes WHERE tenant_id = ?') as PrepareRun).run(tenantId);
      (
        db.prepare(`
          INSERT INTO products (${PRODUCT_COLUMNS.join(', ')})
          SELECT ${PRODUCT_COLUMNS.join(', ')} FROM products_staging WHERE tenant_id = ?
        `) as PrepareRun
      ).run(tenantId);
      (
        db.prepare(`
          INSERT INTO product_barcodes (${BARCODE_COLUMNS.join(', ')})
          SELECT ${BARCODE_COLUMNS.join(', ')} FROM product_barcodes_staging WHERE tenant_id = ?
        `) as PrepareRun
      ).run(tenantId);
      // Clear staging INSIDE the same tx (atomic with the commit) so a successful
      // run leaves staging empty without any post-commit clear that could throw
      // and flip a committed promote to `failed`. The start-of-run clear already
      // guards leakage (data-model invariant 2); this keeps staging tidy too.
      (db.prepare('DELETE FROM products_staging WHERE tenant_id = ?') as PrepareRun).run(tenantId);
      (db.prepare('DELETE FROM product_barcodes_staging WHERE tenant_id = ?') as PrepareRun).run(
        tenantId,
      );
      // Freshness written INSIDE the tx (SC-10). `outcome` records whether the
      // promote was clean or dropped some rejected rows (FR-9), so the freshness
      // surface (FR-16) can tell them apart.
      syncStateRepo.recordSuccess({
        tenantId,
        branchId,
        lastSuccessAt: now,
        sourceSnapshotId,
        outcome,
      });
    });
    tx();
  }

  function recordFailure(input: RecordFetchFailureInput): void {
    // Diagnostics only — never advances last_success_at (SC-10). Best-effort:
    // a bookkeeping write failure must not mask the original failure.
    try {
      syncStateRepo.recordAttempt({
        tenantId: input.tenantId,
        branchId: input.branchId,
        lastAttemptAt: input.now,
        outcome: 'failed',
      });
    } catch {
      // swallow — the run/fetch is already failing; do not overwrite its cause.
    }
  }

  function run(input: ReadDownRunInput): ReadDownRunResult {
    // Reject a run with no resolvable store scope BEFORE any write (§A2 NOT NULL).
    if (input.tenantId.trim() === '' || input.branchId.trim() === '') {
      recordFailure(input);
      return {
        outcome: 'failed',
        productsWritten: 0,
        recordsRejected: 0,
        failureCategory: 'no-store-scope',
      };
    }

    try {
      // Step 1: clear staging at the START (no prior-run leakage).
      clearStaging(input.tenantId);

      // Step 2: map + validate; count mapping AND validation rejections uniformly.
      const validRecords: MappedRecord[] = [];
      let rejected = 0;
      for (const row of input.rows) {
        const mapped = mapSellableRow(row);
        if (!mapped.ok) {
          rejected += 1;
          continue;
        }
        const validated = validateRecord(mapped.value);
        if (!validated.ok) {
          rejected += 1;
          continue;
        }
        validRecords.push(validated.value);
      }

      // Step 3: abort-threshold (only meaningful when there were rows at all).
      const total = input.rows.length;
      if (total > 0 && rejected / total > ABORT_THRESHOLD_REJECTED_FRACTION) {
        recordFailure(input);
        return {
          outcome: 'failed',
          productsWritten: 0,
          recordsRejected: rejected,
          failureCategory: 'threshold-exceeded',
        };
      }

      // Step 4: stage the validated set (fold columns via normalize()) in ONE
      // transaction (#411 — collapses ~100k autocommit INSERTs to one commit).
      stageAll(input.tenantId, input.branchId, validRecords);

      // Step 5: promote atomically (DELETE live + INSERT…SELECT + freshness).
      // The committed outcome distinguishes a clean promote from one that dropped
      // some rejected rows (FR-9). Staging is NOT cleared after the promote: the
      // start-of-run clear (Step 1) already guarantees no leak (data-model
      // invariant 2), and clearing post-commit would risk flipping a committed
      // promote to `failed` in the outer catch if that clear ever threw.
      const outcome = rejected > 0 ? 'skipped_with_rejections' : 'succeeded';
      promote(input, outcome);

      return {
        outcome,
        productsWritten: validRecords.length,
        recordsRejected: rejected,
        failureCategory: null,
      };
    } catch {
      // Any DB error (incl. a rolled-back promote): the prior catalogue is
      // preserved by the transaction. Record the failure for diagnostics.
      recordFailure(input);
      return {
        outcome: 'failed',
        productsWritten: 0,
        recordsRejected: 0,
        failureCategory: 'db-error',
      };
    }
  }

  const deltas = createDeltaApplier({ db, syncStateRepo, recordFailure });

  return {
    run,
    applyDeltas: (input) => deltas.applyDeltas(input),
    currentCursor: (tenantId, branchId) => deltas.currentCursor(tenantId, branchId),
    recordFetchFailure: recordFailure,
  };
}
