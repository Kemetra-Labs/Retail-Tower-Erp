/**
 * RT-1543 follow-up (owner decision c18146) — a cash return payout needs an open shift when shift
 * cash-up is on for the till.
 *
 *   • shift cash-up on + no open shift: every payout action (`start`, `retry_drawer`, `manual`) is
 *     refused `payout_no_open_shift` BEFORE the drawer slot is taken, so nothing is claimed, kicked,
 *     marked `paid_out` or outboxed, and the refusal is audited like every other payout refusal;
 *   • shift cash-up on + an open shift, and shift cash-up off: today's behaviour, unchanged;
 *   • both reads are per call, and a read that throws refuses (fail closed);
 *   • a claim made while a shift was open and then lost (a manager force-close on the server) is not
 *     stranded: the payout completes once a shift is open again.
 *
 * Over the real composed domain on sql.js, with a fake drawer, printer and Backend-Core.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDrawerSlot, type DrawerSlot } from '../../drawer/drawer-slot.js';
import {
  SHIFT_REF,
  categories,
  confirmedReturn,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;
let slot: DrawerSlot;
let acquired: number;

beforeEach(() => {
  const inner = createDrawerSlot();
  acquired = 0;
  slot = {
    tryAcquire: () => {
      acquired += 1;
      return inner.tryAcquire();
    },
    busy: () => inner.busy(),
  };
  h = returnsHarness({ drawerSlot: slot });
  seedSyncedSale(h.db);
});

afterEach(() => {
  h.close();
});

type Row = Record<string, unknown>;

function rows(sql: string): Row[] {
  const res = h.db.exec(sql)[0];
  if (res === undefined) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

const count = (table: string): number =>
  Number(rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.['n']);
const stateOf = (): unknown => rows('SELECT state FROM return_journal')[0]?.['state'];

/** Nothing about the payout happened: no slot, claim, kick, paid_out, execution or paid_out audit. */
function expectNothingHappened(): void {
  expect(acquired).toBe(0);
  expect(slot.busy()).toBe(false);
  expect(count('return_payouts')).toBe(0);
  expect(h.drawer.kicks).toBe(0);
  expect(h.printer.printed).toHaveLength(0);
  expect(stateOf()).toBe('confirmed');
  expect(count('return_refund_executions')).toBe(0);
  expect(h.backend.executionCalls()).toEqual([]);
  expect(categories(h.audits)).not.toContain('sale.return.payout_started');
  expect(categories(h.audits)).not.toContain('sale.return.paid_out');
}

describe('shift cash-up on and no open shift', () => {
  beforeEach(() => {
    h.state.shiftCashup = true;
  });

  it('refuses start before the slot, the claim, the kick, paid_out and any execution', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.shiftRef = null;
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({
      kind: 'refused',
      reason: 'payout_no_open_shift',
      ret: { returnId, state: 'confirmed', payout: null },
    });
    expectNothingHappened();
    await h.resolver.drain(1_000);
    expectNothingHappened();
  });

  it('audits the refusal as a payout refusal, with the return and its sale', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.shiftRef = null;
    await h.service.payout({ returnId, action: 'start' });
    const refusals = h.audits.filter((a) => a.action_category === 'sale.return.refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      payload: { operation: 'payout', reason: 'payout_no_open_shift', return_id: returnId },
    });
  });

  it('refuses retry_drawer and manual too (every action that takes cash out)', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.shiftRef = null;
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expectNothingHappened();
  });

  it('can be paid as soon as a shift is open: the refusal wrote nothing to undo', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.shiftRef = null;
    await h.service.payout({ returnId, action: 'start' });
    h.state.shiftRef = SHIFT_REF;
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'paid_out',
      method: 'drawer',
    });
    await h.resolver.drain(1_000);
    expect(h.drawer.kicks).toBe(1);
    expect(h.backend.executionCalls()).toHaveLength(1);
  });

  it('does not take the drawer from a payout that holds it: no slot is even asked for', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.shiftRef = null;
    const release = slot.tryAcquire();
    acquired = 0;
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      reason: 'payout_no_open_shift',
    });
    expect(acquired).toBe(0);
    release?.();
  });

  it('answers a request for a return of another terminal without disclosing it', async () => {
    h.state.shiftRef = null;
    const res = await h.service.payout({ returnId: 'no-such-return', action: 'start' });
    expect(res).toEqual({ kind: 'refused', reason: 'payout_no_open_shift', ret: null });
  });

  it('a claim made while a shift was open is completed once a shift is open again, never stranded', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'os_error' });
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'drawer_failed',
    });
    expect(count('return_payouts')).toBe(1);
    // The shift is gone (a manager force-closed it on the server): refused, the claim stays.
    h.state.shiftRef = null;
    for (const action of ['manual', 'retry_drawer'] as const) {
      expect(await h.service.payout({ returnId, action })).toMatchObject({
        kind: 'refused',
        reason: 'payout_no_open_shift',
      });
    }
    expect(count('return_payouts')).toBe(1);
    expect(stateOf()).toBe('confirmed');
    expect(h.drawer.kicks).toBe(1);
    expect(slot.busy()).toBe(false);
    // The till opens its next shift: the same claim completes, once.
    h.state.shiftRef = SHIFT_REF;
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
      method: 'manual',
    });
    expect(stateOf()).toBe('paid_out');
    expect(h.drawer.kicks).toBe(1);
  });
});

