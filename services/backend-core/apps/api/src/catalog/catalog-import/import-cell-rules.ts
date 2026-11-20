/**
 * RT-1505 part B (spec 049 section 5, "Cell rules common to every field"): the per-cell rules of validate, pure.
 *
 * Nothing here normalises an identifier (310, 313): no case folding and no digit-script conversion. Every loop is a
 * single pass over the text, so a cell costs time linear in its length (a cell is at most 2,000 characters).
 */
import { codePointLength, hasNoNul, isWellFormedText } from "../../common/text-validation";
import { IDENTIFIER_VALUE } from "../console-catalog/console-catalog.write-bodies";

/** An identifier value is 1 to 200 characters (`product_aliases_value_length`). */
const IDENTIFIER_MAX_CHARS = 200;

/** A bidi mark or NBSP left INSIDE an identifier passes the contract pattern but can never match a scan (OD-10). */
const INVISIBLE = new Set([0x00a0, 0x200e, 0x200f, 0x061c]);
/** Arabic-Indic digits U+0660..U+0669 and the Extended (Persian) ones U+06F0..U+06F9 (OD-15). */
const isArabicIndicDigit = (cp: number): boolean => (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9);

/** What is wrong with the text of an identifier cell (after the trim), by issue code. Each code at most once. */
export function identifierProblems(text: string, field: "sku" | "barcode" | "plu"): Array<"value_invalid" | "identifier_invisible_char" | "identifier_non_ascii_digits"> {
  const problems = new Set<"value_invalid" | "identifier_invisible_char" | "identifier_non_ascii_digits">();
  let chars = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    chars += 1;
    if (INVISIBLE.has(cp)) problems.add("identifier_invisible_char");
    if (field !== "sku" && isArabicIndicDigit(cp)) problems.add("identifier_non_ascii_digits");
  }
  // The contract pattern (no control character, no outer whitespace) is the console writes' own; the length is
  // checked first so the pattern only ever sees at most 200 characters.
  if (chars > IDENTIFIER_MAX_CHARS || !isWellFormedText(text) || !hasNoNul(text) || !IDENTIFIER_VALUE.test(text)) problems.add("value_invalid");
  return [...problems];
}

/** Free text of a field: 1 to `max` characters, no NUL, well formed (the caller trimmed it, so it is not blank). */
export function textFieldInvalid(text: string, max: number): boolean {
  return codePointLength(text) > max || !hasNoNul(text) || !isWellFormedText(text);
}

/**
 * Whether a digits-only barcode of length 8, 12, 13 or 14 has a wrong GS1 check digit (OD-16 A). Other values are
 * never GTIN-checked: they may be store-internal codes.
 */
export function hasBadGtinCheckDigit(value: string): boolean {
  const n = value.length;
  if (n !== 8 && n !== 12 && n !== 13 && n !== 14) return false;
  let sum = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const digit = value.charCodeAt(n - 2 - i) - 48;
    if (digit < 0 || digit > 9) return false;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  const last = value.charCodeAt(n - 1) - 48;
  if (last < 0 || last > 9) return false;
  return (10 - (sum % 10)) % 10 !== last;
}

/** Arabic yes and no, as code points (no Arabic letter in the source). */
const ARABIC_YES = "\u{0646}\u{0639}\u{0645}";
const ARABIC_NO = "\u{0644}\u{0627}";

/** `is_active`: true/false, 1/0, yes/no (any case) or the Arabic yes/no; null when the text is none of them. */
export function parseIsActive(text: string): boolean | null {
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes" || text === ARABIC_YES) return true;
  if (lower === "false" || lower === "0" || lower === "no" || text === ARABIC_NO) return false;
  return null;
}
