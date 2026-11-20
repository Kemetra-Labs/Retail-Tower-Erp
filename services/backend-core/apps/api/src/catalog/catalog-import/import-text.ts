/**
 * RT-1505 (spec 049 §5, OD-10 A): the text rules every import cell goes
 * through. "Whitespace" is Unicode `White_Space` (NBSP, U+00A0, included) plus
 * the bidi marks U+200E, U+200F and U+061C, which Arabic Excel files often
 * carry. Nothing here normalises: no case folding, no digit-script conversion
 * (310, 313).
 */

/** Unicode `White_Space` and the three bidi marks (written as code points so no invisible character sits in the source). */
const WHITESPACE = String.raw`\p{White_Space}\u{200E}\u{200F}\u{061C}`;
const WHITESPACE_CHAR = new RegExp(`^[${WHITESPACE}]$`, "u");
/** A lone surrogate half: JSON writes it as an escape that Postgres `jsonb` refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The text without its leading and trailing whitespace (spec 049 §5). Index loops from both ends: linear on any input (an edge regex backtracks quadratically). Every whitespace character is in the BMP, so a UTF-16 unit is a character here. */
export function trimImportText(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && WHITESPACE_CHAR.test(text.charAt(start))) start += 1;
  while (end > start && WHITESPACE_CHAR.test(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Whether the text holds nothing but whitespace (or nothing). */
export function isBlankText(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (!WHITESPACE_CHAR.test(text.charAt(i))) return false;
  return true;
}

/** The length in characters (code points), as the contract and the 0124 CHECKs count it. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Whether `jsonb` can store the text: no NUL and no lone surrogate. */
export function isStorableText(text: string): boolean {
  return !text.includes("\u{0}") && !LONE_SURROGATE.test(text);
}
