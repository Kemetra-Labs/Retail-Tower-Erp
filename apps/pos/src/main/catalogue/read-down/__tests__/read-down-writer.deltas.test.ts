import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  nn,
} from '../../__tests__/__helpers__/catalogue-fixture.js';
import { createCatalogueSyncStateRepo } from '../../catalogue-sync-state-repo.js';
import { createProductRepo } from '../../product-repo.js';
import { createReadDownWriter } from '../read-down-writer.js';
import type { SellableCatalogRow } from '../map-sellable-row.js';
import type { ReadDownDeltaOp } from '../read-down-client-types.js';
import type { DatabaseHandle } from '../../../db/client.js';

/**
 * RT-1487 — `applyDeltas`: apply a fetched delta page set onto the live read
 * model in ONE transaction (decisions 424–431).
 *
 *   • `upsert` replaces the product row and its barcodes; `remove_from_sellable`
 *     drops the product and its barcodes, so it can no longer be sold.
 *   • The advanced cursor and `last_success_at` are written inside the same
 *     transaction, so a rolled-back apply never advances the cursor.
 *   • Re-applying the same ops converges to the same state (idempotent replay).
 *   • Any op that fails mapping/validation rejects the WHOLE apply
 *     (`delta-rejected`), nothing changes, and the driver re-baselines with a
 *     full snapshot — a delta never silently leaves a stale row sellable.
 */

