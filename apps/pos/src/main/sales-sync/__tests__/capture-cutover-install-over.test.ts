/**
 * RT-1379 acceptance 4 — install-over body stability (RT-1377 decision §2 cases S1p, S2, S3).
 *
 * The old build (pilot 0.1.4) has no cut-offs, so every body it sends carries no `tenders`
 * and no `receipt`. Backend-Core answers 409 to a changed body under the same
 * Idempotency-Key (RT-1206), and the POS dead-letters a 409 for good. So after the new build's
 * first start:
 *   • S1p — a sale the old build attempted (transient, still pending), finalized AHEAD of the
 *     new build's clock, retries with the byte-identical body and the same `externalId`;
 *   • S2  — a sale the old build finalized but never attempted is first sent without
 *     `tenders` and `receipt` too;
 *   • S3  — a sale finalized afterwards carries `tenders`, and `receipt` when its facts are
 *     sendable.
 *
 * Driven end to end on the sql.js fixture: the real engine, the real state repo, the real
 * record-once, and the fake client that records what would be POSTed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  CAPTURE_CUTOVER_LOG,
  readEngineCutoffs,
  recordCaptureCutoverOnce,
} from '../capture-cutover.js';
import { buildCapturePayload, type CaptureSalePayload } from '../capture-payload.js';
import { DEFAULT_CURRENCY_CODE, toWireBody } from '../create-sale-sync-client.js';
import { createFakeSaleSyncClient, type SaleSyncResult } from '../sale-sync-client-types.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { bindSalesRepository, type SaleRow } from '../../sales/repositories/sales.repository.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };

/** A real cash tender, so a body WITH the gate on has `tenders` (the default seed has none). */
const CASH_SUMMARY = JSON.stringify([
  { tender_type: 'cash', amount_applied_minor: 2000, change_due_minor: 500 },
]);

/** The pending sale, finalized while the old build's clock ran ahead of the new build's. */
const S1P_FINALIZED = '2026-11-13T12:00:05.000Z';
const S2_FINALIZED = '2026-11-13T12:00:03.000Z';
/** The new build's first start: its clock is BEHIND the pending sale's `finalized_at`. */
const NEW_BUILD_NOW = new Date('2026-11-13T12:00:00.000Z');
const S3_FINALIZED = '2026-11-13T12:00:05.001Z';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});
beforeEach(() => {
  db = freshSalesSyncDb();
});
afterEach(() => {
  db.close();
});

function engineDeps(
  script: SaleSyncResult[],
  cutoffs: { tendersSince: string | null; receiptSince: string | null },
  now: string,
): SaleSyncEngineDeps & { client: ReturnType<typeof createFakeSaleSyncClient> } {
  const handle = handleFor(db);
  return {
    client: createFakeSaleSyncClient(script),
    stateRepo: createSaleSyncStateRepo(handle),
    salesRepo: bindSalesRepository(handle),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    getOperatorToken: () => 'tok-1',
    now: () => now,
    backoff: { baseMs: 1000, maxMs: 300_000 },
    tendersSince: cutoffs.tendersSince,
    receiptSince: cutoffs.receiptSince,
  };
}

