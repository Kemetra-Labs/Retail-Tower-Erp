import {
  computeManualDiscount,
  formatManualDiscountToken,
  lineDiscountMinor,
  type ManualDiscount,
  type ManualDiscountKind,
} from '../../../../shared/cart/manual-discount';
import { normalizeDigits, normalizeNumericInput } from '../../../ui/forms/normalize-digits';
import { parseCurrencyToMinor } from '../../../ui/payments/parse-currency-to-minor';

/**
 * RT-855 — the renderer's side of the manual discount: presentation only. The
 * amounts come from the same shared pure function main uses
 * (`shared/cart/manual-discount.ts`, doc 28 §3.2), so the preview equals what
 * main applies; main still recomputes it, and the renderer never sends an
 * amount, only the canonical token.
 */

const WHOLE_PERCENT = /^[1-9]\d*$/;
const MAX_PERCENT = 100;

/** What the sheet's value field holds, read against the line gross. */
export type DiscountEntry =
  | { readonly kind: 'empty' }
  /** Not a value main would accept, with nothing more to say than the field help. */
  | { readonly kind: 'invalid' }
  /** OD-6: an amount above the line gross, refused in the sheet before any call. */
  | { readonly kind: 'over_gross' }
  | {
      readonly kind: 'ok';
      readonly discount: ManualDiscount;
      readonly token: string;
      readonly amountMinor: number;
      readonly netMinor: number;
    };

function readValue(kind: ManualDiscountKind, raw: string): number | null {
  if (kind === 'percent') {
    const digits = normalizeDigits(raw);
    if (!WHOLE_PERCENT.test(digits)) return null;
    const value = Number(digits);
    return value <= MAX_PERCENT ? value : null;
  }
  const minor = parseCurrencyToMinor(normalizeNumericInput(raw));
  return minor !== null && minor >= 1 ? minor : null;
}

/** The typed value as a discount on this line gross (OD-28-1/2, §3.1, §3.2). */
export function readDiscountEntry(
  kind: ManualDiscountKind,
  raw: string,
  grossMinor: number,
): DiscountEntry {
  if (raw.trim() === '') return { kind: 'empty' };
  const value = readValue(kind, raw);
  if (value === null) return { kind: 'invalid' };
  if (kind === 'amount' && value > grossMinor) return { kind: 'over_gross' };
  const discount: ManualDiscount = { kind, value };
  const result = computeManualDiscount(grossMinor, discount);
  if (result === null) return { kind: 'invalid' };
  return {
    kind: 'ok',
    discount,
    token: formatManualDiscountToken(discount),
    amountMinor: result.amount_minor,
    netMinor: result.net_minor,
  };
}

/** A discount placeholder as the cart projection knows it. */
export interface CartDiscountSeed {
  readonly placeholderId: string;
  readonly lineId?: string | null;
  /** The canonical token; null when this renderer does not know it (see the details store). */
  readonly token?: string | null;
}

interface TotalsLine {
  readonly lineId: string;
  readonly lineSubtotalMinor: number;
}

export interface CartDiscountTotals {
  /** Each line's discount amount, or null when its token is unknown here. */
  readonly byLine: ReadonlyMap<string, number | null>;
  /** Σ line discounts; null when one cannot be computed here (shown as «—», never guessed). */
  readonly discountTotalMinor: number | null;
  /** Σ gross − Σ discounts; null with the total. */
  readonly netMinor: number | null;
}

/**
 * The cart's discount and net as the renderer can show them. A placeholder
 * whose token this renderer does not know makes the totals unknown rather
 * than showing the gross as the amount to pay.
 */
export function cartDiscountTotals(
  lines: readonly TotalsLine[],
  seeds: readonly CartDiscountSeed[],
  subtotalMinor: number,
): CartDiscountTotals {
  const grossByLine = new Map(lines.map((line) => [line.lineId, line.lineSubtotalMinor]));
  const byLine = new Map<string, number | null>();
  for (const seed of seeds) {
    const lineId = seed.lineId ?? null;
    const gross = lineId === null ? undefined : grossByLine.get(lineId);
    // A placeholder on a removed line discounts nothing (as main's totals).
    if (lineId === null || gross === undefined) continue;
    const token = seed.token ?? null;
    byLine.set(lineId, token === null ? null : lineDiscountMinor(gross, token));
  }
  let total: number | null = 0;
  for (const amount of byLine.values()) {
    total = amount === null || total === null ? null : total + amount;
  }
  const safe = total !== null && Number.isSafeInteger(total) && total <= subtotalMinor;
  return {
    byLine,
    discountTotalMinor: safe ? total : null,
    netMinor: safe && total !== null ? subtotalMinor - total : null,
  };
}
