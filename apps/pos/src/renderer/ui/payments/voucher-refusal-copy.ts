/**
 * RT-1331 — the cashier's Arabic line for a refused voucher.
 *
 * Owner decision (chat, 2026-11-19): tell the cashier which voucher problem stopped the apply,
 * instead of one generic line for every refusal. This SUPERSEDES security decision F-A4B-003
 * (`specs/006-payments-tender/reviews/a4b-vouchers-bridge-brief.md` §6). What is kept of it:
 *
 *   - the structured reason code never reaches the DOM: this module returns closed Arabic
 *     strings only, none contains a code, a balance or an amount;
 *   - a code that belongs to another organization (`voucher_tenant_mismatch`) and any code main
 *     could not classify (`validation_failure`; main's `mapClosedRefusal` turns every other
 *     out-of-band code into `voucher_not_found`) read exactly like an unknown code, so a code
 *     from another organization cannot be confirmed to exist;
 *   - no refusal line states the voucher's value or what is left to pay.
 *
 * Residual risk, accepted by the owner's decision (what the controls do and do NOT bound):
 *   - «منتهية», «ملغاة», «استُخدمت من قبل» and «غير صالحة في هذا المتجر» confirm that a code
 *     exists in this organization. Backend-Core's per-device limiter (RT-1112) bounds only
 *     FAILED lookups: about 10 misses per 15 minutes per device. A lookup that finds its code
 *     gives its hit back, so someone who already holds real codes can check each one's state
 *     without a limit, and the limiter fails open when Redis or the limiter itself fails.
 *   - The voucher's value is not stated by any refusal line. It IS revealed by the forfeit
 *     prompt (value = applied + forfeited, by design, RT-1098), and the overpayment refusal
 *     tells a cashier who holds a code whether an amount exceeds the value.
 *   See `docs/runbook/006-payments-security-review.md`.
 *
 * Wording follows UX-12: state the fact, then the action where one helps; «المتجر», never
 * «الفرع» (UX-12.16); a retry is offered only where it can help (the service being
 * unreachable). A line is a FACT plus an ACTION. At apply time the cashier gets both. At settle
 * the voucher is already applied and the attempt is over or about to be, so the apply-time
 * actions («re-enter the code», «choose another payment method») are not actions the cashier
 * has there: settle shows the fact alone and the settle copy supplies the one real next step.
 * The wording is proposed copy for the owner to review; no governing page defines it.
 */

/** Any refusal this module has no line for (session, attempt or contract errors, a lost answer). */
export const VOUCHER_REFUSAL_GENERIC_COPY = 'تعذّر استخدام هذه القسيمة حالياً.';

interface Line {
  /** What is true. Shown alone at settle. */
  readonly fact: string;
  /** What the cashier can do about it at apply time. */
  readonly action: string;
}

const UNKNOWN_CODE: Line = {
  fact: 'رمز القسيمة غير معروف.',
  action: 'تأكد من الرمز وأعد إدخاله.',
};
const CHOOSE_ANOTHER = 'اختر طريقة دفع أخرى.';

const LINES: Readonly<Record<string, Line>> = Object.freeze({
  voucher_not_found: UNKNOWN_CODE,
  // Another organization's code must not be distinguishable from an unknown one.
  voucher_tenant_mismatch: UNKNOWN_CODE,
  validation_failure: UNKNOWN_CODE,
  voucher_expired: { fact: 'هذه القسيمة منتهية الصلاحية.', action: CHOOSE_ANOTHER },
  voucher_cancelled: { fact: 'هذه القسيمة ملغاة.', action: CHOOSE_ANOTHER },
  voucher_already_redeemed: { fact: 'هذه القسيمة استُخدمت من قبل.', action: CHOOSE_ANOTHER },
  voucher_branch_mismatch: { fact: 'هذه القسيمة غير صالحة في هذا المتجر.', action: CHOOSE_ANOTHER },
  // Says neither the voucher's value nor what is left to pay.
  non_cash_overpayment_refused: {
    fact: 'المبلغ المطبّق غير مقبول لهذه القسيمة.',
    action: 'عدّل المبلغ.',
  },
  // A retry can help here: nothing was decided about the voucher.
  dependency_unavailable: {
    fact: 'تعذّر الوصول إلى خدمة القسائم الآن.',
    action: 'أعد المحاولة بعد قليل.',
  },
  // RT-1110: a session without a cashier admission cannot apply a voucher.
  role_denied: {
    fact: 'لا يمكن تطبيق القسيمة من هذه الجلسة.',
    action: 'سجّل الدخول بحساب كاشير.',
  },
});

/** The line for a reason, or null when this module has none (`Object.hasOwn`: never inherited). */
function lineFor(reason: string | null | undefined): Line | null {
  if (typeof reason !== 'string') return null;
  return Object.hasOwn(LINES, reason) ? (LINES[reason] ?? null) : null;
}

/**
 * The line for a refused voucher apply: fact, then action. `reason` is a plain string on
 * purpose: a reason this module does not know (a newer main, a contract error) must read as the
 * generic line, never leak its code.
 */
export function voucherRefusalCopy(reason: string | null | undefined): string {
  const line = lineFor(reason);
  return line === null ? VOUCHER_REFUSAL_GENERIC_COPY : `${line.fact} ${line.action}`;
}

/** The closed voucher reasons `payments.confirm` returns for a redeem V-A refused (RT-1331, #558). */
const SETTLE_VOUCHER_REASONS: ReadonlySet<string> = new Set([
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
]);

/**
 * The FACT, alone, for a settle that failed because V-A refused a redeem, or null for any other
 * reason (the settle copy decides those). Only the six closed voucher reasons qualify: the
 * service being unreachable at settle keeps its retry line.
 */
export function settleVoucherRefusalCopy(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  return SETTLE_VOUCHER_REASONS.has(reason) ? (lineFor(reason)?.fact ?? null) : null;
}
