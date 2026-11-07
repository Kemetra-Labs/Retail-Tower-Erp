/**
 * RT-1220 — direct tests for the pure PaymentSurface helpers. Until RT-1220
 * they were reachable only through the rendered surface; these pin every
 * branch so the RT-1226 stage split can move the component freely.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { TenderLineRendererView } from '../../../../shared/payments/types.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import {
  BACK_REASON_COPY,
  CANCEL_HOLD_COPY,
  CANCEL_LIVE_TENDER_COPY,
  CANCEL_UNKNOWN_COPY,
  COMPLETION_TEST_IDS,
  FIRST_ENABLED_TENDER_TILE,
  LEDGER_TEST_IDS,
  LIVE_TENDER_STATES,
  RECOVERY_TEST_IDS,
  TENDER_SELECTED_COPY,
  backReason,
  backReasonTone,
  cancelNeedsTerminalVoid,
  cancelOutcomeFromRead,
  cancelProvesReversal,
  cancelTouchedCard,
  commitReasonCopy,
  deriveBackControl,
  holdFor,
  isEscapePress,
  isOpenCheckout,
  isResumable,
  isTenderBlocked,
  resolveBridge,
  resumePhase,
} from '../payment-surface-logic.js';

type BackInput = Parameters<typeof deriveBackControl>[0];

function backInput(overrides: Partial<BackInput> = {}): BackInput {
  return {
    wired: true,
    onOpenCheckout: true,
    eligibility: 'returnable',
    projectedTenderLines: undefined,
    tenderTouched: false,
    tenderReversed: false,
    cardVoidRequired: false,
    busy: false,
    entryOpen: false,
    ...overrides,
  };
}

function line(
  id: string,
  tender_type: TenderLineRendererView['tender_type'],
  state: TenderLineRendererView['state'],
  apply_order: number,
): TenderLineRendererView {
  return { tender_line_id: id, tender_type, state, apply_order, amount_applied_minor: 100 };
}

const NO_CARD = { appliedLineIds: new Set<string>(), attempted: false } as const;

describe('deriveBackControl (RT-26 / RT-240)', () => {
  it('offers and enables Back on a returnable, idle, tender-free checkout', () => {
    expect(deriveBackControl(backInput())).toEqual({
      offered: true,
      tenderBlocked: false,
      enabled: true,
      reason: null,
      showReason: false,
      ariaDisabled: undefined,
    });
  });

  it('is not offered when unwired or not on an open checkout, and gives no reason', () => {
    for (const input of [backInput({ wired: false }), backInput({ onOpenCheckout: false })]) {
      const back = deriveBackControl({ ...input, projectedTenderLines: 2 });
      expect(back.offered).toBe(false);
      expect(back.enabled).toBe(false);
      expect(back.reason).toBeNull();
      expect(back.showReason).toBe(false);
      expect(back.ariaDisabled).toBe('true');
    }
  });

  it('stays disabled while eligibility is unknown (no reason line)', () => {
    const back = deriveBackControl(backInput({ eligibility: 'unknown' }));
    expect(back.enabled).toBe(false);
    expect(back.reason).toBeNull();
    expect(back.ariaDisabled).toBe('true');
  });

  it('is disabled while busy, with no reason line', () => {
    const back = deriveBackControl(backInput({ busy: true }));
    expect(back.enabled).toBe(false);
    expect(back.showReason).toBe(false);
  });

  it('is disabled with the entry_open reason while an entry panel is open', () => {
    const back = deriveBackControl(backInput({ entryOpen: true }));
    expect(back.enabled).toBe(false);
    expect(back.reason).toBe('entry_open');
    expect(back.showReason).toBe(true);
  });

  it('is blocked by projected tender lines (recorded)', () => {
    const back = deriveBackControl(backInput({ projectedTenderLines: 1 }));
    expect(back.tenderBlocked).toBe(true);
    expect(back.enabled).toBe(false);
    expect(back.reason).toBe('recorded');
  });

  it("is blocked by main's durable `blocked` eligibility (neutral reason)", () => {
    const back = deriveBackControl(backInput({ eligibility: 'blocked' }));
    expect(back.tenderBlocked).toBe(true);
    expect(back.reason).toBe('blocked');
  });
});

describe('isTenderBlocked', () => {
  it('is false with no tender sign and a non-blocked eligibility', () => {
    expect(isTenderBlocked(backInput())).toBe(false);
    expect(isTenderBlocked(backInput({ projectedTenderLines: 0, eligibility: 'unknown' }))).toBe(
      false,
    );
  });

  it('is true for projected lines, a reversing cancel, or main saying blocked', () => {
    expect(isTenderBlocked(backInput({ projectedTenderLines: 3 }))).toBe(true);
    expect(isTenderBlocked(backInput({ tenderTouched: true }))).toBe(true);
    expect(isTenderBlocked(backInput({ eligibility: 'blocked' }))).toBe(true);
  });
});

describe('backReason — precedence (M-P13 first)', () => {
  it('card_void wins over everything, recorded included', () => {
    const input = backInput({
      cardVoidRequired: true,
      projectedTenderLines: 2,
      tenderReversed: true,
      entryOpen: true,
    });
    expect(backReason(input, true)).toBe('card_void');
  });

  it('recorded wins over reversed, blocked and entry_open', () => {
    const input = backInput({ projectedTenderLines: 1, tenderReversed: true, entryOpen: true });
    expect(backReason(input, true)).toBe('recorded');
  });

  it('reversed wins over blocked and entry_open', () => {
    expect(backReason(backInput({ tenderReversed: true, entryOpen: true }), true)).toBe('reversed');
  });

  it('blocked wins over entry_open', () => {
    expect(backReason(backInput({ entryOpen: true }), true)).toBe('blocked');
  });

  it('entry_open, then null', () => {
    expect(backReason(backInput({ entryOpen: true }), false)).toBe('entry_open');
    expect(backReason(backInput(), false)).toBeNull();
  });
});

describe('backReasonTone and BACK_REASON_COPY', () => {
  it('maps card_void → danger, entry_open → neutral, the rest → info', () => {
    expect(backReasonTone('card_void')).toBe('danger');
    expect(backReasonTone('entry_open')).toBe('neutral');
    expect(backReasonTone('recorded')).toBe('info');
    expect(backReasonTone('reversed')).toBe('info');
    expect(backReasonTone('blocked')).toBe('info');
  });

  it('keeps the catalogue copy for every reason', () => {
    expect(BACK_REASON_COPY).toEqual({
      recorded: 'لا يمكن الرجوع إلى البيع بعد تسجيل مبلغ. أكمل الدفع أو ألغِه.',
      reversed: 'أُلغي المبلغ المسجَّل. اختر طريقة دفع أخرى أو ألغِ البيع.',
      blocked: 'تعذّر الرجوع إلى البيع. أكمل الدفع أو ألغِه.',
      entry_open: 'اضغط Esc لإغلاق إدخال المبلغ أولاً.',
      card_void: 'أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.',
    });
  });
});

describe('cancelProvesReversal (M-P2)', () => {
  const lines = [
    line('c1', 'cash', 'reversed', 1),
    line('k1', 'external_card_terminal', 'reversed', 2),
  ];

  it('is false when nothing was reversed', () => {
    const r = { reversed_tender_line_ids: [], reversal_pending_tender_line_ids: [] };
    expect(cancelProvesReversal(r, lines)).toBe(false);
  });

  it('is false while any reversal is pending', () => {
    const r = { reversed_tender_line_ids: ['c1'], reversal_pending_tender_line_ids: ['x'] };
    expect(cancelProvesReversal(r, lines)).toBe(false);
  });

  it('is true when every reversed line is cash', () => {
    const r = { reversed_tender_line_ids: ['c1'], reversal_pending_tender_line_ids: [] };
    expect(cancelProvesReversal(r, lines)).toBe(true);
  });

  it('is false when a reversed line is not cash, or is unknown to the projection', () => {
    const card = { reversed_tender_line_ids: ['c1', 'k1'], reversal_pending_tender_line_ids: [] };
    expect(cancelProvesReversal(card, lines)).toBe(false);
    const unknown = { reversed_tender_line_ids: ['zz'], reversal_pending_tender_line_ids: [] };
    expect(cancelProvesReversal(unknown, lines)).toBe(false);
  });
});

describe('cancelTouchedCard / cancelNeedsTerminalVoid (RT-256)', () => {
  const lines = [
    line('c1', 'cash', 'reversed', 1),
    line('k1', 'external_card_terminal', 'reversed', 2),
  ];

  it('sees a reversed card line from the projection', () => {
    const r = { reversed_tender_line_ids: ['k1'], reversal_pending_tender_line_ids: [] };
    expect(cancelTouchedCard(r, lines, new Set())).toBe(true);
  });

  it('sees a pending card line from the applies seen in this Checkout', () => {
    const r = { reversed_tender_line_ids: [], reversal_pending_tender_line_ids: ['k9'] };
    expect(cancelTouchedCard(r, [], new Set(['k9']))).toBe(true);
  });

  it('is false when only cash was touched', () => {
    const r = { reversed_tender_line_ids: ['c1'], reversal_pending_tender_line_ids: [] };
    expect(cancelTouchedCard(r, lines, new Set())).toBe(false);
  });

  it('needs the terminal-void warning on any card attempt, even with zero lines', () => {
    const r = { reversed_tender_line_ids: [], reversal_pending_tender_line_ids: [] };
    expect(cancelNeedsTerminalVoid(r, [], { appliedLineIds: new Set(), attempted: true })).toBe(
      true,
    );
    expect(cancelNeedsTerminalVoid(r, [], NO_CARD)).toBe(false);
  });

  it('needs it when the cancel touched a card line without a recorded attempt', () => {
    const r = { reversed_tender_line_ids: ['k1'], reversal_pending_tender_line_ids: [] };
    expect(cancelNeedsTerminalVoid(r, lines, NO_CARD)).toBe(true);
  });
});

describe('cancelOutcomeFromRead (RT-298)', () => {
  it('rebuilds reversed and pending ids in LIFO apply order, ignoring other states', () => {
    const outcome = cancelOutcomeFromRead({
      payment_attempt_id: 'pa',
      state: 'cancelled',
      envelope_subtotal_minor: 500,
      started_at: '2026-11-06T00:00:00Z',
      tender_lines: [
        line('a', 'cash', 'reversed', 1),
        line('b', 'cash', 'reversal_pending', 2),
        line('c', 'cash', 'reversed', 3),
        line('d', 'cash', 'refused', 4),
        line('e', 'external_card_terminal', 'reversal_pending', 5),
      ],
    });
    expect(outcome).toEqual({
      reversed_tender_line_ids: ['c', 'a'],
      reversal_pending_tender_line_ids: ['e', 'b'],
    });
  });

  it('is empty for an attempt with no lines', () => {
    expect(
      cancelOutcomeFromRead({
        payment_attempt_id: 'pa',
        state: 'cancelled',
        envelope_subtotal_minor: 0,
        started_at: '2026-11-06T00:00:00Z',
        tender_lines: [],
      }),
    ).toEqual({ reversed_tender_line_ids: [], reversal_pending_tender_line_ids: [] });
  });
});

describe('cancel hold (RT-298)', () => {
  it('CANCEL_HOLD_COPY: none shows nothing; in_flight and unconfirmed share the unknown copy', () => {
    expect(CANCEL_HOLD_COPY.none).toBeNull();
    expect(CANCEL_HOLD_COPY.in_flight).toBe(CANCEL_UNKNOWN_COPY);
    expect(CANCEL_HOLD_COPY.unconfirmed).toBe(CANCEL_UNKNOWN_COPY);
    expect(CANCEL_HOLD_COPY.live_tender).toBe(CANCEL_LIVE_TENDER_COPY);
  });

  it('isResumable: started and settled always; force_failed only with a live_tender hold', () => {
    expect(isResumable('started', 'none')).toBe(true);
    expect(isResumable('settled', 'none')).toBe(true);
    expect(isResumable('force_failed', 'live_tender')).toBe(true);
    expect(isResumable('force_failed', 'none')).toBe(false);
    expect(isResumable('cancelled', 'live_tender')).toBe(false);
    expect(isResumable(undefined, 'none')).toBe(false);
  });

  it('resumePhase: settled, an unconfirmed or in-flight cancel reopens on entry, else tiles', () => {
    expect(resumePhase('settled', 'unconfirmed')).toBe('settled');
    expect(resumePhase('started', 'unconfirmed')).toBe('entry');
    expect(resumePhase('started', 'in_flight')).toBe('entry');
    expect(resumePhase('started', 'none')).toBe('tender_selection');
    expect(resumePhase('force_failed', 'live_tender')).toBe('tender_selection');
  });

  it('holdFor: only the recovery for this handoff and attempt counts', () => {
    const recovery = { handoffId: 'h1', attemptId: 'a1', key: 'k', hold: 'unconfirmed' } as const;
    expect(holdFor(null, 'h1', 'a1')).toBe('none');
    expect(holdFor(recovery, 'h1', 'a1')).toBe('unconfirmed');
    expect(holdFor(recovery, 'h2', 'a1')).toBe('none');
    expect(holdFor(recovery, 'h1', 'a2')).toBe('none');
    expect(holdFor(recovery, null, null)).toBe('none');
  });

  it('LIVE_TENDER_STATES holds applying, applied and reversal_pending only', () => {
    expect([...LIVE_TENDER_STATES].sort()).toEqual(['applied', 'applying', 'reversal_pending']);
  });
});

describe('isOpenCheckout', () => {
  it('needs a signed-in session, an envelope, and a phase other than settled', () => {
    expect(isOpenCheckout('signedIn', true, 'tender_selection')).toBe(true);
    expect(isOpenCheckout('signedIn', true, 'entry')).toBe(true);
    expect(isOpenCheckout('signedIn', true, 'settled')).toBe(false);
    expect(isOpenCheckout('signedIn', false, 'entry')).toBe(false);
    expect(isOpenCheckout('signedOut', true, 'entry')).toBe(false);
  });
});

describe('isEscapePress', () => {
  it('accepts only a fresh, unhandled Escape', () => {
    expect(isEscapePress(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(isEscapePress(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
    expect(isEscapePress(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }))).toBe(
      false,
    );
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    expect(isEscapePress(handled)).toBe(false);
  });
});

describe('commitReasonCopy (RT-1025, M-P30)', () => {
  it('asks for a method first, then says the amount is short, else nothing', () => {
    expect(commitReasonCopy(true, true)).toBe('اختر طريقة الدفع');
    expect(commitReasonCopy(true, false)).toBe('اختر طريقة الدفع');
    expect(commitReasonCopy(false, true)).toBe('المبلغ أقل من المستحق');
    expect(commitReasonCopy(false, false)).toBeNull();
  });
});

describe('test-id maps and tender copy (hooks existing suites assert)', () => {
  it('keeps every data-testid unchanged', () => {
    expect(LEDGER_TEST_IDS).toEqual({
      dueLabel: 'payment-surface-amount-label',
      due: 'payment-surface-amount-due',
    });
    expect(COMPLETION_TEST_IDS).toEqual({
      root: 'payment-surface',
      panel: 'payment-surface-settled',
      proofs: 'payment-surface-settled-pending',
      amount: 'payment-surface-settled-amount',
      change: 'payment-surface-settled-change',
      cardVoid: 'payment-surface-settled-card-void',
      newSale: 'payment-surface-new-sale',
    });
    expect(RECOVERY_TEST_IDS).toEqual({
      refusal: 'payment-surface-bridge-refusal',
      reversalPending: 'payment-surface-reversal-pending-hint',
    });
    expect(FIRST_ENABLED_TENDER_TILE).toBe(
      '[data-testid="tender-selection"] [role="radio"]:not([disabled])',
    );
  });

  it('names every tender kind in the Slice-1 status copy', () => {
    expect(TENDER_SELECTED_COPY).toEqual({
      cash: 'تم اختيار النقد',
      external_card_terminal: 'تم اختيار جهاز الشبكة',
      internal_voucher: 'تم اختيار القسيمة',
    });
  });
});

describe('resolveBridge', () => {
  const payments = {} as PaymentsBridgeAPI;
  const tender = {} as TenderBridgeAPI;
  const win = window as unknown as { api?: unknown };

  afterEach(() => {
    delete win.api;
  });

  it('returns the injected test bridge as is', () => {
    const bridge = { payments, tender };
    expect(resolveBridge(bridge)).toBe(bridge);
  });

  it('returns null with no window.api, or without payments or tender', () => {
    expect(resolveBridge(undefined)).toBeNull();
    win.api = { tender };
    expect(resolveBridge(undefined)).toBeNull();
    win.api = { payments };
    expect(resolveBridge(undefined)).toBeNull();
  });

  it('reads payments and tender from window.api, adding sales only when present', () => {
    win.api = { payments, tender };
    expect(resolveBridge(undefined)).toEqual({ payments, tender });
    const sales = {};
    win.api = { payments, tender, sales };
    expect(resolveBridge(undefined)).toEqual({ payments, tender, sales });
  });
});
