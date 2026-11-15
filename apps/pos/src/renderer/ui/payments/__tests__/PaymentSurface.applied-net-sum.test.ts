/**
 * RT-1409 (defect 1) — the renderer's applied sum is net of change, like main's.
 *
 * Main counts a line as `amount_applied_minor - (change_due_minor ?? 0)`
 * (`tender-line-fsm.ts`, and the same expression in the tender-lines
 * repository). A cash line takes the received amount, so its gross figure
 * overstates what the sale has covered whenever change was due. These pin the
 * three renderer sums to main's: the remaining balance, the split-tender
 * return to the tiles, and the "money still due" copy decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { moneyStillDue } from '../payment-read-copy.js';
import type { SurfaceContext } from '../payment-surface-state.js';
import { handleLineApplied } from '../surface-settle.js';
import { deriveSurfaceView } from '../surface-view.js';

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
  subtotal_minor: 100,
  created_at: '2026-11-15T09:00:00.000Z',
  handoff_action_id: 'hid-001',
};

function line(
  id: string,
  type: Line['tender_type'],
  amount: number,
  change?: number,
  state: Line['state'] = 'applied',
): Line {
  return {
    tender_line_id: id,
    tender_type: type,
    state,
    amount_applied_minor: amount,
    ...(change === undefined ? {} : { change_due_minor: change }),
    applied_at: '2026-11-15T09:01:00.000Z',
    apply_order: 1,
  };
}

function attempt(
  state: PaymentAttemptRendererView['state'],
  lines: Line[],
): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-001',
    state,
    envelope_subtotal_minor: 100,
    started_at: '2026-11-15T09:00:30.000Z',
    tender_lines: lines,
  };
}

/** The slice of the render's context `deriveSurfaceView` reads. */
function viewCtx(lines: Line[]): SurfaceContext {
  return {
    bridge: null,
    paymentSlice: attempt('started', lines),
    paymentAttemptId: 'pa-001',
    dueMinor: 100,
    phase: 'tender_selection',
    afterApply: 'idle',
    selectedTender: null,
    cashDraftMinor: null,
    bridgeRefusalCopy: null,
    isStarting: false,
  } as unknown as SurfaceContext;
}

/** A render's context for `handleLineApplied`: setters are spies, main answers `answer`. */
function settleCtx(answer: PaymentAttemptRendererView): SurfaceContext {
  const spy = (): ReturnType<typeof vi.fn> => vi.fn();
  return {
    bridge: {
      payments: {
        read: vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt: answer })),
      },
    },
    envelope: ENVELOPE,
    paymentAttemptId: 'pa-001',
    envelopeHandoffId: 'hid-001',
    dueMinor: 100,
    setAfterApply: spy(),
    setPhase: spy(),
    setSelectedTender: spy(),
    setReadAfter: spy(),
    setBridgeRefusalCopy: spy(),
  } as unknown as SurfaceContext;
}

beforeEach(() => {
  usePaymentStore.getState().reset();
  usePaymentStore.getState().mount(ENVELOPE);
  usePaymentStore.getState().applyAttemptSnapshot(attempt('started', []));
});

afterEach(() => {
  usePaymentStore.getState().reset();
  vi.restoreAllMocks();
});

describe('RT-1409 — remaining balance is net of change (surface-view)', () => {
  it('shows what main still requires after a voucher was reversed on its own', () => {
    // Due 100. The voucher (80) was applied, then reversed alone, so it is no longer
    // an applied line. The cash (50, change 30) was applied while only 20 was still
    // owed, so it covers 20, not 50: main still requires 80.
    const view = deriveSurfaceView(
      viewCtx([
        line('tl-v', 'internal_voucher', 80, undefined, 'reversed'),
        line('tl-c', 'cash', 50, 30),
      ]),
      false,
      false,
    );
    expect(view.remainingBalanceMinor).toBe(80);
    expect(view.fullyTendered).toBe(false);
  });

  it('does not call the sale covered while cash with change leaves a part owed', () => {
    // Cash 120 with change 30 covers 90 of 100; gross 120 would read as fully paid.
    const view = deriveSurfaceView(viewCtx([line('tl-c', 'cash', 120, 30)]), false, false);
    expect(view.remainingBalanceMinor).toBe(10);
    expect(view.fullyTendered).toBe(false);
  });

  it('counts a line with no change in full, beside a cash line with change', () => {
    const view = deriveSurfaceView(
      viewCtx([line('tl-v', 'internal_voucher', 80), line('tl-c', 'cash', 50, 30)]),
      false,
      false,
    );
    expect(view.remainingBalanceMinor).toBe(0);
    expect(view.fullyTendered).toBe(true);
  });

  it('skips a line whose change is not a safe integer instead of counting it (CR-11)', () => {
    // A float-tainted change would otherwise taint the whole sum; the line is left out,
    // so more is shown as owed, never less.
    const view = deriveSurfaceView(
      viewCtx([line('tl-v', 'internal_voucher', 40), line('tl-c', 'cash', 120, 0.5)]),
      false,
      false,
    );
    expect(view.remainingBalanceMinor).toBe(60);
    expect(view.fullyTendered).toBe(false);
  });
});

describe('RT-1409 — the split-tender return to the tiles is net of change (handleLineApplied)', () => {
  it('returns to the tiles when cash with change covers less than the due', async () => {
    // Gross 120 >= 100 would leave the surface on the settle commit; net is 90.
    const ctx = settleCtx(attempt('started', [line('tl-c', 'cash', 120, 30)]));
    await handleLineApplied(ctx);
    expect(ctx.setPhase).toHaveBeenCalledWith('tender_selection');
  });

  it('stays put when the net applied sum covers the due exactly', async () => {
    const ctx = settleCtx(attempt('started', [line('tl-c', 'cash', 130, 30)]));
    await handleLineApplied(ctx);
    expect(ctx.setPhase).not.toHaveBeenCalled();
  });
});

describe('RT-1409 — "money still due" is net of change (moneyStillDue)', () => {
  it('is due when cash with change covers less than the subtotal', () => {
    expect(moneyStillDue(attempt('started', [line('tl-c', 'cash', 120, 30)]))).toBe(true);
  });

  it('is not due once the net applied sum covers the subtotal', () => {
    expect(moneyStillDue(attempt('started', [line('tl-c', 'cash', 130, 30)]))).toBe(false);
  });
});
