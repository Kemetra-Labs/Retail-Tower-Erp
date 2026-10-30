/**
 * RT-998 (RT-253 / RT-276, owner decision 2026-10-30) — cash tender requires an
 * open shift, refused in main.
 *
 * A cash sale finalized while no shift is open falls outside every shift
 * window, so no Expected Cash includes it and it shows as an unexplained
 * positive variance at the next close. With `POS_PULSE_FEATURE_SHIFT_CASHUP`
 * on and no open shift on the attempt's terminal, a `tender.apply` for `cash`
 * is refused `shift_not_open` before the FSM: no tender line, no outbox row.
 * `payments.confirm` re-checks for an attempt that holds an applied cash line,
 * so a shift closed between the apply and the settle cannot settle cash outside
 * a window either. Card, voucher and zero-cash settles are not gated.
 *
 * The calls go through the registered `tender.apply` / `payments.confirm` IPC
 * channels over the real handlers, FSMs, repositories, idempotency helper and
 * shift repo on an in-memory SQLite database with every migration applied.
 */

import { describe, expect, it } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import {
  bindCashShiftGate,
  type CashShiftGate,
} from '../../../../src/main/payments/cash-shift-gate.js';
import { registerPaymentsHandlers } from '../../../../src/main/ipc/payments.js';
import {
  createShiftCashupRepo,
  type ShiftScope,
} from '../../../../src/main/shift-cashup/shift-cashup-repo.js';
import {
  PAYMENTS_IPC_CHANNELS,
  TENDER_IPC_CHANNELS,
} from '../../../../src/shared/payments/channels.js';
import type {
  PaymentsConfirmResponse,
  PaymentsStartResponse,
  TenderApplyResponse,
} from '../../../../src/shared/bridge-api.js';
import { makeAuditEmitterDouble, makeSession } from './__fixtures__/bridge-handler-deps.js';
import { bindRealPaymentsCore, freshMigratedDbPerTest } from './__fixtures__/real-payments-core.js';
import { realSettlementDeps } from './__fixtures__/real-settlement-deps.js';

const currentDb = freshMigratedDbPerTest();

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const SCOPE: ShiftScope = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'terminal-1' };
const OTHER_TERMINAL: ShiftScope = { ...SCOPE, terminalId: 'terminal-2' };
const SHIFT_ID = '0192f5a2-3b4c-7d8e-9f01-000000000001';
const OTHER_SHIFT_ID = '0192f5a2-3b4c-7d8e-9f01-000000000002';
const USER_ID = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const NOW = '2026-10-30T08:00:01.000Z';

/** `shiftCashup` is read on every call, as `index.ts` re-reads the env. */
function build(flag: { shiftCashup: boolean }, gate?: CashShiftGate) {
  const core = bindRealPaymentsCore(currentDb());
  const { attempts, lines, outbox, tenderLineFsm, paymentAttemptFsm, idempotency } = core;
  const shiftRepo = createShiftCashupRepo(core.handle);
  const auditEmitter = makeAuditEmitterDouble();
  const cashShiftGate = gate ?? bindCashShiftGate(core.handle, () => flag.shiftCashup);
  let n = 0;
  const shared = {
    getCurrentSession: () => makeSession(),
    attemptsRepo: attempts,
    idempotency,
    auditEmitter,
    clock: (): Date => new Date('2026-10-30T10:00:00.000Z'),
    uuid: (): string => `uuid-${String(++n)}`,
  };
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  const unused = (): Promise<never> => Promise.reject(new Error('not under test'));
  registerPaymentsHandlers(ipcMain, {
    paymentsStart: createPaymentsStartHandler({
      ...shared,
      paymentAttemptFsm,
      checkCartForPayment: () => ({ kind: 'ok' }),
      attemptHasLiveTender: () => false,
    }),
    tenderApply: createTenderApplyHandler({
      ...shared,
      linesRepo: lines,
      tenderLineFsm,
      cashShiftGate,
      isCardTenderEnabled: () => true,
    }),
    paymentsConfirm: createPaymentsConfirmHandler({
      ...shared,
      linesRepo: lines,
      paymentAttemptFsm,
      cashShiftGate,
      ...realSettlementDeps({ db: core.handle, paymentAttemptFsm, attempts, lines, auditEmitter }),
    }),
    paymentsCancel: unused,
    paymentsSubscribe: unused,
    paymentsRead: unused,
    tenderReverse: unused,
    tenderRead: unused,
  });
  const invoke = (channel: string, request: unknown): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (fn === undefined) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(fn({} as IpcMainInvokeEvent, request));
  };
  return {
    auditEmitter,
    attempts,
    lines,
    outbox,
    shiftRepo,
    openShift: (scope: ShiftScope = SCOPE, shiftId = SHIFT_ID): void => {
      shiftRepo.recordOpen({
        scope,
        now: NOW,
        fact: {
          shiftId,
          openedAt: '2026-10-30T08:00:00.000Z',
          openingUserId: USER_ID,
          currencyCode: 'EGP',
          openingFloatMinor: 50_000,
        },
      });
    },
    start: (cart = 'cart-1') =>
      invoke(PAYMENTS_IPC_CHANNELS.START, {
        envelope_handoff_action_id: `handoff-${cart}`,
        envelope_cart_id: cart,
        envelope_subtotal_minor: 1500,
        envelope_version: 'v1',
        idempotency_key: `k-start-${cart}`,
      }) as Promise<PaymentsStartResponse>,
    apply: (request: Record<string, unknown>) =>
      invoke(TENDER_IPC_CHANNELS.APPLY, request) as Promise<TenderApplyResponse>,
    confirm: (attempt: string, key = 'k-confirm') =>
      invoke(PAYMENTS_IPC_CHANNELS.CONFIRM, {
        payment_attempt_id: attempt,
        idempotency_key: key,
      }) as Promise<PaymentsConfirmResponse>,
  };
}

