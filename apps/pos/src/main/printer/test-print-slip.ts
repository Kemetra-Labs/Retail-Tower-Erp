/**
 * RT-886 (RT-839 D5) — the printer test page.
 *
 * Composed from the receipt bands and serialised by the same template engine
 * (AD-6), so it travels the exact path a receipt does. It says plainly that it
 * is not a receipt, names the printer it was sent to (so the operator can tell
 * which printer answered), and carries the store-zone time. No sale, no amount,
 * no operator.
 */
import { renderBands, storeStamp, type Band } from '../receipts/template-engine.js';
import { receiptLines } from '../receipts/receipt-text.js';
import type { ReceiptRenderOutput } from '../receipts/template-engine.js';
import type { PrinterChoice } from '../../shared/printer/types.js';

export const TEST_SLIP_COPY = {
  title: 'صفحة اختبار الطابعة',
  notReceipt: 'هذه الصفحة للاختبار فقط، وليست إيصال بيع.',
  printerLabel: 'الطابعة:',
  osDefault: 'طابعة Windows الافتراضية',
} as const;

function printerText(choice: PrinterChoice | null): string {
  return choice?.source === 'chosen' ? choice.printer_name : TEST_SLIP_COPY.osDefault;
}

export function renderTestPrintSlip(
  choice: PrinterChoice | null,
  nowIso: string,
): ReceiptRenderOutput {
  const bands: Band[] = [
    { kind: 'text', text: TEST_SLIP_COPY.title, align: 'center', emphasis: true },
    { kind: 'rule', char: '=' },
    ...receiptLines(TEST_SLIP_COPY.notReceipt).map(
      (text): Band => ({ kind: 'text', text, align: 'rtl' }),
    ),
    { kind: 'text', text: TEST_SLIP_COPY.printerLabel, align: 'rtl' },
    ...receiptLines(printerText(choice)).map(
      (text): Band => ({ kind: 'text', text, align: 'ltr' }),
    ),
    { kind: 'text', text: storeStamp(nowIso), align: 'ltr' },
    { kind: 'rule', char: '=' },
  ];
  return renderBands(bands);
}
