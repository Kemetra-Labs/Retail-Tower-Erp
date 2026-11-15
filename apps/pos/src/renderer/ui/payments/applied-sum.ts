import type { PaymentAttemptRendererView } from '../../../shared/payments/types.js';

/**
 * RT-1409 — what the applied tender lines cover, net of change.
 *
 * Main counts a line as `amount_applied_minor - (change_due_minor ?? 0)`
 * (`tender-line-fsm.ts`, and the SUM in the tender-lines repository). A cash line
 * carries the amount received, so the gross figure overstates the cover whenever
 * change was due; every renderer sum that decides "still owed" or "covered" uses
 * this one expression so the cashier sees what `payments.confirm` will enforce.
 * Per-method totals on the ledger are a different thing (what was received) and
 * stay gross.
 *
 * CR-11 (Constitution §II): only `applied` lines count, and a line whose amount
 * or change is not a safe integer is skipped. `null` when the running sum itself
 * leaves the safe range, so the caller can refuse to decide on it.
 */
export function appliedNetMinor(lines: PaymentAttemptRendererView['tender_lines']): number | null {
  let sumMinor = 0;
  for (const line of lines) {
    if (line.state !== 'applied') continue;
    const change = line.change_due_minor ?? 0;
    if (!Number.isSafeInteger(line.amount_applied_minor) || !Number.isSafeInteger(change)) continue;
    sumMinor += line.amount_applied_minor - change;
    if (!Number.isSafeInteger(sumMinor)) return null;
  }
  return sumMinor;
}