beforeAll(async () => {
  await initCatalogueSql();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';

function row(id: string, overrides: Partial<SellableCatalogRow> = {}): SellableCatalogRow {
  return {
    product_id: id,
    sku: `SKU-${id}`,
    name: `Name ${id}`,
    aliases: [`BC-${id}`],
    price: { amount: '10.00', currency_code: 'EGP' },
    tax_category: 'standard',
    active: true,
    row_cursor: `rc-${id}`,
    ...overrides,
  };
}

function upsert(r: SellableCatalogRow): ReadDownDeltaOp {
  return { op: 'upsert', productId: r.product_id, row: r };
}

function remove(id: string): ReadDownDeltaOp {
  return { op: 'remove_from_sellable', productId: id };
}

function count(handle: DatabaseHandle, sql: string, ...params: unknown[]): number {
  const stmt = handle.prepare(sql) as { get(...p: unknown[]): { n: number } | undefined };
  return stmt.get(...params)?.n ?? 0;
}

function priceOf(handle: DatabaseHandle, id: string): number | null {
  const stmt = handle.prepare('SELECT price_minor FROM products WHERE product_id = ?') as {
    get(id: string): { price_minor: number } | undefined;
  };
  return stmt.get(id)?.price_minor ?? null;
}

/** A DB seeded by a full snapshot of p1 + p2 at cursor `snap-1`. */
function seeded() {
  const db = freshCatalogueDb();
  const handle = handleFor(db);
  const syncStateRepo = createCatalogueSyncStateRepo(handle);
  const writer = createReadDownWriter({ db: handle, syncStateRepo });
  writer.run({
    tenantId: TENANT,
    branchId: BRANCH,
    sourceSnapshotId: 'snap-1',
    now: '2026-11-19T10:00:00.000Z',
    rows: [row('p1'), row('p2')],
  });
  return { db, handle, syncStateRepo, writer };
}

describe('RT-1487 — read-down writer applyDeltas', () => {
  it('an upsert replaces the product and its barcodes and advances the cursor', () => {
    const { db, handle, syncStateRepo, writer } = seeded();

    const result = writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [
        upsert(
          row('p1', { price: { amount: '12.50', currency_code: 'EGP' }, aliases: ['NEW-BC'] }),
        ),
      ],
    });

    expect(result).toEqual({
      outcome: 'succeeded',
      productsWritten: 1,
      recordsRejected: 0,
      failureCategory: null,
    });
    expect(priceOf(handle, 'p1')).toBe(1250);
    const repo = createProductRepo(handle);
    expect(repo.lookupByBarcode(TENANT, 'NEW-BC').kind).toBe('one');
    expect(repo.lookupByBarcode(TENANT, 'BC-p1').kind).toBe('not_found');
    // p2 is untouched.
    expect(repo.lookupByBarcode(TENANT, 'BC-p2').kind).toBe('one');

    const state = nn(syncStateRepo.read(TENANT));
    expect(state.source_snapshot_id).toBe('cur-2');
    expect(state.last_success_at).toBe('2026-11-19T11:00:00.000Z');
    expect(state.last_outcome).toBe('succeeded');
    db.close();
  });

  it('an upsert for a new product adds it', () => {
    const { db, handle, writer } = seeded();
    writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [upsert(row('p3'))],
    });
    expect(count(handle, 'SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?', TENANT)).toBe(3);
    expect(createProductRepo(handle).lookupBySku(TENANT, 'SKU-p3').kind).toBe('one');
    db.close();
  });

  it('a remove_from_sellable tombstone removes the item from sale', () => {
    const { db, handle, writer } = seeded();

    const result = writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [remove('p2')],
    });

    expect(result.outcome).toBe('succeeded');
    const repo = createProductRepo(handle);
    expect(repo.lookupBySku(TENANT, 'SKU-p2').kind).toBe('not_found');
    expect(repo.lookupByBarcode(TENANT, 'BC-p2').kind).toBe('not_found');
    expect(
      count(handle, 'SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ?', 'p2'),
    ).toBe(0);
    expect(repo.lookupBySku(TENANT, 'SKU-p1').kind).toBe('one');
    db.close();
  });

  it('applies ops in order: upsert then remove of the same product leaves it removed', () => {
    const { db, handle, writer } = seeded();
    writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [upsert(row('p1', { name: 'renamed' })), remove('p1')],
    });
    expect(createProductRepo(handle).lookupBySku(TENANT, 'SKU-p1').kind).toBe('not_found');
    db.close();
  });

  it('a tombstone for an unknown product is a no-op', () => {
    const { db, handle, writer } = seeded();
    const result = writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [remove('never-seen')],
    });
    expect(result.outcome).toBe('succeeded');
    expect(count(handle, 'SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?', TENANT)).toBe(2);
    db.close();
  });

  it('replaying the same ops converges to the same state (idempotent)', () => {
    const { db, handle, writer } = seeded();
    const input = {
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [
        upsert(row('p1', { price: { amount: '11.00', currency_code: 'EGP' } })),
        remove('p2'),
        upsert(row('p3')),
      ],
    };
    writer.applyDeltas(input);
    writer.applyDeltas(input);
    expect(count(handle, 'SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?', TENANT)).toBe(2);
    expect(
      count(handle, 'SELECT COUNT(*) AS n FROM product_barcodes WHERE tenant_id = ?', TENANT),
    ).toBe(2);
    expect(priceOf(handle, 'p1')).toBe(1100);
    db.close();
  });

  it('only touches the device tenant', () => {
    const { db, handle, writer } = seeded();
    writer.run({
      tenantId: 'tenant-2',
      branchId: 'branch-9',
      sourceSnapshotId: 'other',
      now: '2026-11-19T10:00:00.000Z',
      rows: [row('q1')],
    });
    writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [remove('q1')],
    });
    expect(createProductRepo(handle).lookupBySku('tenant-2', 'SKU-q1').kind).toBe('one');
    db.close();
  });

  it('a malformed upsert rejects the whole apply: nothing changes and the cursor stays', () => {
    const { db, handle, syncStateRepo, writer } = seeded();

    const result = writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [
        remove('p2'),
        upsert(row('p1', { price: { amount: 'not-money', currency_code: 'EGP' } })),
      ],
    });

    expect(result).toEqual({
      outcome: 'failed',
      productsWritten: 0,
      recordsRejected: 1,
      failureCategory: 'delta-rejected',
    });
    expect(createProductRepo(handle).lookupBySku(TENANT, 'SKU-p2').kind).toBe('one');
    expect(priceOf(handle, 'p1')).toBe(1000);
    const state = nn(syncStateRepo.read(TENANT));
    expect(state.source_snapshot_id).toBe('snap-1');
    expect(state.last_success_at).toBe('2026-11-19T10:00:00.000Z');
    expect(state.last_outcome).toBe('failed');
    db.close();
  });

  it('a throw inside the apply transaction rolls everything back', () => {
    const { db, handle, syncStateRepo } = seeded();
    const throwing = {
      ...syncStateRepo,
      recordSuccess: () => {
        throw new Error('boom inside delta tx');
      },
    };
    const writer = createReadDownWriter({ db: handle, syncStateRepo: throwing });

    const result = writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [remove('p1'), upsert(row('p3'))],
    });

    expect(result.outcome).toBe('failed');
    expect(result.failureCategory).toBe('db-error');
    const repo = createProductRepo(handle);
    expect(repo.lookupBySku(TENANT, 'SKU-p1').kind).toBe('one');
    expect(repo.lookupBySku(TENANT, 'SKU-p3').kind).toBe('not_found');
    expect(nn(syncStateRepo.read(TENANT)).source_snapshot_id).toBe('snap-1');
    db.close();
  });

  it('refuses a run with no store scope before any write', () => {
    const { db, handle, writer } = seeded();
    const result = writer.applyDeltas({
      tenantId: TENANT,
      branchId: '  ',
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [remove('p1')],
    });
    expect(result.failureCategory).toBe('no-store-scope');
    expect(createProductRepo(handle).lookupBySku(TENANT, 'SKU-p1').kind).toBe('one');
    db.close();
  });

  it('keeps a snapshot skipped_with_rejections outcome: a delta does not restore skipped rows', () => {
    const db = freshCatalogueDb();
    const handle = handleFor(db);
    const syncStateRepo = createCatalogueSyncStateRepo(handle);
    const writer = createReadDownWriter({ db: handle, syncStateRepo });
    writer.run({
      tenantId: TENANT,
      branchId: BRANCH,
      sourceSnapshotId: 'snap-1',
      now: '2026-11-19T10:00:00.000Z',
      rows: [row('p1'), row('p2'), row('bad', { price: { amount: 'x', currency_code: 'EGP' } })],
    });
    expect(nn(syncStateRepo.read(TENANT)).last_outcome).toBe('skipped_with_rejections');

    const result = writer.applyDeltas({
      tenantId: TENANT,
      branchId: BRANCH,
      cursor: 'cur-2',
      now: '2026-11-19T11:00:00.000Z',
      ops: [upsert(row('p1'))],
    });

    expect(result.outcome).toBe('skipped_with_rejections');
    const state = nn(syncStateRepo.read(TENANT));
    expect(state.last_outcome).toBe('skipped_with_rejections');
    expect(state.source_snapshot_id).toBe('cur-2');
    db.close();
  });

  describe('currentCursor', () => {
    it('is null before any successful read-down', () => {
      const db = freshCatalogueDb();
      const handle = handleFor(db);
      const writer = createReadDownWriter({
        db: handle,
        syncStateRepo: createCatalogueSyncStateRepo(handle),
      });
      expect(writer.currentCursor(TENANT, BRANCH)).toBeNull();
      db.close();
    });

    it('returns the cursor of the last successful promote for the same store', () => {
      const { db, writer } = seeded();
      expect(writer.currentCursor(TENANT, BRANCH)).toBe('snap-1');
      writer.applyDeltas({
        tenantId: TENANT,
        branchId: BRANCH,
        cursor: 'cur-2',
        now: '2026-11-19T11:00:00.000Z',
        ops: [],
      });
      expect(writer.currentCursor(TENANT, BRANCH)).toBe('cur-2');
      db.close();
    });

    it('is still the last success cursor after a failed attempt', () => {
      const { db, writer } = seeded();
      writer.recordFetchFailure({
        tenantId: TENANT,
        branchId: BRANCH,
        now: '2026-11-19T12:00:00.000Z',
      });
      expect(writer.currentCursor(TENANT, BRANCH)).toBe('snap-1');
      db.close();
    });

    it('is null when the stored row belongs to another store', () => {
      const { db, writer } = seeded();
      expect(writer.currentCursor(TENANT, 'branch-2')).toBeNull();
      db.close();
    });
  });
});