async function drainOnce(deps: SaleSyncEngineDeps): Promise<void> {
  const admission = createSaleSyncEngine(deps).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

function seedCashSale(saleId: string, finalizedAt: string): void {
  seedSale(db, {
    sale_id: saleId,
    finalized_at: finalizedAt,
    subtotal_minor: 1500,
    tender_lines_summary_json: CASH_SUMMARY,
  });
  seedOutbox(db, { sale_id: saleId });
}

function bytes(payload: CaptureSalePayload | undefined): string {
  return JSON.stringify(toWireBody(nn(payload), DEFAULT_CURRENCY_CODE));
}

function callFor(
  client: ReturnType<typeof createFakeSaleSyncClient>,
  saleId: string,
): CaptureSalePayload | undefined {
  return client.calls.find((c) => c.externalId === `pos-pulse:handoff-${saleId}`);
}

function saleRow(saleId: string): SaleRow {
  return nn(bindSalesRepository(handleFor(db)).readById(saleId));
}

describe('RT-1379 acceptance 4 — install-over body stability', () => {
  it('the seeded sales are not vacuous: with the gates on they WOULD carry tenders and receipt', () => {
    seedCashSale('s1p', S1P_FINALIZED);
    const gated = buildCapturePayload(saleRow('s1p'), {
      tendersSince: '1970-01-01T00:00:00.000Z',
      receiptSince: '1970-01-01T00:00:00.000Z',
    });
    expect(gated.tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
    expect(gated.receipt).toBeDefined();
  });

  it('S1p and S2 resend byte-identical old-build bodies; S3 carries tenders and receipt', async () => {
    // ── Old build (no cut-offs): S1p is attempted once and gets a transient outcome. ──
    seedCashSale('s1p', S1P_FINALIZED);
    const oldBuild = engineDeps(
      [{ kind: 'transient' }],
      { tendersSince: null, receiptSince: null },
      '2026-11-13T12:00:06.000Z',
    );
    await drainOnce(oldBuild);
    const firstAttempt = callFor(oldBuild.client, 's1p');
    expect(firstAttempt).toBeDefined();
    expect('tenders' in nn(firstAttempt)).toBe(false);
    expect('receipt' in nn(firstAttempt)).toBe(false);
    const pending = nn(createSaleSyncStateRepo(handleFor(db)).read('s1p'));
    expect(pending.sync_status).toBe('pending');
    expect(pending.attempt_count).toBe(1);

    // S2: finalized on the old build, queued, never attempted (the old process quit).
    seedCashSale('s2', S2_FINALIZED);
    const s2OldBody = buildCapturePayload(saleRow('s2'), {
      tendersSince: null,
      receiptSince: null,
    });

    // ── New build, first start: the row is written after migrations, clock behind S1p. ──
    const logger = { info: vi.fn(), warn: vi.fn() };
    const recorded = recordCaptureCutoverOnce({
      db: handleFor(db),
      env: {},
      now: () => NEW_BUILD_NOW,
      logger,
    });
    expect(recorded.source).toBe('first_start');
    expect(recorded.tendersSince).toBe('2026-11-13T12:00:05.001Z');
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.aheadOfClock);

    // ── New build drain, with the stored cut-offs (as bootstrap/sale-sync.ts reads them). ──
    const cutoffs = readEngineCutoffs(handleFor(db), logger);
    const newBuild = engineDeps(
      [{ kind: 'ok', saleRef: null }],
      cutoffs,
      '2026-11-13T13:00:00.000Z',
    );
    await drainOnce(newBuild);

    const retry = callFor(newBuild.client, 's1p');
    expect(retry?.externalId).toBe(firstAttempt?.externalId);
    expect(bytes(retry)).toBe(bytes(firstAttempt));

    const s2First = callFor(newBuild.client, 's2');
    expect(s2First?.externalId).toBe('pos-pulse:handoff-s2');
    expect(bytes(s2First)).toBe(bytes(s2OldBody));
    expect('tenders' in nn(s2First)).toBe(false);
    expect('receipt' in nn(s2First)).toBe(false);

    // ── S3: a sale finalized on the new build, at/after the stored instant. ──
    seedCashSale('s3', S3_FINALIZED);
    const later = engineDeps(
      [{ kind: 'ok', saleRef: null }],
      readEngineCutoffs(handleFor(db), logger),
      '2026-11-13T13:00:10.000Z',
    );
    await drainOnce(later);
    const s3 = nn(callFor(later.client, 's3'));
    expect(s3.tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
    expect(s3.receipt).toMatchObject({ saleNumber: 'SN-s3', terminalLabel: 'Till 1' });

    for (const id of ['s1p', 's2', 's3']) {
      expect(nn(createSaleSyncStateRepo(handleFor(db)).read(id)).sync_status).toBe('synced');
    }
  });

  it('a second start of the new build changes nothing: the pending retry keeps its body', async () => {
    seedCashSale('s1p', S1P_FINALIZED);
    const oldBuild = engineDeps(
      [{ kind: 'transient' }],
      { tendersSince: null, receiptSince: null },
      '2026-11-13T12:00:06.000Z',
    );
    await drainOnce(oldBuild);
    const logger = { info: vi.fn(), warn: vi.fn() };
    recordCaptureCutoverOnce({ db: handleFor(db), env: {}, now: () => NEW_BUILD_NOW, logger });
    // Restart much later, clock now fine, the operator sets a past tenders instant by hand.
    recordCaptureCutoverOnce({
      db: handleFor(db),
      env: { POS_PULSE_FEATURE_SALE_TENDERS_SINCE: '2026-01-01T00:00:00Z' },
      now: () => new Date('2026-11-20T00:00:00.000Z'),
      logger,
    });
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.envIgnored);
    const newBuild = engineDeps(
      [{ kind: 'ok', saleRef: null }],
      readEngineCutoffs(handleFor(db), logger),
      '2026-11-20T00:00:00.000Z',
    );
    await drainOnce(newBuild);
    expect(bytes(callFor(newBuild.client, 's1p'))).toBe(bytes(callFor(oldBuild.client, 's1p')));
  });
});
