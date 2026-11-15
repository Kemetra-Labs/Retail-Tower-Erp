/**
 * RT-1226 — direct unit tests for the PaymentSurface flow modules and the state
 * hook the split produced. The surface-level suites drive these through the
 * rendered screen; the guards below (no bridge, no attempt, a read that lost
 * its context, a malformed projection, a scan on the settled screen) are not
 * reachable from a normal walk, so each is pinned here against its module.
 * Every expectation is the unsplit surface's behaviour for that guard.
 */
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { ScanGuardHost, resetScanGuardForTests } from '../../../scan/ScanGuardHost.js';
import { SCAN_SALE_COMPLETE_MESSAGE } from '../../../scan/scan-messages.js';
import { useScanNoticeStore } from '../../../scan/scan-notice-store.js';
import { SettledScanOwner } from '../checkout-parts.js';
import { BACK_REFUSED_COPY, type BackControl } from '../payment-surface-logic.js';
import { usePaymentSurfaceState, type SurfaceContext } from '../payment-surface-state.js';
import {
  handleConfirm,
  handleLineApplied,
  readAfterStart,
  rereadAttempt,
  rereadOnResume,
  retryFailedRead,
} from '../surface-settle.js';
import {
  handleBackToSale,
  handleCompleteZero,
  handleTenderSelect,
  sendTenderApply,
} from '../surface-start.js';

type Line = PaymentAttemptRendererView['tender_lines'][number];

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-001',
  operator_session_id: 'sess-001',
  owning_operator_id: 'op-001',
  tenant_id: 'tenant-001',
  branch_id: 'branch-001',
  terminal_id: 'terminal-001',
  lines: [],
  discount_placeholders: [],
  subtotal_minor: 5000,
  created_at: '2026-11-15T09:00:00.000Z',
  handoff_action_id: 'hid-001',
};

function attempt(
  state: PaymentAttemptRendererView['state'],
  lines: Line[] = [],
  id = 'pa-001',
): PaymentAttemptRendererView {
  return {
    payment_attempt_id: id,
    state,
    envelope_subtotal_minor: 5000,
    started_at: '2026-11-15T09:00:30.000Z',
    tender_lines: lines,
  };
}

function cashLine(amount: number, state: Line['state'] = 'applied', id = 'tl-1'): Line {
  return {
    tender_line_id: id,
    tender_type: 'cash',
    state,
    amount_applied_minor: amount,
    applied_at: '2026-11-15T09:01:00.000Z',
    apply_order: 1,
  };
}

interface FakeBridge {
  payments: Record<'start' | 'read' | 'confirm' | 'cancel', ReturnType<typeof vi.fn>>;
  tender: Record<'apply', ReturnType<typeof vi.fn>>;
}

function makeBridge(read: () => Promise<unknown> = () => Promise.resolve(null)): FakeBridge {
  return {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-001' })),
      read: vi.fn(read),
      confirm: vi.fn(() => Promise.resolve({ kind: 'ok', settled_at: '2026-11-15T09:05:00.000Z' })),
      cancel: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    },
    tender: { apply: vi.fn(() => Promise.resolve({ kind: 'ok' })) },
  };
}

