/** RT-530 — every refusal reason has its own Arabic message; none leaks an identity. */
import { describe, expect, it } from 'vitest';

import { APPROVAL_REFUSAL_REASONS } from '../../../../shared/operator/manager-approval';
import {
  LOCAL_VOID_REFUSALS,
  SALE_VOID_MISMATCH_REASONS,
  SALE_VOID_STATES,
  SERVER_VOID_REFUSALS,
} from '../../../../shared/sale-void/types';
import {
  VOID_COPY,
  voidMismatchMessage,
  voidRefusalMessage,
  voidStateLabel,
  voidWaitingMessage,
} from '../void-copy';

describe('void copy', () => {
  it.each([...LOCAL_VOID_REFUSALS, ...SERVER_VOID_REFUSALS, ...APPROVAL_REFUSAL_REASONS])(
    'has its own message for %s, not the generic fallback',
    (reason) => {
      const message = voidRefusalMessage(reason);
      expect(message).toMatch(/[؀-ۿ]/);
      if (reason !== 'void_unavailable') expect(message).not.toBe(VOID_COPY.unavailable);
    },
  );

  it('has Arabic copy for a claim whose window closed, naming the manager exception', () => {
    expect(VOID_COPY.claimWindowClosed).toMatch(/[؀-ۿ]/);
    expect(VOID_COPY.claimWindowClosed).toContain('مدير آخر');
  });

  it('falls back to the generic message for an unknown reason', () => {
    expect(voidRefusalMessage('something_new')).toBe(VOID_COPY.unavailable);
  });

  it('labels every journal state', () => {
    for (const state of SALE_VOID_STATES) expect(voidStateLabel(state).length).toBeGreaterThan(0);
    expect(new Set(SALE_VOID_STATES.map(voidStateLabel)).size).toBe(SALE_VOID_STATES.length);
  });

  it('names only the requester for a void waiting for their sign-in', () => {
    expect(voidWaitingMessage('requester_sign_in', 'منى المديرة')).toBe(
      'بانتظار تسجيل دخول منى المديرة متصلًا لإرسال الإلغاء',
    );
    expect(voidWaitingMessage('sale_sync', 'منى المديرة')).not.toContain('منى');
  });

  it('tells staff a business day that passed means a return, not a retry', () => {
    expect(voidRefusalMessage('void_outside_business_day')).toContain('المرتجعات');
    expect(voidRefusalMessage('not_same_day')).toContain('المرتجعات');
  });

  it('keeps the four-eyes refusals naming the rule, never a person', () => {
    for (const reason of ['approval_unavailable', 'void_self_approval']) {
      expect(voidRefusalMessage(reason)).toContain('مدير آخر');
    }
  });

  // RT-1403 S2: PROPOSED copy, pending the owner's copy review.
  it('says that a request alone pays nothing, and where the cash comes from', () => {
    expect(VOID_COPY.dialogBody).not.toContain('يخرج نقد هذا البيع');
    expect(VOID_COPY.dialogBody).toContain('لا يخرج نقد');
    expect(VOID_COPY.dialogBody).toContain('بعد أن يؤكد الخادم');
  });

  it('has its own flag message for every mismatch reason', () => {
    const messages = SALE_VOID_MISMATCH_REASONS.map(voidMismatchMessage);
    for (const message of messages) expect(message).toMatch(/[؀-ۿ]/);
    expect(new Set(messages).size).toBe(SALE_VOID_MISMATCH_REASONS.length);
  });

  it('tells the cashier why no cash is paid: shift, day, shift window, confirmation', () => {
    expect(voidRefusalMessage('payout_no_open_shift')).toContain('وردية');
    expect(voidRefusalMessage('payout_void_not_confirmed')).toContain('الخادم');
    expect(voidRefusalMessage('payout_wrong_day')).toContain('إقرار مدير آخر');
    expect(voidRefusalMessage('payout_other_shift')).toContain('إقرار مدير آخر');
  });
});
