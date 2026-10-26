import type { PrinterChoice, PrinterRefusalReason } from '../../../shared/printer/types';

/**
 * RT-886 (RT-839 D4/D5) — the printer choice copy. Honest by rule: a test page
 * Windows accepted is "sent", never "printed" (the OS print path cannot see
 * paper), and the operator is asked to check the printer.
 */
export const PRINTER_COPY = {
  /** The panel's title and accessible name (RT-839 D4). */
  panelTitle: 'الطابعة',
  /** The footer row and panel when no printer was ever chosen (RT-839 D4). */
  notChosen: 'لم تُختر طابعة',
  osDefault: 'طابعة Windows الافتراضية',
  osDefaultHint: 'تذهب الإيصالات إلى الطابعة الافتراضية في Windows.',
  intro: 'اختر الطابعة التي تخرج منها الإيصالات على هذا الجهاز.',
  listLegend: 'الطابعات على هذا الجهاز',
  loading: 'جارٍ تحميل الطابعات…',
  noPrinters: 'لا توجد طابعات مثبّتة على هذا الجهاز.',
  save: 'حفظ',
  close: 'إغلاق',
  testPrint: 'طباعة صفحة اختبار',
  saved: 'حُفظت الطابعة.',
  /** Footer row prefix for assistive tech: the row is a control, not only a status. */
  rowPrefix: 'الطابعة:',
  /** The `PrinterFailureBanner` shortcut (RT-839 D4). */
  changePrinter: 'تغيير الطابعة',
  /** The once-only, non-blocking Sale prompt (RT-839 Q1). */
  prompt: 'لم تُختر طابعة الإيصالات بعد، فتُطبع على طابعة Windows الافتراضية.',
  promptChoose: 'اختيار الطابعة',
  promptLater: 'لاحقًا',
} as const;

/** The printer's name as the operator reads it. */
export function printerLabel(choice: PrinterChoice | null): string {
  if (choice === null) return PRINTER_COPY.notChosen;
  return choice.source === 'chosen' ? choice.printer_name : PRINTER_COPY.osDefault;
}

/** Windows accepted the test page: never "printed" (RT-839 D5 draft). */
export function testAcceptedMessage(label: string): string {
  return `أُرسلت صفحة الاختبار إلى «${label}». تأكد أنها خرجت من الطابعة الصحيحة.`;
}

/** Windows refused the job or it timed out (RT-839 D5 draft). */
export function testFailedMessage(label: string): string {
  return `تعذّرت الطباعة على «${label}». تأكد أنها موصولة وتعمل، أو اختر طابعة أخرى.`;
}

/** The chosen printer is not installed now; nothing was sent. */
export function testMissingMessage(label: string): string {
  return `الطابعة «${label}» غير موجودة على هذا الجهاز الآن. اختر طابعة أخرى.`;
}

/** A refused printer call, as one sentence. */
export function refusalMessage(reason: PrinterRefusalReason | 'bridge_failed'): string {
  switch (reason) {
    case 'printer_not_found':
      return 'هذه الطابعة لم تعد مثبّتة على هذا الجهاز. اختر طابعة أخرى.';
    case 'not_signed_in':
    case 'session_locked':
      return 'سجّل الدخول لتغيير الطابعة.';
    default:
      return 'تعذّر الوصول إلى الطابعات الآن. حاول مرة أخرى.';
  }
}