/** A render's context: every setter a spy, refs live, the rest from `over`. */
function makeCtx(
  over: Omit<Partial<SurfaceContext>, 'bridge'> & { bridge?: FakeBridge | null } = {},
): SurfaceContext {
  const spy = (): ReturnType<typeof vi.fn> => vi.fn();
  const { bridge, ...rest } = over;
  return {
    bridge: (bridge === undefined ? makeBridge() : bridge) as unknown as SurfaceContext['bridge'],
    sessionState: { kind: 'signedOut' },
    envelope: ENVELOPE,
    paymentSlice: null,
    paymentAttemptId: 'pa-001',
    envelopeHandoffId: 'hid-001',
    cancelHold: 'none',
    cardSafety: null,
    saleFinalizationFlag: true,
    voucherTenderFlag: false,
    cardTenderFlag: false,
    dueMinor: 5000,
    props: {},
    selectedTender: null,
    setSelectedTender: spy(),
    cashDraftMinor: null,
    setCashDraftMinor: spy(),
    phase: 'entry',
    setPhase: spy(),
    arriving: false,
    setArriving: spy(),
    primarySlot: null,
    setPrimarySlot: spy(),
    afterApply: 'idle',
    setAfterApply: spy(),
    readAfter: 'tender',
    setReadAfter: spy(),
    bridgeRefusalCopy: null,
    setBridgeRefusalCopy: spy(),
    isConfirming: false,
    setIsConfirming: spy(),
    isCancelling: false,
    setIsCancelling: spy(),
    isStarting: false,
    setIsStarting: spy(),
    reversalPending: false,
    setReversalPending: spy(),
    confirmCardCancel: false,
    setConfirmCardCancel: spy(),
    isReturning: false,
    setIsReturning: spy(),
    tenderTouched: false,
    setTenderTouched: spy(),
    tenderReversed: false,
    setTenderReversed: spy(),
    commitFocusedAtRef: { current: 0 },
    tileFocusedAtRef: { current: 0 },
    ownCancelRef: { current: null },
    lastHoldRef: { current: 'none' },
    ...rest,
  } as SurfaceContext;
}

function bridgeOf(ctx: SurfaceContext): FakeBridge {
  return ctx.bridge as unknown as FakeBridge;
}

beforeEach(() => {
  usePaymentStore.getState().reset();
  usePaymentStore.getState().mount(ENVELOPE);
  usePaymentStore.getState().applyAttemptSnapshot(attempt('started'));
});

