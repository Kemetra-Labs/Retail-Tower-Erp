/**
 * RT-1331 (owner decision, chat 2026-11-19) — per-reason Arabic refusal copy for the
 * voucher tender. This SUPERSEDES security decision F-A4B-003 (one generic line for every
 * refusal). What stays of its intent: the structured reason code never reaches the DOM,
 * and a cross-tenant code is indistinguishable from an unknown one, so a code from another
 * organization cannot be confirmed to exist.
 */
import { describe, expect, it } from 'vitest';

import {
  VOUCHER_REFUSAL_GENERIC_COPY,
  settleVoucherRefusalCopy,
  voucherRefusalCopy,
} from '../../../../src/renderer/ui/payments/voucher-refusal-copy.js';
import { REFUSAL_REASONS } from '../../../../src/shared/payments/types.js';

const DISTINCT = [
  ['voucher_expired', 'منتهية'],
  ['voucher_cancelled', 'ملغاة'],
  ['voucher_already_redeemed', 'استُخدمت من قبل'],
  ['voucher_branch_mismatch', 'غير صالحة في هذا المتجر'],
  ['non_cash_overpayment_refused', 'المبلغ المطبّق'],
  ['dependency_unavailable', 'خدمة القسائم'],
  ['role_denied', 'حساب كاشير'],
  ['voucher_not_found', 'غير معروف'],
] as const;

describe('voucherRefusalCopy — validate-time refusals', () => {
  it.each(DISTINCT)('%s says what is wrong (…%s…)', (reason, fragment) => {
    expect(voucherRefusalCopy(reason)).toContain(fragment);
  });

  it('every distinct reason gets its own line, except the unknown-code group', () => {
    const lines = DISTINCT.filter(([r]) => r !== 'voucher_not_found').map(([r]) =>
      voucherRefusalCopy(r),
    );
    expect(new Set(lines).size).toBe(lines.length);
  });

  // The renderer cannot itself make a NEW code look unknown: a reason it has no line for reads
  // as the generic line, which differs from the unknown-code line. Today that cannot happen only
  // because main's `mapClosedRefusal` turns every non-closed code into `voucher_not_found`. If a
  // `voucher_*` reason is ever added to the bridge's closed set without a line here, it would
  // show the generic line and so confirm that the code exists: this test fails first.
  it('every voucher_* member of the bridge refusal set has its own line', () => {
    const voucherReasons = REFUSAL_REASONS.filter((r) => r.startsWith('voucher_'));
    expect(voucherReasons.length).toBeGreaterThan(0);
    for (const reason of voucherReasons) {
      expect(voucherRefusalCopy(reason)).not.toBe(VOUCHER_REFUSAL_GENERIC_COPY);
    }
  });

  it('a cross-tenant code reads exactly like an unknown code (no cross-tenant confirmation)', () => {
    expect(voucherRefusalCopy('voucher_tenant_mismatch')).toBe(
      voucherRefusalCopy('voucher_not_found'),
    );
    expect(voucherRefusalCopy('validation_failure')).toBe(voucherRefusalCopy('voucher_not_found'));
  });

  it.each([
    'no_session',
    'attempt_terminal',
    'idempotency_payload_mismatch',
    'wrong_owner',
    'invalid_input',
    'tenant_isolation',
    'internal_error',
    'something_new_from_a_future_main',
  ])('the non-voucher reason %s keeps the generic line', (reason) => {
    expect(voucherRefusalCopy(reason)).toBe(VOUCHER_REFUSAL_GENERIC_COPY);
  });

  // The reason arrives from the main process as an untrusted string: a name that exists on
  // every object must not resolve to an inherited member.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'the object-member name %s keeps the generic line, and never settle copy',
    (reason) => {
      expect(voucherRefusalCopy(reason)).toBe(VOUCHER_REFUSAL_GENERIC_COPY);
      expect(settleVoucherRefusalCopy(reason)).toBeNull();
    },
  );

  it('a lost answer (no reason) keeps the generic line', () => {
    expect(voucherRefusalCopy(null)).toBe(VOUCHER_REFUSAL_GENERIC_COPY);
    expect(voucherRefusalCopy(undefined)).toBe(VOUCHER_REFUSAL_GENERIC_COPY);
  });

  it('never prints a reason code, a balance or an amount', () => {
    const all = [...DISTINCT.map(([r]) => voucherRefusalCopy(r)), VOUCHER_REFUSAL_GENERIC_COPY];
    for (const line of all) {
      expect(line).not.toMatch(/voucher_|_refused|_unavailable|_denied/);
      expect(line).not.toMatch(/\d/);
    }
  });

  it('says retry only where a retry can help (the service being unreachable)', () => {
    expect(voucherRefusalCopy('dependency_unavailable')).toContain('أعد المحاولة');
    for (const reason of [
      'voucher_expired',
      'voucher_cancelled',
      'voucher_already_redeemed',
      'voucher_branch_mismatch',
    ]) {
      expect(voucherRefusalCopy(reason)).not.toContain('أعد المحاولة');
      expect(voucherRefusalCopy(reason)).toContain('اختر طريقة دفع أخرى');
    }
  });

  it('uses the store terminology, never «الفرع» (UX-12.16)', () => {
    expect(voucherRefusalCopy('voucher_branch_mismatch')).not.toContain('الفرع');
  });
});

describe('settleVoucherRefusalCopy — a redeem refused at settle', () => {
  const SETTLE_REASONS = [
    'voucher_expired',
    'voucher_cancelled',
    'voucher_already_redeemed',
    'voucher_branch_mismatch',
    'voucher_not_found',
    'voucher_tenant_mismatch',
  ];

  // At settle the voucher line is already applied and the attempt is over or about to be:
  // «re-enter the code» or «choose another payment method» is not an action the cashier has
  // here, and the settle copy supplies the one real next step. So: the fact, never the action.
  it.each(SETTLE_REASONS)('%s -> the fact alone: the start of its apply-time line', (reason) => {
    const fact = settleVoucherRefusalCopy(reason);
    expect(fact).not.toBeNull();
    expect(voucherRefusalCopy(reason).startsWith(fact ?? '\u0000')).toBe(true);
    expect(fact).not.toBe(voucherRefusalCopy(reason));
  });

  it.each(SETTLE_REASONS)('%s -> carries no action sentence', (reason) => {
    const fact = settleVoucherRefusalCopy(reason) ?? '';
    expect(fact).not.toContain('اختر');
    expect(fact).not.toContain('أعد');
    expect(fact).not.toContain('تأكد');
  });

  it('a cross-tenant code still reads like an unknown one at settle', () => {
    expect(settleVoucherRefusalCopy('voucher_tenant_mismatch')).toBe(
      settleVoucherRefusalCopy('voucher_not_found'),
    );
  });

  it.each(['dependency_unavailable', 'no_session', 'tender_underpaid', 'internal_error', null])(
    'the non-voucher reason %s gets none (the settle copy decides)',
    (reason) => {
      expect(settleVoucherRefusalCopy(reason)).toBeNull();
    },
  );
});
