/**
 * RT-1487 — apply catalogue deltas (`posGetCatalogDeltas`, decisions 424–431)
 * onto the live read model.
 *
 *   • ONE transaction: every op in server order, then the advanced cursor and
 *     `last_success_at`. A throw rolls back all of it, so the cursor never moves
 *     past a change that did not land and the prior catalogue stays sellable.
 *   • `upsert` replaces the product row and its barcodes; `remove_from_sellable`
 *     (the tombstone) deletes both, so the item can no longer be sold.
 *   • Idempotent replay: each op deletes then (for an upsert) re-inserts, so
 *     re-applying the same ops converges to the same state.
 *   • Any upsert that fails mapping/validation refuses the WHOLE apply
 *     (`delta-rejected`, nothing written): applying the rest would leave that
 *     product at its old state while the cursor moved past its change. The
 *     driver then re-baselines with a full snapshot, whose FR-9 skip-and-count
 *     rules apply.
 *
 * Tenant-scoped (P17): every statement filters the device tenant.
 */

import type { DatabaseHandle } from '../../db/client.js';
import type { CatalogueSyncStateRepo } from '../catalogue-sync-state-repo.js';
import { mapSellableRow, type MappedRecord } from './map-sellable-row.js';
import type { ReadDownDeltaOp } from './read-down-client-types.js';
import type { ReadDownRunResult } from './read-down-writer.js';
import { prepareRecordInsert } from './record-insert.js';
import { validateRecord } from './validate-record.js';

/** Inputs for applying one fetched delta set. */
export interface ApplyDeltasInput {
  tenantId: string;
  branchId: string;
  /** The advanced server cursor; stored as `source_snapshot_id` on success. */
  cursor: string;
  /** ISO-8601 UTC timestamp for this run. */
  now: string;
  /** Every op of every delta page, in server order. */
  ops: ReadDownDeltaOp[];
}

type CommittedOutcome = 'succeeded' | 'skipped_with_rejections';

interface PrepareRun {
  run(...params: unknown[]): unknown;
}

interface DeltaApplierDeps {
  db: DatabaseHandle;
  syncStateRepo: CatalogueSyncStateRepo;
  /** The writer's diagnostics write (never advances `last_success_at`). */
  recordFailure: (input: { tenantId: string; branchId: string; now: string }) => void;
}

interface DeltaApplier {
  applyDeltas(input: ApplyDeltasInput): ReadDownRunResult;
  currentCursor(tenantId: string, branchId: string): string | null;
}

function failed(
  failureCategory: NonNullable<ReadDownRunResult['failureCategory']>,
  recordsRejected = 0,
): ReadDownRunResult {
  return { outcome: 'failed', productsWritten: 0, recordsRejected, failureCategory };
}

/** Map + validate every upsert, keyed by op index; counts the rejected ones. */
function mapUpserts(ops: ReadDownDeltaOp[]): {
  records: Map<number, MappedRecord>;
  rejected: number;
} {
  const records = new Map<number, MappedRecord>();
  let rejected = 0;
  ops.forEach((op, index) => {
    if (op.op !== 'upsert') return;
    const mapped = mapSellableRow(op.row);
    const validated = mapped.ok ? validateRecord(mapped.value) : null;
    if (validated?.ok === true) {
      records.set(index, validated.value);
    } else {
      rejected += 1;
    }
  });
  return { records, rejected };
}

export function createDeltaApplier(deps: DeltaApplierDeps): DeltaApplier {
  const { db, syncStateRepo, recordFailure } = deps;

  function writeAll(
    input: ApplyDeltasInput,
    records: Map<number, MappedRecord>,
    outcome: CommittedOutcome,
  ): void {
    const { tenantId, branchId, cursor, now, ops } = input;
    const insertLive = prepareRecordInsert(db, 'products', 'product_barcodes');
    const deleteProduct = db.prepare(
      'DELETE FROM products WHERE tenant_id = ? AND product_id = ?',
    ) as PrepareRun;
    const deleteBarcodes = db.prepare(
      'DELETE FROM product_barcodes WHERE tenant_id = ? AND product_id = ?',
    ) as PrepareRun;

    const tx = db.transaction(() => {
      ops.forEach((op, index) => {
        deleteProduct.run(tenantId, op.productId);
        deleteBarcodes.run(tenantId, op.productId);
        const rec = records.get(index);
        if (rec !== undefined) insertLive(tenantId, branchId, rec);
      });
      // Cursor + freshness INSIDE the tx (SC-10).
      syncStateRepo.recordSuccess({
        tenantId,
        branchId,
        lastSuccessAt: now,
        sourceSnapshotId: cursor,
        outcome,
      });
    });
    tx();
  }

  /**
   * A delta cannot restore rows the last snapshot skipped (FR-9): they only come
   * back with a product change or the next snapshot. So a delta keeps a stored
   * `skipped_with_rejections` instead of reporting a clean catalogue (FR-16).
   */
  function committedOutcome(tenantId: string): CommittedOutcome {
    return syncStateRepo.read(tenantId)?.last_outcome === 'skipped_with_rejections'
      ? 'skipped_with_rejections'
      : 'succeeded';
  }

  function applyDeltas(input: ApplyDeltasInput): ReadDownRunResult {
    // Reject a run with no resolvable store scope BEFORE any write (§A2 NOT NULL).
    if (input.tenantId.trim() === '' || input.branchId.trim() === '') {
      recordFailure(input);
      return failed('no-store-scope');
    }
    try {
      const { records, rejected } = mapUpserts(input.ops);
      if (rejected > 0) {
        recordFailure(input);
        return failed('delta-rejected', rejected);
      }
      const outcome = committedOutcome(input.tenantId);
      writeAll(input, records, outcome);
      return {
        outcome,
        productsWritten: records.size,
        recordsRejected: 0,
        failureCategory: null,
      };
    } catch {
      // The transaction rolled back: prior catalogue and cursor are intact.
      recordFailure(input);
      return failed('db-error');
    }
  }

  /**
   * The cursor of the last successful snapshot/delta for this store, or `null`
   * (first sync, or the stored row belongs to another store). Only a SUCCESS
   * writes `source_snapshot_id`, inside the same transaction as the catalogue it
   * describes, so this cursor always matches the live catalogue.
   */
  function currentCursor(tenantId: string, branchId: string): string | null {
    const state = syncStateRepo.read(tenantId);
    if (state === null || state.branch_id !== branchId || state.last_success_at === null) {
      return null;
    }
    const cursor = state.source_snapshot_id;
    return cursor !== null && cursor.length > 0 ? cursor : null;
  }

  return { applyDeltas, currentCursor };
}
