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
import { createReadDownDriver } from '../read-down-driver.js';
import type {
  ReadDownClient,
  ReadDownDeltaResult,
  ReadDownFetchResult,
} from '../read-down-client-types.js';
import type { SellableCatalogRow } from '../map-sellable-row.js';

/**
 * RT-1487 — the driver syncs by delta after a successful snapshot.
 *
 *   • No stored cursor (first sync, or a cursor for another store) → full snapshot.
 *   • Stored cursor → `fetchDeltas(cursor)` and an atomic apply; no snapshot call.
 *   • `snapshot_required` (409), a reached-but-failed delta call, or a rejected
 *     delta apply → re-baseline with a full snapshot in the same tick.
 *   • `no_connection` / `device_unauthorized` → no snapshot retry; the failed
 *     attempt is recorded and the prior catalogue stays sellable offline.
 *   • A client without `fetchDeltas` keeps the snapshot-only behaviour.
 */

beforeAll(async () => {
  await initCatalogueSql();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';

function good(id: string, amount = '10.00'): SellableCatalogRow {
  return {
    product_id: id,
    sku: `SKU-${id}`,
    name: `Name ${id}`,
    aliases: [],
    price: { amount, currency_code: 'EGP' },
    tax_category: 'standard',
    active: true,
    row_cursor: `rc-${id}`,
  };
}

interface Script {
  snapshots: ReadDownFetchResult[];
  deltas: ReadDownDeltaResult[];
}

function scriptedClient(script: Script): {
  client: ReadDownClient;
  snapshotCalls: () => number;
  deltaSince: string[];
} {
  let s = 0;
  let d = 0;
  const deltaSince: string[] = [];
  return {
    client: {
      fetchSnapshot() {
        const r = script.snapshots[Math.min(s, script.snapshots.length - 1)] ?? { kind: 'failed' };
        s += 1;
        return Promise.resolve(r);
      },
      fetchDeltas(since: string) {
        deltaSince.push(since);
        const r = script.deltas[Math.min(d, script.deltas.length - 1)] ?? { kind: 'failed' };
        d += 1;
        return Promise.resolve(r);
      },
    },
    snapshotCalls: () => s,
    deltaSince,
  };
}

function setup(script: Script) {
  const db = freshCatalogueDb();
  const handle = handleFor(db);
  const syncStateRepo = createCatalogueSyncStateRepo(handle);
  const writer = createReadDownWriter({ db: handle, syncStateRepo });
  const fake = scriptedClient(script);
  let clock = 0;
  const driver = createReadDownDriver({
    client: fake.client,
    writer,
    tenantId: TENANT,
    branchId: BRANCH,
    now: () => `2026-11-19T10:00:0${String(clock++)}.000Z`,
    tickIntervalMs: 60_000,
  });
  const repo = createProductRepo(handle);
  async function tick() {
    const admission = driver.runTickOnce();
    if (admission.kind !== 'started') throw new Error('not admitted');
    return admission.completed;
  }
  return { db, handle, syncStateRepo, repo, fake, tick };
}

const SNAP_OK: ReadDownFetchResult = {
  kind: 'ok',
  sourceSnapshotId: 'snap-1',
  rows: [good('p1'), good('p2')],
};

describe('RT-1487 — read-down driver delta sync', () => {
  it('the first sync takes a full snapshot, the next uses deltas from its cursor', async () => {
    const t = setup({
      snapshots: [SNAP_OK],
      deltas: [
        {
          kind: 'ok',
          cursor: 'cur-2',
          ops: [
            { op: 'upsert', productId: 'p1', row: good('p1', '20.00') },
            { op: 'remove_from_sellable', productId: 'p2' },
          ],
        },
      ],
    });

    await t.tick();
    expect(t.fake.snapshotCalls()).toBe(1);
    expect(t.fake.deltaSince).toEqual([]);

    const second = await t.tick();
    expect(second).toEqual({
      outcome: 'succeeded',
      productsWritten: 1,
      recordsRejected: 0,
      failureCategory: null,
    });
    expect(t.fake.snapshotCalls()).toBe(1);
    expect(t.fake.deltaSince).toEqual(['snap-1']);
    expect(t.repo.lookupBySku(TENANT, 'SKU-p2').kind).toBe('not_found');
    expect(nn(t.syncStateRepo.read(TENANT)).source_snapshot_id).toBe('cur-2');

    // The third tick continues from the advanced cursor.
    await t.tick();
    expect(t.fake.deltaSince).toEqual(['snap-1', 'cur-2']);
    t.db.close();
  });

  it('snapshot_required falls back to a full snapshot and the sync recovers', async () => {
    const t = setup({
      snapshots: [SNAP_OK, { kind: 'ok', sourceSnapshotId: 'snap-2', rows: [good('p9')] }],
      deltas: [{ kind: 'snapshot_required' }],
    });
    await t.tick();

    const outcome = await t.tick();

    expect(outcome.outcome).toBe('succeeded');
    expect(t.fake.snapshotCalls()).toBe(2);
    expect(t.repo.lookupBySku(TENANT, 'SKU-p9').kind).toBe('one');
    expect(t.repo.lookupBySku(TENANT, 'SKU-p1').kind).toBe('not_found');
    expect(nn(t.syncStateRepo.read(TENANT)).source_snapshot_id).toBe('snap-2');
    t.db.close();
  });

  it('a reached-but-failed delta call re-baselines with a snapshot', async () => {
    const t = setup({
      snapshots: [SNAP_OK, { kind: 'ok', sourceSnapshotId: 'snap-2', rows: [good('p1')] }],
      deltas: [{ kind: 'failed' }],
    });
    await t.tick();
    const outcome = await t.tick();
    expect(outcome.outcome).toBe('succeeded');
    expect(t.fake.snapshotCalls()).toBe(2);
    expect(nn(t.syncStateRepo.read(TENANT)).source_snapshot_id).toBe('snap-2');
    t.db.close();
  });

  it('a rejected delta apply re-baselines with a snapshot', async () => {
    const t = setup({
      snapshots: [SNAP_OK, { kind: 'ok', sourceSnapshotId: 'snap-2', rows: [good('p1', '30.00')] }],
      deltas: [
        {
          kind: 'ok',
          cursor: 'cur-2',
          ops: [{ op: 'upsert', productId: 'p1', row: good('p1', 'bad-money') }],
        },
      ],
    });
    await t.tick();
    const outcome = await t.tick();
    expect(outcome.outcome).toBe('succeeded');
    expect(t.fake.snapshotCalls()).toBe(2);
    expect(nn(t.syncStateRepo.read(TENANT)).source_snapshot_id).toBe('snap-2');
    t.db.close();
  });

  it.each([['no_connection' as const], ['device_unauthorized' as const]])(
    'a %s delta keeps the catalogue sellable offline and does not retry with a snapshot',
    async (kind) => {
      const t = setup({ snapshots: [SNAP_OK], deltas: [{ kind }] });
      await t.tick();

      const outcome = await t.tick();

      expect(outcome).toEqual({
        outcome: 'failed',
        productsWritten: 0,
        recordsRejected: 0,
        failureCategory: 'transport',
      });
      expect(t.fake.snapshotCalls()).toBe(1);
      expect(t.repo.lookupBySku(TENANT, 'SKU-p1').kind).toBe('one');
      const state = nn(t.syncStateRepo.read(TENANT));
      expect(state.source_snapshot_id).toBe('snap-1');
      expect(state.last_outcome).toBe('failed');
      // The next tick still resumes from the last good cursor.
      await t.tick();
      expect(t.fake.deltaSince).toEqual(['snap-1', 'snap-1']);
      t.db.close();
    },
  );

  it('when the fallback snapshot also fails, the prior catalogue is preserved', async () => {
    const t = setup({
      snapshots: [SNAP_OK, { kind: 'no_connection' }],
      deltas: [{ kind: 'snapshot_required' }],
    });
    await t.tick();
    const outcome = await t.tick();
    expect(outcome.outcome).toBe('failed');
    expect(outcome.failureCategory).toBe('transport');
    expect(t.repo.lookupBySku(TENANT, 'SKU-p1').kind).toBe('one');
    expect(nn(t.syncStateRepo.read(TENANT)).source_snapshot_id).toBe('snap-1');
    t.db.close();
  });

  it('a client without fetchDeltas keeps the snapshot-only behaviour', async () => {
    const db = freshCatalogueDb();
    const handle = handleFor(db);
    const writer = createReadDownWriter({
      db: handle,
      syncStateRepo: createCatalogueSyncStateRepo(handle),
    });
    let calls = 0;
    const driver = createReadDownDriver({
      client: {
        fetchSnapshot() {
          calls += 1;
          return Promise.resolve(SNAP_OK);
        },
      },
      writer,
      tenantId: TENANT,
      branchId: BRANCH,
      now: () => '2026-11-19T10:00:00.000Z',
      tickIntervalMs: 60_000,
    });
    for (let i = 0; i < 2; i += 1) {
      const a = driver.runTickOnce();
      if (a.kind === 'started') await a.completed;
    }
    expect(calls).toBe(2);
    db.close();
  });
});