type Stack = ReturnType<typeof build>;

async function startAttempt(s: Stack): Promise<string> {
  const r = await s.start();
  if (r.kind !== 'ok') throw new Error(`start refused: ${r.reason}`);
  return r.payment_attempt_id;
}

function cashRequest(attempt: string, key = 'k-cash') {
  return {
    payment_attempt_id: attempt,
    tender_type: 'cash',
    amount_applied_minor: 2000,
    idempotency_key: key,
  };
}

describe('RT-998 — shift cash-up on, no open shift: main refuses a cash tender', () => {
  it('a direct IPC tender.apply for cash is refused shift_not_open', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    expect(await s.apply(cashRequest(attempt))).toEqual({
      kind: 'refused',
      reason: 'shift_not_open',
    });
  });

  it('persists nothing on the refusal: no tender line and no outbox row', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    await s.apply(cashRequest(attempt));
    expect(s.lines.findByAttempt(attempt)).toEqual([]);
    expect(s.outbox.findByActionId('k-cash')).toBeUndefined();
    expect(s.attempts.findById(attempt)?.state).toBe('started');
  });

  it('audits the refusal as tender.refused with the typed reason', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    await s.apply(cashRequest(attempt));
    const refused = s.auditEmitter.captured.filter((e) => e.action_category === 'tender.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      payment_attempt_id: attempt,
      payload: { tender_type: 'cash', refusal_reason: 'shift_not_open' },
    });
  });

  it('is refused again on a retry with the same key; nothing is ever recorded', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    await s.apply(cashRequest(attempt));
    expect(await s.apply(cashRequest(attempt))).toEqual({
      kind: 'refused',
      reason: 'shift_not_open',
    });
    expect(s.lines.findByAttempt(attempt)).toEqual([]);
  });

  it('a shift open on ANOTHER terminal does not allow this terminal to tender cash', async () => {
    const s = build({ shiftCashup: true });
    s.openShift(OTHER_TERMINAL);
    const attempt = await startAttempt(s);
    expect(await s.apply(cashRequest(attempt))).toEqual({
      kind: 'refused',
      reason: 'shift_not_open',
    });
  });

  it('the session gate still runs first: no session answers no_session, not shift_not_open', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    const core = bindRealPaymentsCore(currentDb());
    const noSession = createTenderApplyHandler({
      getCurrentSession: () => null,
      attemptsRepo: core.attempts,
      linesRepo: core.lines,
      tenderLineFsm: core.tenderLineFsm,
      idempotency: core.idempotency,
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'u',
      clock: () => new Date(),
      cashShiftGate: () => 'shift_required',
    });
    expect(await noSession(cashRequest(attempt))).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
  });
});