afterEach(() => {
  cleanup();
  usePaymentStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('surface-settle guards', () => {
  it('readAfterStart does nothing without an attempt id', async () => {
    const ctx = makeCtx();
    await readAfterStart(ctx, null);
    expect(bridgeOf(ctx).payments.read).not.toHaveBeenCalled();
    expect(ctx.setAfterApply).not.toHaveBeenCalled();
  });

  it('readAfterStart drops an answer whose payment context moved on', async () => {
    const ctx = makeCtx({
      bridge: makeBridge(() => {
        usePaymentStore.getState().clearAttempt();
        return Promise.resolve({ kind: 'ok', payment_attempt: attempt('started') });
      }),
    });
    await readAfterStart(ctx, 'pa-001');
    expect(ctx.setAfterApply).toHaveBeenCalledTimes(1);
    expect(ctx.setAfterApply).toHaveBeenCalledWith('reading');
  });

  it('readAfterStart follows an attempt main already settled', async () => {
    const ctx = makeCtx({
      bridge: makeBridge(() =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('settled') }),
      ),
    });
    await readAfterStart(ctx, 'pa-001');
    expect(ctx.setBridgeRefusalCopy).toHaveBeenLastCalledWith(null);
    expect(ctx.setPhase).toHaveBeenCalledWith('settled');
  });

  it('rereadOnResume with no projection says nothing was recorded, and drops a stale answer', async () => {
    usePaymentStore.getState().clearAttempt();
    const ctx = makeCtx({
      bridge: makeBridge(() =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('started') }),
      ),
    });
    await rereadOnResume(ctx);
    expect(ctx.setReadAfter).toHaveBeenCalledWith('start');
    expect(ctx.setAfterApply).toHaveBeenCalledTimes(1);
  });

  it('handleLineApplied does nothing without a bridge', async () => {
    const ctx = makeCtx({ bridge: null });
    await handleLineApplied(ctx);
    expect(ctx.setAfterApply).not.toHaveBeenCalled();
  });

  it('handleLineApplied follows an attempt main already settled', async () => {
    const ctx = makeCtx({
      bridge: makeBridge(() =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('settled', [cashLine(5000)]) }),
      ),
    });
    await handleLineApplied(ctx);
    expect(ctx.setPhase).toHaveBeenCalledWith('settled');
  });

  it('handleLineApplied skips refused and unsafe lines when summing (CR-11)', async () => {
    const lines = [
      cashLine(3000),
      cashLine(9000, 'refused', 'tl-2'),
      cashLine(0.5, 'applied', 'tl-3'),
    ];
    const ctx = makeCtx({
      bridge: makeBridge(() =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('started', lines) }),
      ),
    });
    await handleLineApplied(ctx);
    // 3000 < 5000 still owed: back to the tiles.
    expect(ctx.setPhase).toHaveBeenCalledWith('tender_selection');
  });

  it('handleLineApplied keeps the phase when the running sum overflows', async () => {
    const big = Number.MAX_SAFE_INTEGER;
    const lines = [cashLine(big), cashLine(big, 'applied', 'tl-2')];
    const ctx = makeCtx({
      bridge: makeBridge(() =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('started', lines) }),
      ),
    });
    await handleLineApplied(ctx);
    expect(ctx.setPhase).not.toHaveBeenCalled();
    expect(ctx.setSelectedTender).not.toHaveBeenCalled();
  });

  it('rereadAttempt: no bridge, a stale answer and a refusal leave the projection alone', async () => {
    await rereadAttempt(makeCtx({ bridge: null }));

    const moved = makeCtx({
      bridge: makeBridge(() => {
        usePaymentStore.getState().clearAttempt();
        return Promise.resolve({
          kind: 'ok',
          payment_attempt: attempt('started', [cashLine(5000)]),
        });
      }),
    });
    await rereadAttempt(moved);
    expect(usePaymentStore.getState().paymentSlice).toBeNull();

    usePaymentStore.getState().applyAttemptSnapshot(attempt('started'));
    const refused = makeCtx({
      bridge: makeBridge(() => Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' })),
    });
    await rereadAttempt(refused);
    expect(usePaymentStore.getState().paymentSlice?.tender_lines).toEqual([]);
  });

  it('handleConfirm does nothing without a bridge', async () => {
    const ctx = makeCtx({ bridge: null });
    await handleConfirm(ctx);
    expect(ctx.setIsConfirming).not.toHaveBeenCalled();
  });

  it('a confirm for another attempt than the projected one does not rewrite the projection', async () => {
    const ctx = makeCtx({
      bridge: makeBridge(() =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('settled', [], 'pa-other') }),
      ),
    });
    await handleConfirm(ctx, 'pa-other');
    expect(ctx.setPhase).toHaveBeenCalledWith('settled');
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('started');
  });

  it('a lost confirm whose read-back lost its context changes nothing more', async () => {
    const bridge = makeBridge(() => {
      usePaymentStore.getState().clearAttempt();
      return Promise.resolve({ kind: 'ok', payment_attempt: attempt('started') });
    });
    bridge.payments.confirm.mockRejectedValue(new Error('ipc lost'));
    const ctx = makeCtx({ bridge });
    await handleConfirm(ctx);
    expect(ctx.setAfterApply).toHaveBeenCalledTimes(1);
    expect(ctx.setAfterApply).toHaveBeenCalledWith('reading');
  });

  it('retryFailedRead after a confirm keeps no reason pending for another attempt', async () => {
    usePaymentStore
      .getState()
      .setConfirmReadPending({ attemptId: 'pa-other', reason: 'attempt_terminal' });
    const ctx = makeCtx({
      readAfter: 'confirm',
      bridge: makeBridge(() =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('started') }),
      ),
    });
    retryFailedRead(ctx);
    await act(async () => {
      await Promise.resolve();
    });
    // Reason null: a still-open attempt with money owed gets the generic confirm copy.
    expect(usePaymentStore.getState().confirmReadPending).toBeNull();
    expect(ctx.setReadAfter).toHaveBeenCalledWith('confirm');
  });
});

