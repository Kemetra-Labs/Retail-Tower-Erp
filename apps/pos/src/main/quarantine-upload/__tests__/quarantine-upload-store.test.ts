/**
 * RT-1312 Phase 3(c) — the `sale_quarantine_upload` store (migration 0065) on the
 * real migrated schema, with the real sale-sync state repo writing the
 * dead-letters it reads.
 *
 * The candidates are the CURRENT tenant and branch's stranded sales (decision P2):
 *   • dead-lettered with one of the three reasons the contract names
 *     (`permanent`, `payload_divergence`, `cashier_claim_refused`), from ANY of the
 *     branch's pairings (the till's dead-letter count is branch-wide);
 *   • held: unsent (no state row, or pending) and queued under an EARLIER pairing.
 * Never: this pairing's own unsent sales, synced sales, another store's sales, or
 * a sale already uploaded, refused, or waiting for its backoff.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { createSaleSyncStateRepo } from '../../sales-sync/sale-sync-state-repo.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedOutbox,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { bindQuarantineUploadStore } from '../quarantine-upload-store.js';

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-current' };
const T0 = '2026-11-19T10:00:00.000Z';
const T1 = '2026-11-19T10:05:00.000Z';
const NOW = '2026-11-19T12:00:00.000Z';
const LATER = '2026-11-19T12:10:00.000Z';

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

const store = () => bindQuarantineUploadStore(handleFor(db));
const stateRepo = () => createSaleSyncStateRepo(handleFor(db));

/** A sale with its outbox row; `enqueued_at` orders the candidates. */
function seed(
  saleId: string,
  o: { terminal?: string; tenant?: string; branch?: string; enqueuedAt?: string } = {},
): void {
  const terminal_id = o.terminal ?? SCOPE.terminalId;
  const tenant_id = o.tenant ?? SCOPE.tenantId;
  const branch_id = o.branch ?? SCOPE.branchId;
  seedSale(db, { sale_id: saleId, tenant_id, branch_id, terminal_id });
  seedOutbox(db, {
    sale_id: saleId,
    tenant_id,
    branch_id,
    terminal_id,
    enqueued_at: o.enqueuedAt ?? T0,
  });
}

function deadLetter(
  saleId: string,
  reason?: 'permanent' | 'payload_divergence' | 'cashier_claim_refused',
  scope = SCOPE,
) {
  stateRepo().markDeadLetter({
    saleId,
    tenantId: scope.tenantId,
    branchId: scope.branchId,
    now: T1,
    ...(reason === undefined ? {} : { reason }),
  });
}

function uploadRows(): unknown[][] {
  return (
    db.exec(
      `SELECT sale_id, state, attempts, last_status, quarantine_ref, quarantine_state, next_attempt_at, settled_at
       FROM sale_quarantine_upload ORDER BY sale_id`,
    )[0]?.values ?? []
  );
}

