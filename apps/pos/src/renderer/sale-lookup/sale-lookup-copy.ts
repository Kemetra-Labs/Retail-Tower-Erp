/**
 * RT-1192 (RT-249 N-S3, doc 20 §7) — the strings of the recent-sales list and the
 * short-number field, shared by Returns and Void. Arabic only, «الإيصال» never
 * «فاتورة». M-N1…M-N4, M-N6 and M-N8 are the owner-approved wording (2026-11-04);
 * the two row print states are doc 20 §7's «never طُبع»; `loading`, `unavailable`
 * and `ambiguousList` are neutral status and label lines for the list itself.
 */
export const SALE_LOOKUP_COPY = Object.freeze({
  /** M-N1 — manager or admin. */
  terminalTitle: 'مبيعات اليوم على هذا الجهاز',
  /** M-N1 — cashier. */
  ownTitle: 'مبيعاتك اليوم',
  /** M-N2 */
  terminalEmpty: 'لا توجد مبيعات اليوم على هذا الجهاز.',
  ownEmpty: 'لا توجد مبيعات لك اليوم.',
  /** M-N3 — after the screen's own "no sale with this number" line (M-R1). */
  notFoundEarlier: 'إن كان البيع من يوم سابق فأدخل الرقم كاملًا كما في الإيصال.',
  /** M-N4 */
  ambiguous: 'يوجد أكثر من بيع بهذا الرقم اليوم. اختر البيع من القائمة.',
  ambiguousList: 'المبيعات المطابقة',
  /** M-N6 */
  truncated: 'تظهر أحدث 300 عملية. ابحث برقم البيع.',
  /** M-N8 */
  fieldLabel: 'رقم البيع',
  fieldHint: 'الرقم القصير أو الرقم الكامل من الإيصال',
  /** Row print state (doc 20 §7, N-09): never «طُبع». */
  printSent: 'أُرسل الإيصال للطابعة',
  printFailed: 'تعذّرت الطباعة',
  loading: 'جارٍ التحميل…',
  unavailable: 'تعذّر تحميل مبيعات اليوم.',
});

/** The method names on the tender tiles. */
export const TENDER_LABEL: Readonly<Record<string, string>> = Object.freeze({
  cash: 'نقدي',
  external_card_terminal: 'بطاقة',
  internal_voucher: 'قسيمة',
});
