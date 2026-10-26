/**
 * RT-887 (RT-856 residual) — the terminal-status sync aggregate and the
 * discount-held sales.
 *
 * RT-856 holds a discounted sale from sync while discount capture is off. It
 * stays in `pending`, but nothing is wrong with it and nothing will send it
 * until RT-858. So the aggregate:
 *
 *  - reports the held subset of `pending` as `held` (present only when > 0, so
 *    a terminal with no held sale reads exactly as before);
 *  - takes `oldestPendingAt` from the NON-held unsent sales only, so a held
 *    sale never ages into the 24 h attention rule. A projection change, not a
 *    sync change: it is still a read.
 *
 * With the switch on (RT-858) a sendable discounted sale is not held and ages
 * like any other; one with no recorded approver role stays held (the drain
 * holds it too) and never ages.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedOutbox,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../../sales-sync/sale-sync-state-repo.js';
import type { DatabaseHandle } from '../../db/client.js';
import { createTerminalSyncAggregateReader } from '../sync-aggregate.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };
type SqlDb = ReturnType<typeof freshSalesSyncDb>;

const DISCOUNTED_LINES = JSON.stringify([
  {
    line_id: 'l-1',
    item_ref: 'p-1',
    display_name: 'Panadol',
    quantity: 2,
    unit_price_minor: 4500,
    line_subtotal_minor: 9000,
    note: null,
    discount: {
      kind: 'percent',
      value: 10,
      amount_minor: 900,
      placeholder_id: 'dp-1',
      reason_code: 'promotion',
      authority_source: 'cashier_approval',
      approver_operator_id: 'mgr-1',
    },
  },
]);

/** RT-858: the same discount with a recorded approver role, which the capture can send. */
const SENDABLE_LINES = DISCOUNTED_LINES.replace(
  '"approver_operator_id"',
  '"approver_role":"manager","approver_operator_id"',
);

function enqueue(
  db: SqlDb,
  saleId: string,
  enqueuedAt: string,
  extra: { lines_json?: string; terminal_id?: string } = {},
): void {
  const { lines_json, ...scope } = extra;
  seedSale(db, { sale_id: saleId, ...(lines_json === undefined ? {} : { lines_json }), ...scope });
  seedOutbox(db, { sale_id: saleId, enqueued_at: enqueuedAt, ...scope });
}

function readerFor(handle: DatabaseHandle, discountCaptureSupported?: boolean) {
  return createTerminalSyncAggregateReader({
    stateRepo: createSaleSyncStateRepo(handle),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    pausedReason: () => null,
    ...(discountCaptureSupported === undefined ? {} : { discountCaptureSupported }),
  });
}

describe('RT-887 sync aggregate — held-only', () => {
  it('counts the held sale in pending and in held, with no oldest age', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-disc', '2026-10-01T08:00:00.000Z', { lines_json: DISCOUNTED_LINES });
    const result = await readerFor(handleFor(db))();
    expect(result).toMatchObject({ pending: 1, held: 1, oldestPendingAt: null });
    db.close();
  });

  it('an unreadable sale snapshot is held too (the drain holds it), so it never ages', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-bad', '2026-10-01T08:00:00.000Z', { lines_json: 'not json' });
    const result = await readerFor(handleFor(db))();
    expect(result).toMatchObject({ pending: 1, held: 1, oldestPendingAt: null });
    db.close();
  });
});

describe('RT-887 sync aggregate — mixed', () => {
  it('the oldest age is the oldest NON-held sale, even when a held one is older', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-disc', '2026-10-01T08:00:00.000Z', { lines_json: DISCOUNTED_LINES });
    enqueue(db, 'sale-plain-b', '2026-10-17T10:00:00.000Z');
    enqueue(db, 'sale-plain-a', '2026-10-17T09:00:00.000Z');
    const result = await readerFor(handleFor(db))();
    expect(result).toMatchObject({
      pending: 3,
      held: 1,
      oldestPendingAt: '2026-10-17T09:00:00.000Z',
    });
    db.close();
  });

  it('a non-held sale older than the held one is still the oldest', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-plain', '2026-10-01T07:00:00.000Z');
    enqueue(db, 'sale-disc', '2026-10-01T08:00:00.000Z', { lines_json: DISCOUNTED_LINES });
    const result = await readerFor(handleFor(db))();
    expect(result).toMatchObject({
      pending: 2,
      held: 1,
      oldestPendingAt: '2026-10-01T07:00:00.000Z',
    });
    db.close();
  });

  it('a held sale of an earlier pairing is neither pending nor held here', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-old-pairing', '2026-10-01T08:00:00.000Z', {
      lines_json: DISCOUNTED_LINES,
      terminal_id: 'term-old',
    });
    enqueue(db, 'sale-plain', '2026-10-17T09:00:00.000Z');
    const result = await readerFor(handleFor(db))();
    expect(result).toEqual({
      pending: 1,
      heldPreviousPairing: 1,
      deadLetter: 0,
      oldestPendingAt: '2026-10-17T09:00:00.000Z',
      paused: null,
      lastSuccessAt: null,
    });
    db.close();
  });
});

describe('RT-887 sync aggregate — none held', () => {
  it('no discounted sale: no `held` key at all, the oldest as before', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-plain', '2026-10-17T09:00:00.000Z');
    const result = await readerFor(handleFor(db))();
    expect(result).toEqual({
      pending: 1,
      heldPreviousPairing: 0,
      deadLetter: 0,
      oldestPendingAt: '2026-10-17T09:00:00.000Z',
      paused: null,
      lastSuccessAt: null,
    });
    db.close();
  });

  it.each([
    [
      'a sendable discounted sale is not held and ages like any other',
      SENDABLE_LINES,
      undefined,
      '2026-10-01T08:00:00.000Z',
    ],
    [
      'a discount with no recorded approver role stays held, never ages',
      DISCOUNTED_LINES,
      1,
      '2026-10-17T09:00:00.000Z',
    ],
  ])('switch on (RT-858): %s', async (_name, lines_json, held, oldestPendingAt) => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-disc', '2026-10-01T08:00:00.000Z', { lines_json });
    enqueue(db, 'sale-plain', '2026-10-17T09:00:00.000Z');
    const result = await readerFor(handleFor(db), true)();
    expect(result.held).toBe(held);
    expect(result).toMatchObject({ pending: 2, oldestPendingAt });
    db.close();
  });

  it('switch explicitly off reads the same as the default (held)', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-disc', '2026-10-01T08:00:00.000Z', { lines_json: DISCOUNTED_LINES });
    const result = await readerFor(handleFor(db), false)();
    expect(result).toMatchObject({ pending: 1, held: 1, oldestPendingAt: null });
    db.close();
  });
});