describe('quarantine upload store — the candidates', () => {
  it('lists a dead-lettered sale with its reason and when the till dead-lettered it', () => {
    seed('s1');
    deadLetter('s1', 'payload_divergence');
    expect(store().listCandidates(SCOPE, NOW)).toEqual([
      {
        saleId: 's1',
        attempts: 0,
        source: { kind: 'dead_letter', category: 'payload_divergence', tillRecordedAt: T1 },
      },
    ]);
  });

  it('lists the three reasons the contract names, and no other dead-letter', () => {
    for (const [id, reason] of [
      ['a', 'permanent'],
      ['b', 'payload_divergence'],
      ['c', 'cashier_claim_refused'],
    ] as const) {
      seed(id);
      deadLetter(id, reason);
    }
    seed('d');
    deadLetter('d');
    db.run(`UPDATE sale_sync_state SET last_error_category = 'something_new' WHERE sale_id = 'd'`);
    expect(
      store()
        .listCandidates(SCOPE, NOW)
        .map((c) => c.saleId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('lists a dead-letter from an earlier pairing of the same branch', () => {
    seed('s1', { terminal: 'term-old' });
    deadLetter('s1');
    expect(
      store()
        .listCandidates(SCOPE, NOW)
        .map((c) => c.saleId),
    ).toEqual(['s1']);
  });

  it('lists a held sale: unsent under an earlier pairing, with or without a state row', () => {
    seed('fresh', { terminal: 'term-old' });
    seed('retrying', { terminal: 'term-old' });
    stateRepo().recordTransient({
      saleId: 'retrying',
      tenantId: SCOPE.tenantId,
      branchId: SCOPE.branchId,
      now: T1,
      nextRetryAt: T1,
      errorCategory: 'transient',
    });
    expect(store().listCandidates(SCOPE, NOW)).toEqual([
      { saleId: 'fresh', attempts: 0, source: { kind: 'held' } },
      { saleId: 'retrying', attempts: 0, source: { kind: 'held' } },
    ]);
  });

  it("does not list this pairing's own unsent sale, a synced sale or another store's sale", () => {
    seed('own'); // current pairing, unsent: the drain's, not stranded
    seed('synced', { terminal: 'term-old' });
    stateRepo().markSynced({
      saleId: 'synced',
      tenantId: SCOPE.tenantId,
      branchId: SCOPE.branchId,
      now: T1,
    });
    seed('other-branch', { terminal: 'term-old', branch: 'branch-2' });
    seed('other-tenant', { terminal: 'term-old', tenant: 'tenant-2' });
    deadLetter('other-branch', 'permanent', { ...SCOPE, branchId: 'branch-2' });
    expect(store().listCandidates(SCOPE, NOW)).toEqual([]);
  });

  it('orders the candidates oldest first', () => {
    seed('late', { terminal: 'term-old', enqueuedAt: T1 });
    seed('early', { terminal: 'term-old', enqueuedAt: T0 });
    expect(
      store()
        .listCandidates(SCOPE, NOW)
        .map((c) => c.saleId),
    ).toEqual(['early', 'late']);
  });
});

describe('quarantine upload store — the marks', () => {
  beforeEach(() => {
    seed('s1', { terminal: 'term-old' });
  });

  it('markUploaded records the receipt and removes the sale from the candidates for good', () => {
    store().markUploaded('s1', SCOPE, 201, { quarantineRef: 'ref-1', state: 'open' }, NOW);
    expect(uploadRows()).toEqual([['s1', 'uploaded', 0, 201, 'ref-1', 'open', NOW, NOW]]);
    expect(store().listCandidates(SCOPE, LATER)).toEqual([]);
  });

  it('markUploaded without a readable receipt still marks the sale', () => {
    store().markUploaded('s1', SCOPE, 200, null, NOW);
    expect(uploadRows()).toEqual([['s1', 'uploaded', 0, 200, null, null, NOW, NOW]]);
  });

  it('markRefused removes the sale from the candidates, with its status', () => {
    store().markRefused('s1', SCOPE, 409, NOW);
    expect(uploadRows()).toEqual([['s1', 'refused', 0, 409, null, null, NOW, NOW]]);
    expect(store().listCandidates(SCOPE, LATER)).toEqual([]);
  });

  it('markRetry charges an attempt and hides the sale until it is due', () => {
    store().markRetry('s1', SCOPE, 503, LATER, NOW);
    expect(store().listCandidates(SCOPE, NOW)).toEqual([]);
    expect(store().listCandidates(SCOPE, LATER)).toEqual([
      { saleId: 's1', attempts: 1, source: { kind: 'held' } },
    ]);
    store().markRetry('s1', SCOPE, null, LATER, LATER);
    expect(uploadRows()).toEqual([['s1', 'pending', 2, null, null, null, LATER, null]]);
  });

  it('markParked hides a sale until it is due, charging no attempt and keeping no status', () => {
    store().markParked('s1', SCOPE, LATER, NOW);
    expect(uploadRows()).toEqual([['s1', 'pending', 0, null, null, null, LATER, null]]);
    expect(store().listCandidates(SCOPE, NOW)).toEqual([]);
    expect(
      store()
        .listCandidates(SCOPE, LATER)
        .map((c) => c.saleId),
    ).toEqual(['s1']);
  });

  it('markParked keeps the attempts and status an earlier retry recorded', () => {
    store().markRetry('s1', SCOPE, 503, NOW, NOW);
    store().markParked('s1', SCOPE, LATER, LATER);
    expect(uploadRows()).toEqual([['s1', 'pending', 1, 503, null, null, LATER, null]]);
  });

  it('a settled row is never changed by a later mark', () => {
    store().markParked('s1', SCOPE, LATER, NOW);
    store().markUploaded('s1', SCOPE, 201, { quarantineRef: 'ref-1', state: 'open' }, NOW);
    store().markParked('s1', SCOPE, LATER, LATER);
    store().markUploaded('s1', SCOPE, 201, { quarantineRef: 'ref-1', state: 'open' }, NOW);
    store().markRetry('s1', SCOPE, 503, LATER, LATER);
    store().markRefused('s1', SCOPE, 400, LATER);
    // (the row keeps the due time of the park it was uploaded from)
    expect(uploadRows()).toEqual([['s1', 'uploaded', 0, 201, 'ref-1', 'open', LATER, NOW]]);
  });
});

describe('quarantine upload store — what the heartbeat stops counting', () => {
  it('counts an uploaded dead-letter and an uploaded held row, apart', () => {
    seed('dead', { terminal: 'term-old' });
    deadLetter('dead');
    seed('held', { terminal: 'term-old' });
    store().markUploaded('dead', SCOPE, 201, null, NOW);
    store().markUploaded('held', SCOPE, 201, null, NOW);
    expect(store().countUploaded(SCOPE)).toEqual({ deadLetter: 1, heldPreviousPairing: 1 });
  });

  it("does not count a refused or pending row, or another store's upload", () => {
    seed('refused', { terminal: 'term-old' });
    seed('pending', { terminal: 'term-old' });
    seed('foreign', { terminal: 'term-old', branch: 'branch-2' });
    store().markRefused('refused', SCOPE, 400, NOW);
    store().markRetry('pending', SCOPE, 503, LATER, NOW);
    store().markUploaded('foreign', { ...SCOPE, branchId: 'branch-2' }, 201, null, NOW);
    expect(store().countUploaded(SCOPE)).toEqual({ deadLetter: 0, heldPreviousPairing: 0 });
  });

  it('matches the heartbeat counts it is subtracted from', () => {
    seed('dead', { terminal: 'term-old' });
    deadLetter('dead');
    seed('held', { terminal: 'term-old' });
    const counts = stateRepo().readSyncStatus(SCOPE);
    expect({ deadLetter: counts.deadLetter, held: counts.heldPreviousPairing }).toEqual({
      deadLetter: 1,
      held: 1,
    });
    store().markUploaded('dead', SCOPE, 201, null, NOW);
    store().markUploaded('held', SCOPE, 201, null, NOW);
    const uploaded = store().countUploaded(SCOPE);
    expect(counts.deadLetter - uploaded.deadLetter).toBe(0);
    expect(counts.heldPreviousPairing - uploaded.heldPreviousPairing).toBe(0);
  });
});