describe('shift cash-up on and a shift open: unchanged', () => {
  it('pays out through the drawer, and reports the execution with the shift', async () => {
    const returnId = await confirmedReturn(h.service);
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({ kind: 'paid_out', method: 'drawer', slip: 'printed' });
    await h.resolver.drain(1_000);
    expect(acquired).toBe(1);
    expect(h.drawer.kicks).toBe(1);
    expect(h.backend.executionCalls()).toHaveLength(1);
    expect(categories(h.audits)).not.toContain('sale.return.refused');
  });
});

describe('shift cash-up off: unchanged, the shift is never asked for', () => {
  it('pays out with no shift open, sends no allocationRef and reports nothing', async () => {
    h.state.shiftCashup = false;
    h.state.shiftRef = null;
    h.state.failShiftRead = true;
    const returnId = await confirmedReturn(h.service);
    expect(h.backend.returnCalls()[0]?.body).not.toContain('allocationRef');
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'paid_out',
      method: 'drawer',
    });
    await h.resolver.drain(1_000);
    expect(h.drawer.kicks).toBe(1);
    expect(count('return_refund_executions')).toBe(0);
    expect(h.backend.executionCalls()).toEqual([]);
    expect(categories(h.audits)).not.toContain('sale.return.refused');
  });
});

describe('both reads are per call', () => {
  it('follows the flag and the shift as they change between two payouts', async () => {
    const first = await confirmedReturn(h.service);
    h.state.shiftRef = null;
    h.state.shiftCashup = true;
    expect(await h.service.payout({ returnId: first, action: 'start' })).toMatchObject({
      reason: 'payout_no_open_shift',
    });
    h.state.shiftCashup = false;
    expect(await h.service.payout({ returnId: first, action: 'start' })).toMatchObject({
      kind: 'paid_out',
    });
    // A second return: the flag goes back on with no shift, then a shift opens.
    h.state.shiftCashup = true;
    h.state.shiftRef = null;
    const second = await confirmedReturn(h.service);
    expect(await h.service.payout({ returnId: second, action: 'start' })).toMatchObject({
      reason: 'payout_no_open_shift',
    });
    h.state.shiftRef = SHIFT_REF;
    expect(await h.service.payout({ returnId: second, action: 'start' })).toMatchObject({
      kind: 'paid_out',
    });
    expect(h.drawer.kicks).toBe(2);
  });
});

describe('fails closed', () => {
  it('a shift read that throws counts as no shift: refused, nothing happened', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.failShiftRead = true;
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expectNothingHappened();
  });

  it('a flag read that throws refuses too: the till cannot say it needs no shift', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.failFlagRead = true;
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expectNothingHappened();
  });
});