describe('RT-998 — the same cart can be tendered once the shift is open', () => {
  it('refuses, then the shift opens, then the same request (same key) applies and settles', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    const request = cashRequest(attempt);

    expect(await s.apply(request)).toEqual({ kind: 'refused', reason: 'shift_not_open' });

    s.openShift();

    const applied = await s.apply(request);
    expect(applied).toMatchObject({ kind: 'ok', change_due_minor: 500 });
    expect(s.lines.findByAttempt(attempt)).toHaveLength(1);

    const settled = await s.confirm(attempt);
    expect(settled.kind).toBe('ok');
    expect(s.attempts.findById(attempt)?.state).toBe('settled');
  });
});

describe('RT-998 — settle-time re-check', () => {
  it('refuses payments.confirm for an attempt holding applied cash once the shift is gone; it stays started', async () => {
    const open = { value: true };
    const s = build({ shiftCashup: true }, () => (open.value ? 'ok' : 'shift_required'));
    const attempt = await startAttempt(s);
    expect((await s.apply(cashRequest(attempt))).kind).toBe('ok');

    open.value = false;
    expect(await s.confirm(attempt)).toEqual({ kind: 'refused', reason: 'shift_not_open' });
    expect(s.attempts.findById(attempt)?.state).toBe('started');
    expect(s.lines.findByAttempt(attempt)).toHaveLength(1);

    open.value = true;
    expect((await s.confirm(attempt, 'k-confirm-2')).kind).toBe('ok');
    expect(s.attempts.findById(attempt)?.state).toBe('settled');
  });

  it('a same-key replay of an apply answers the recorded line even after the shift is gone', async () => {
    const open = { value: true };
    const s = build({ shiftCashup: true }, () => (open.value ? 'ok' : 'shift_required'));
    const attempt = await startAttempt(s);
    const first = await s.apply(cashRequest(attempt));
    open.value = false;
    expect(await s.apply(cashRequest(attempt))).toEqual(first);
    expect(s.lines.findByAttempt(attempt)).toHaveLength(1);
  });

  it('does not gate a confirm that holds no cash line (the refusal is the underpaid one, not the shift one)', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    expect(await s.confirm(attempt)).toEqual({ kind: 'refused', reason: 'tender_underpaid' });
  });
});

describe('RT-998 — other tenders and the flag', () => {
  it('flag off: cash applies with no shift (no shift can exist, so nothing can be required)', async () => {
    const s = build({ shiftCashup: false });
    const attempt = await startAttempt(s);
    expect(await s.apply(cashRequest(attempt))).toMatchObject({ kind: 'ok' });
  });

  it('flag off: confirm settles cash with no shift', async () => {
    const s = build({ shiftCashup: false });
    const attempt = await startAttempt(s);
    await s.apply(cashRequest(attempt));
    expect((await s.confirm(attempt)).kind).toBe('ok');
  });

  it('a card tender is not gated by the shift check (out of scope: the pilot is cash only)', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    const r = await s.apply({
      payment_attempt_id: attempt,
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1500,
      external_reference: 'A1B2C3',
      idempotency_key: 'k-card',
    });
    expect(r.kind).toBe('ok');
  });

  it('with no gate wired the handler does not gate (flag-off semantics; production always wires it)', async () => {
    const core = bindRealPaymentsCore(currentDb());
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    const ungated = createTenderApplyHandler({
      getCurrentSession: () => makeSession(),
      attemptsRepo: core.attempts,
      linesRepo: core.lines,
      tenderLineFsm: core.tenderLineFsm,
      idempotency: core.idempotency,
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'uuid-ungated',
      clock: () => new Date('2026-10-30T10:00:00.000Z'),
    });
    expect(await ungated(cashRequest(attempt, 'k-ungated'))).toMatchObject({ kind: 'ok' });
  });
});

describe('RT-998 — the gate reads the shift of the attempt terminal', () => {
  it('allows once a shift is open on that terminal, and again after another shift id', async () => {
    const s = build({ shiftCashup: true });
    const attempt = await startAttempt(s);
    expect((await s.apply(cashRequest(attempt))).kind).toBe('refused');
    s.openShift(SCOPE, OTHER_SHIFT_ID);
    expect((await s.apply(cashRequest(attempt))).kind).toBe('ok');
  });
});