describe('surface-start guards', () => {
  const back = (enabled: boolean): BackControl =>
    ({ enabled, offered: true }) as unknown as BackControl;

  it('Back does nothing while disabled', async () => {
    const onBackToSale = vi.fn(() => Promise.resolve(true));
    const ctx = makeCtx({ props: { onBackToSale } });
    await handleBackToSale(ctx, back(false));
    expect(onBackToSale).not.toHaveBeenCalled();
  });

  it('a Back call that throws is a refusal: the cashier stays, with the reason', async () => {
    const ctx = makeCtx({ props: { onBackToSale: () => Promise.reject(new Error('ipc lost')) } });
    await handleBackToSale(ctx, back(true));
    expect(ctx.setIsReturning).toHaveBeenLastCalledWith(false);
    expect(ctx.setBridgeRefusalCopy).toHaveBeenLastCalledWith(BACK_REFUSED_COPY);
  });

  it('a card selection with the card flag off starts nothing (RT-700)', async () => {
    const ctx = makeCtx({ paymentAttemptId: null });
    await handleTenderSelect(ctx, 'external_card_terminal');
    expect(ctx.setSelectedTender).not.toHaveBeenCalled();
    expect(bridgeOf(ctx).payments.start).not.toHaveBeenCalled();
  });

  it('«إتمام البيع» does nothing without a bridge or while a start is in flight', async () => {
    const noBridge = makeCtx({ bridge: null, dueMinor: 0 });
    await handleCompleteZero(noBridge);
    expect(noBridge.setBridgeRefusalCopy).not.toHaveBeenCalled();

    const starting = makeCtx({ isStarting: true, dueMinor: 0 });
    await handleCompleteZero(starting);
    expect(bridgeOf(starting).payments.start).not.toHaveBeenCalled();
  });

  it('«إتمام البيع» with no envelope starts nothing', async () => {
    const ctx = makeCtx({ envelope: null, paymentAttemptId: null, dueMinor: 0 });
    await handleCompleteZero(ctx);
    expect(bridgeOf(ctx).payments.start).not.toHaveBeenCalled();
    expect(bridgeOf(ctx).payments.confirm).not.toHaveBeenCalled();
  });

  it('a tender apply with no bridge is rejected and records nothing', async () => {
    const ctx = makeCtx({ bridge: null });
    await expect(
      sendTenderApply(ctx, {
        payment_attempt_id: 'pa-001',
        tender_type: 'cash',
        amount_applied_minor: 100,
        idempotency_key: 'k',
      }),
    ).rejects.toThrow('no payment bridge');
    expect(usePaymentStore.getState().tenderSentAttemptId).toBeNull();
  });
});

describe('usePaymentSurfaceState', () => {
  it('with no envelope: no handoff, no attempt, nothing due', () => {
    usePaymentStore.getState().reset();
    const { result } = renderHook(() => usePaymentSurfaceState({}));
    expect(result.current.envelopeHandoffId).toBeNull();
    expect(result.current.paymentAttemptId).toBeNull();
    expect(result.current.dueMinor).toBe(0);
  });

  it('an unreadable amount due falls back to the gross subtotal (main then refuses it)', () => {
    usePaymentStore.getState().reset();
    usePaymentStore.getState().mount({ ...ENVELOPE, total_due_minor: -1 });
    const { result } = renderHook(() => usePaymentSurfaceState({}));
    expect(result.current.dueMinor).toBe(5000);
  });
});

describe('SettledScanOwner (RT-239, M-S7)', () => {
  it('a scan on the settled screen starts nothing and says the sale is complete', () => {
    resetScanGuardForTests();
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    render(
      <>
        <ScanGuardHost />
        <SettledScanOwner />
      </>,
    );
    for (const key of '6221234567890') fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(useScanNoticeStore.getState().message).toBe(SCAN_SALE_COMPLETE_MESSAGE);
    resetScanGuardForTests();
  });
});
