import type { ArabicPluralForms } from '../../../../shared/formatters/arabic-plural';

/**
 * RT-499 (VN-S10 S10-2) — the manager home copy, frozen with the G-6 references
 * (docs/design/vnext/visual-acceptance/G6-Manager, owner-approved 2026-10-15).
 * RT-1193 (owner decision 2026-11-04) amends G-6: the cards still carry no
 * figure in their titles or descriptions, but a card may show ONE count line
 * (a figure, a dot and the text below) read from a call that already exists.
 * There is still no metrics contract. Nothing is shown at zero, while loading
 * or after a failed read.
 */
const noun = (one: string, two: string, few: string, many: string): ArabicPluralForms => ({
  one,
  two,
  few,
  many,
  other: many,
});

export const HOME_COPY = Object.freeze({
  title: 'لوحة المتابعة',
  shift: Object.freeze({ title: 'حالة الوردية', description: 'حالة وردية هذا الجهاز.' }),
  cashiers: Object.freeze({
    title: 'إدارة الكاشير',
    description: 'الرقم السري لكل كاشير على هذا الجهاز.',
  }),
  recovery: Object.freeze({
    title: 'المبيعات المعلقة',
    description: 'دفع معلّق، أو مبيعات محفوظة لموظفين آخرين.',
  }),
  /** D-10-2: the first entry point to the stuck-shifts screen. */
  stuckShifts: Object.freeze({
    title: 'الورديات العالقة',
    description: 'ورديات بقيت مفتوحة ويجب إغلاقها.',
  }),
  /** RT-1193: the text beside a tile's figure, one plural form per Arabic category. */
  counts: Object.freeze({
    heldSales: Object.freeze(noun('بيع محفوظ', 'بيعان محفوظان', 'مبيعات محفوظة', 'بيعًا محفوظًا')),
    stuckPayment: Object.freeze(noun('دفع معلّق', 'دفعان معلّقان', 'دفعات معلّقة', 'دفعة معلّقة')),
    stuckShifts: Object.freeze(
      noun('وردية عالقة', 'ورديتان عالقتان', 'ورديات عالقة', 'وردية عالقة'),
    ),
  }),
  /** A cashier who opens the route directly. */
  cashierRefusal: 'لوحة المتابعة متاحة للمدير فقط.',
  backToSale: 'العودة إلى البيع',
});
