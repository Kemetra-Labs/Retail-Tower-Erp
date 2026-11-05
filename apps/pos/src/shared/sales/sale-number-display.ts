/**
 * RT-1189 (RT-249 N-S1, doc 20 §2 and §4) — the short form of a sale number,
 * and what a cashier may type into the lookup field. Pure; shared by main
 * (which derives and resolves) and the renderer (which only displays what main
 * sent and classifies typed input).
 *
 * `sale_number = <terminal_label>-<YYYY-MM-DD>-<NNNNNN>`. The label is free text
 * (it may hold spaces and hyphens), so the short form is read from the RIGHT and
 * checked against the stored `local_calendar_day`; it never splits from the left.
 */

/** Everything after the label: `-YYYY-MM-DD-` and a sequence of six or more digits. */
const SALE_NUMBER = /^(.*)-(\d{4}-\d{2}-\d{2})-(\d{6,})$/;

/** The allocator pads the sequence to six digits (`sale-number-allocator.ts`). */
const SEQUENCE_WIDTH = 6;

/** A short form is one to nine digits (doc 20 §3). */
const SHORT_FORM = /^\d{1,9}$/;

/** Left-to-right, right-to-left and Arabic letter marks, and the isolate controls. */
const BIDI_CONTROLS = /[‎‏؜⁦-⁩]/g;

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

export interface SaleNumberDisplay {
  /** The stored number, exactly as printed on the receipt. */
  readonly exact: string;
  /** The sequence without leading zeros, or null when the number does not parse. */
  readonly short: string | null;
}

/**
 * The short form of a stored sale number (doc 20 §2). `short` is null when the
 * number does not match the format or its embedded date is not the stored day:
 * the UI then shows the exact number only, never an invented short form.
 * Never throws.
 */
export function saleNumberDisplay(row: {
  readonly sale_number: string;
  readonly local_calendar_day: string;
}): SaleNumberDisplay {
  const exact = row.sale_number;
  if (typeof exact !== 'string') return { exact, short: null };
  const match = SALE_NUMBER.exec(exact);
  if (match === null || match[2] !== row.local_calendar_day) return { exact, short: null };
  const sequence = Number(match[3]);
  return { exact, short: Number.isSafeInteger(sequence) ? String(sequence) : null };
}

/** The Western digit for an Arabic-Indic or Extended Arabic-Indic digit, else the character. */
function westernDigit(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
    return String(code - ARABIC_INDIC_ZERO);
  }
  if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
    return String(code - EXTENDED_ARABIC_INDIC_ZERO);
  }
  return char;
}

export type SaleLookupInput =
  | { readonly kind: 'empty' }
  /** One to nine digits, leading zeros dropped: a short form. */
  | { readonly kind: 'short'; readonly digits: string }
  /** Anything else: the exact number as typed, normalised. */
  | { readonly kind: 'exact'; readonly value: string };

/**
 * Classifies what the cashier typed (doc 20 §4): strip bidi controls (a copy of
 * the LTR-isolated exact number can carry them), trim, turn Arabic-Indic digits
 * into Western digits, then one to nine digits mean a short form and anything
 * else the exact number. Never throws.
 */
export function normalizeSaleLookupInput(raw: string): SaleLookupInput {
  if (typeof raw !== 'string') return { kind: 'empty' };
  const value = raw
    .replace(BIDI_CONTROLS, '')
    .trim()
    .replace(/[٠-٩۰-۹]/g, westernDigit);
  if (value.length === 0) return { kind: 'empty' };
  if (SHORT_FORM.test(value)) return { kind: 'short', digits: String(Number(value)) };
  return { kind: 'exact', value };
}

/**
 * The text a stored `sale_number` ends with for a canonical short form: `-` and
 * the sequence padded to the allocator width. A SQL prefilter only; the caller
 * still confirms each row with {@link saleNumberDisplay}.
 */
export function shortNumberSuffix(digits: string): string {
  return `-${digits.padStart(SEQUENCE_WIDTH, '0')}`;
}

export type ShortNumberResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly sale_number: string }
  | { readonly kind: 'many'; readonly sale_numbers: readonly string[] };

/**
 * Resolves a short form against rows that carry `short_number` (doc 20 §4): no
 * match, exactly one exact `sale_number`, or several. With several the caller
 * shows the candidates and never picks one.
 */
export function resolveShortNumber(
  items: readonly { readonly sale_number: string; readonly short_number: string | null }[],
  digits: string,
): ShortNumberResolution {
  const matches = items.filter((item) => item.short_number === digits).map((i) => i.sale_number);
  const [first] = matches;
  if (first === undefined) return { kind: 'none' };
  return matches.length === 1
    ? { kind: 'one', sale_number: first }
    : { kind: 'many', sale_numbers: matches };
}
