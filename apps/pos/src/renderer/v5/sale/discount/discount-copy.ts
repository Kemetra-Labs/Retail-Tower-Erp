import type { CartRefusalReason } from '../../../../shared/cart/refusal';
import type { ManualDiscountReasonCode } from '../../../../shared/cart/manual-discount';
import type { ManagerApprovalRefusalReason } from '../../../../shared/operator/manager-approval';
import { SALE_LINE_DISCOUNTED_MESSAGE } from '../../../scan/scan-messages';

/**
 * RT-855 (RT-699 I2) — the manual discount's Arabic copy, exactly as the D1
 * copy table has it (RT-853, owner-approved 2026-10-24, OD-2). The strings
 * marked «مأخوذ» in that table are reused from where they shipped: the RT-114
 * approval prompt (`shift-copy.ts`) and the cart. Nothing here is new beyond
 * the table, and no refusal names an approver, a PIN or an identifier.
 */
export const DISCOUNT_COPY = Object.freeze({
  /** The cart-header control (OD-1). */
  open: 'خصم',
  sheetTitle: 'خصم على الصنف',
  cashierHint: 'يحتاج الخصم موافقة مدير قبل تطبيقه.',
  kindLegend: 'نوع الخصم',
  percent: 'نسبة مئوية',
  amount: 'مبلغ ثابت',
  valueLabel: 'قيمة الخصم',
  percentHelp: 'رقم صحيح من 1 إلى 100.',
  reasonLegend: 'سبب الخصم',
  required: '(مطلوب)',
  reasonMissing: 'اختر سبب الخصم للمتابعة.',
  previewGross: 'إجمالي الصنف',
  previewDiscount: 'الخصم',
  previewNet: 'الصافي بعد الخصم',
  previewNote: 'معاينة. يُحسب المبلغ النهائي عند التطبيق.',
  requestApproval: 'طلب موافقة المدير',
  apply: 'تطبيق الخصم',
  cancel: 'إلغاء',
  overGross: 'المبلغ أكبر من إجمالي الصنف.',
  // The RT-114 prompt (shipped in shift-copy.ts), with the discount's own body.
  approvalTitle: 'موافقة المدير',
  approvalBody: 'لا يُطبَّق هذا الخصم إلا بموافقة مدير مسجَّل على هذا الجهاز، برقمه السري.',
  summaryItem: 'الصنف',
  summaryDiscount: 'الخصم',
  summaryReason: 'السبب',
  managerLegend: 'المدير',
  pinLabel: 'الرقم السري للمدير',
  approve: 'اعتماد الخصم',
  backToSheet: 'رجوع إلى الخصم',
  approvalInvalid: 'انتهت الموافقة أو لا تخص هذا الخصم. اطلب الموافقة مرة أخرى.',
  approvalStale: 'تغيّر الصنف منذ طلب الموافقة. راجع الخصم ثم اطلب الموافقة من جديد.',
  // The discounted line and the totals (OD-28-11, OD-3).
  discount: 'خصم',
  totalDiscount: 'إجمالي الخصم',
  removeDiscount: 'إزالة الخصم',
  qtyRefused: SALE_LINE_DISCOUNTED_MESSAGE,
  qtyDisabled: 'أزل الخصم لتغيير الكمية.',
  secondRefused: 'على هذا الصنف خصم بالفعل. أزل الخصم الحالي قبل إضافة خصم آخر.',
  // A zero total (OZ-1 = Z-A, OD-8): Checkout with no tender, and its Completion.
  zeroDue: 'لا يوجد مبلغ مستحق: الخصم يغطي إجمالي البيع، فلا حاجة لطريقة دفع.',
  completeSale: 'إتمام البيع',
  noAmountDue: 'لا يوجد مبلغ مستحق',
  // Shipped RT-114 prompt lines (shift-copy.ts), reused unchanged.
  loadingManagers: 'جارٍ تحميل المديرين…',
  noManagers:
    'لا يوجد مدير برقم سري على هذا الجهاز. يحفظ المدير رقمه من شاشة حالة الوردية بعد تسجيل دخوله.',
  approverInvalid: 'لم تُقبل موافقة المدير. تحقّق من اسم المدير ورقمه السري.',
  unavailable: 'تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.',
});

/** «بموافقة: ‹اسم المدير›» (§4.1 step 6, O2): the approver's display name on the line. */
export function approvedByLabel(name: string): string {
  return `بموافقة: ${name}`;
}

/** «حتى إجمالي الصنف: 90.00 EGP.» — the amount field's bound. */
export function amountHelp(grossLabel: string): string {
  return `حتى إجمالي الصنف: ${grossLabel}.`;
}

/** The four reasons, in the D1 order, with their labels (OD-28-9, doc 28 §11.2). */
export const DISCOUNT_REASONS: readonly (readonly [ManualDiscountReasonCode, string])[] = [
  ['promotion', 'عرض ترويجي'],
  ['loyal_or_contract_customer', 'عميل دائم / تعاقد'],
  ['near_expiry_or_damaged', 'قرب انتهاء / عبوة تالفة'],
  ['price_correction', 'تصحيح سعر'],
];

export function reasonLabel(code: ManualDiscountReasonCode): string {
  return DISCOUNT_REASONS.find(([value]) => value === code)?.[1] ?? '';
}

/**
 * Where an add refusal is shown. `approval` and `sheet` stay in the open
 * dialog; `cart` closes the flow and shows the line in the money column.
 */
export type DiscountRefusalPlace = 'approval' | 'stale' | 'sheet' | 'cart';

export interface DiscountRefusalCopy {
  readonly message: string;
  readonly place: DiscountRefusalPlace;
}

const ADD_REFUSALS: Partial<Record<CartRefusalReason, DiscountRefusalCopy>> = {
  approval_invalid: { message: DISCOUNT_COPY.approvalInvalid, place: 'approval' },
  approval_stale: { message: DISCOUNT_COPY.approvalStale, place: 'stale' },
  // OD-6: an amount main finds above the gross (or any non-canonical value).
  invalid_payload: { message: DISCOUNT_COPY.overGross, place: 'sheet' },
  manager_attribution_required: { message: DISCOUNT_COPY.cashierHint, place: 'sheet' },
  discount_already_applied: { message: DISCOUNT_COPY.secondRefused, place: 'cart' },
  line_discounted: { message: DISCOUNT_COPY.qtyRefused, place: 'cart' },
};

/** The copy for a refused `cart.discountPlaceholders.add`; existing codes keep the generic line. */
export function addRefusalCopy(reason: CartRefusalReason): DiscountRefusalCopy {
  return ADD_REFUSALS[reason] ?? { message: DISCOUNT_COPY.unavailable, place: 'cart' };
}

/** The copy for a refused `approval.request` (RT-114 C3: never which part failed). */
export function approvalRefusalCopy(reason: ManagerApprovalRefusalReason): DiscountRefusalCopy {
  if (reason === 'approval_unavailable') {
    return { message: DISCOUNT_COPY.approverInvalid, place: 'approval' };
  }
  if (reason === 'approval_stale') return { message: DISCOUNT_COPY.approvalStale, place: 'stale' };
  if (reason === 'approval_invalid') {
    return { message: DISCOUNT_COPY.approvalInvalid, place: 'approval' };
  }
  return { message: DISCOUNT_COPY.unavailable, place: 'approval' };
}
