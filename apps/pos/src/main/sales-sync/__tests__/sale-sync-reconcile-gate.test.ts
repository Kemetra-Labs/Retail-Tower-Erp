/**
 * RT-1312 F17 (D2) — the drain holds the sales of a cashier whose offline
 * admission is still being reconciled (`isSaleHeldForReconcile`), so
 * `reconcile_offline` reaches Backend-Core BEFORE those sales do.
 *
 * Like the discount hold, the hold is a skip: no POST, no state row, no
 * attempt, never dead-lettered. The sale drains on the first tick after the
 * predicate releases it. Only the device path (a cashier's own sale) is gated.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { seedSettled } from './__helpers__/settled-audit-fixture.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createFakeSaleSyncClient } from '../sale-sync-client-types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngine } from '../sale-sync-engine.js';
import { createSellingUserIdResolver } from '../selling-user-id.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const USER_B = '0190a3c4-0000-7000-8000-00000000000b';

function setup(held: Set<string> | null, queue: Array<{ id: string; user?: string }>) {
  const db = freshSalesSyncDb();
  queue.forEach((s, i) => {
    seedSale(db, { sale_id: s.id });
    seedOutbox(db, { sale_id: s.id, enqueued_at: `2026-06-07T10:00:0${String(i)}.000Z` });
    seedSettled(db, {
      sale_id: s.id,
      ...(s.user === undefined ? {} : { selling_user_id: s.user }),
    });
  });
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]);
  const queried: string[] = [];
  const engine = createSaleSyncEngine({
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    resolveTerminalId: () => 'term-1',
    getOperatorToken: () => 'envelope-token',
    hasDeviceCredential: () => Promise.resolve(true),
    sellingUsers: createSellingUserIdResolver({ db: handle }),
    ...(held === null
      ? {}
      : {
          isSaleHeldForReconcile: (userId: string) => {
            queried.push(userId);
            return held.has(userId);
          },
        }),
    now: () => '2026-06-07T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
  });
  return { db, client, stateRepo, engine, queried };
}

async function tick(engine: SaleSyncEngine): Promise<void> {
  const admission = engine.runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

describe('RT-1312 F17 — reconcile before drain', () => {
  it('skips a held cashier’s sale untouched: no POST, no state row, no dead letter', async () => {
    const h = setup(new Set([USER_A]), [{ id: 'sale-1', user: USER_A }]);
    await tick(h.engine);
    await tick(h.engine);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.client.calls).toHaveLength(0);
    expect(h.stateRepo.read('sale-1')).toBeNull();
    expect(h.queried).toContain(USER_A);
    h.db.close();
  });

  it('drains the held sale on the first tick after the hold is released (nothing lost, nothing duplicated)', async () => {
    const held = new Set([USER_A]);
    const h = setup(held, [{ id: 'sale-1', user: USER_A }]);
    await tick(h.engine);
    held.delete(USER_A);
    await tick(h.engine);
    await tick(h.engine);
    expect(h.client.cashierCalls.map((c) => c.payload.externalId)).toEqual([
      'pos-pulse:handoff-sale-1',
    ]);
    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('synced');
    h.db.close();
  });

  it('a held cashier does not block another cashier’s sale queued behind it', async () => {
    const h = setup(new Set([USER_A]), [
      { id: 'sale-a', user: USER_A },
      { id: 'sale-b', user: USER_B },
    ]);
    await tick(h.engine);
    expect(h.client.cashierCalls.map((c) => [c.payload.externalId, c.operatorUserId])).toEqual([
      ['pos-pulse:handoff-sale-b', USER_B],
    ]);
    expect(h.stateRepo.read('sale-a')).toBeNull();
    h.db.close();
  });

  it('never gates an envelope-path sale (no selling user), and never asks about it', async () => {
    const h = setup(new Set([USER_A]), [{ id: 'sale-1' }]);
    await tick(h.engine);
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-sale-1']);
    expect(h.queried).toEqual([]);
    h.db.close();
  });

  it('without the predicate wired, behaviour is unchanged', async () => {
    const h = setup(null, [{ id: 'sale-1', user: USER_A }]);
    await tick(h.engine);
    expect(h.client.cashierCalls).toHaveLength(1);
    h.db.close();
  });
});
