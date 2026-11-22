/**
 * RT-1543 follow-up — a payout claim that outlives its shift never deadlocks the till.
 *
 * `openShift` refuses while a refund payout claim is unpaid (`drawer_activity_pending`), so a claim
 * whose shift is gone (a manager force-closed it on the server) can be completed only by
 * `retry_drawer` / `manual`, and only after that can a new shift open. Gating those two on an open
 * shift would deadlock the till; only a NEW `start` is gated.
 *
 * The execution of such a payout is reported with the shift that was open when it was CLAIMED
 * (Backend-Core records `evidence.shiftRef` as reported: it checks neither that the shift is open,
 * nor that `paidAt` falls inside it, nor the device; only one shiftRef per return and `paidAt` at
 * most 120 s ahead of its clock). A payout claimed while shift cash-up was off has no such shift and
 * reports nothing.
 *
 * Every test here uses the REAL shift cash-up service and repository on the harness database.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createShiftCashupRepo,
  type ShiftCashupRepo,
} from '../../shift-cashup/shift-cashup-repo.js';
import { ShiftCashupRefusedError } from '../../shift-cashup/shift-cashup-service.js';
import {
  serviceHarness,
  type ServiceHarness,
} from '../../shift-cashup/__tests__/__helpers__/shift-cashup-service-fixture.js';
import {
  confirmedReturn,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

const SHIFT_OPENED = '2026-10-04T09:00:00.000Z';
const CLAIMED = '2026-10-04T10:00:00.000Z';
const FORCE_CLOSED = '2026-10-04T10:30:00.000Z';
const COMPLETED = '2026-10-04T11:00:00.000Z';
const NEXT_SHIFT = '2026-10-04T12:00:00.000Z';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;
let shifts: ServiceHarness;
let shiftRepo: ShiftCashupRepo;

beforeEach(() => {
  h = returnsHarness({ realShifts: true });
  seedSyncedSale(h.db);
  shifts = serviceHarness(h.db, { varianceApprovalThresholdMinor: null });
  shiftRepo = createShiftCashupRepo(h.handle);
  h.state.now = CLAIMED;
});

afterEach(() => {
  h.close();
});

function openShiftAt(clock: string): string {
  shifts.state.clock = clock;
  return shifts.service.openShift({ openingFloatMinor: 10_000 }).shiftId;
}

/** The server told the till a manager closed the shift: the shift's open fact (seq 1) was answered. */
function forceClose(shiftId: string): void {
  expect(
    shiftRepo.recordManagerClosure({ seq: 1, now: FORCE_CLOSED, shiftId, factKind: 'open' }),
  ).toBe(true);
  expect(
    shiftRepo.findOpenShift({ tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' }),
  ).toBeNull();
}

function openRefusal(clock: string): string | null {
  shifts.state.clock = clock;
  try {
    shifts.service.openShift({ openingFloatMinor: 10_000 });
    return null;
  } catch (error) {
    if (error instanceof ShiftCashupRefusedError) return error.reason;
    throw error;
  }
}

function executionShiftRefs(): string[] {
  return h.backend.executionCalls().map((call) => {
    const body = JSON.parse(call.body ?? '{}') as { evidence: { shiftRef: string } };
    return body.evidence.shiftRef;
  });
}

async function reported(): Promise<void> {
  await h.resolver.drain(1_000);
}

describe('a claim that outlives its shift (a manager force-close on the server)', () => {
  it('manual completes it: the execution carries the claim-time shift, then a new shift opens', async () => {
    const shiftId = openShiftAt(SHIFT_OPENED);
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'os_error' });
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'drawer_failed',
    });
    forceClose(shiftId);
    // The deadlock the rule must not create: no shift can open while the claim is unpaid.
    expect(openRefusal(NEXT_SHIFT)).toBe('drawer_activity_pending');

    h.state.now = COMPLETED;
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
      method: 'manual',
    });
    await reported();
    expect(executionShiftRefs()).toEqual([shiftId]);
    expect(h.warnings).not.toContain('returns:execution_no_open_shift');

    expect(openRefusal(NEXT_SHIFT)).toBeNull();
    expect(
      shiftRepo.findOpenShift({ tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' }),
    ).not.toBeNull();
  });

  it('retry_drawer completes it too, as no_drawer, with the claim-time shift', async () => {
    const shiftId = openShiftAt(SHIFT_OPENED);
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    // The till locks between the kick's answer and the commit: the claim stays, nothing is paid.
    h.drawer.onKick = () => {
      h.state.locked = true;
    };
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'refused',
    });
    h.drawer.onKick = null;
    h.state.locked = false;
    forceClose(shiftId);
    expect(openRefusal(NEXT_SHIFT)).toBe('drawer_activity_pending');

    h.state.now = COMPLETED;
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      kind: 'paid_out',
      method: 'no_drawer',
    });
    await reported();
    expect(executionShiftRefs()).toEqual([shiftId]);
    expect(openRefusal(NEXT_SHIFT)).toBeNull();
  });

  it('the force-close during the kick itself is covered: the claim-time shift is still reported', async () => {
    const shiftId = openShiftAt(SHIFT_OPENED);
    const returnId = await confirmedReturn(h.service);
    h.drawer.onKick = () => {
      forceClose(shiftId);
    };
    h.state.now = CLAIMED;
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'paid_out',
      method: 'drawer',
    });
    await reported();
    expect(executionShiftRefs()).toEqual([shiftId]);
  });

  it('a shift open at completion is preferred (the claim-time records are not needed)', async () => {
    const shiftId = openShiftAt(SHIFT_OPENED);
    const returnId = await confirmedReturn(h.service);
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'paid_out',
    });
    await reported();
    expect(executionShiftRefs()).toEqual([shiftId]);
  });
});

describe('a claim made while shift cash-up was off', () => {
  it('completes after the flag is turned on, reports nothing, and a new shift can open', async () => {
    h.state.shiftCashup = false;
    const returnId = await confirmedReturn(h.service);
    expect(h.backend.returnCalls()[0]?.body).not.toContain('allocationRef');
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'os_error' });
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'drawer_failed',
    });
    // The till turns shift cash-up on with the claim still pending, and no shift is open.
    h.state.shiftCashup = true;
    expect(openRefusal(SHIFT_OPENED)).toBe('drawer_activity_pending');

    h.state.now = COMPLETED;
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
      method: 'manual',
    });
    await reported();
    expect(h.backend.executionCalls()).toEqual([]);
    expect(openRefusal(NEXT_SHIFT)).toBeNull();
  });

  it('a claim made with the flag on but before any shift existed reports nothing, with the warning', async () => {
    // Journaled with an allocationRef (flag on), claimed with no shift at all: only possible when
    // the flag was off at the claim, so the claim-time records name no shift.
    const returnId = await confirmedReturn(h.service);
    h.state.shiftCashup = false;
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'os_error' });
    await h.service.payout({ returnId, action: 'start' });
    h.state.shiftCashup = true;
    h.state.now = COMPLETED;
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
    });
    await reported();
    expect(h.backend.executionCalls()).toEqual([]);
    expect(h.warnings).toContain('returns:execution_no_open_shift');
  });
});
