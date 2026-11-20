/**
 * RT-1505 (spec 049 §5, OD-10 A): the text rules every import cell goes
 * through. "Whitespace" is Unicode `White_Space` (NBSP, U+00A0, included) plus
 * the bidi marks U+200E, U+200F and U+061C, which Arabic Excel files often
 * carry. Nothing here normalises: no case folding, no digit-script conversion
 * (310, 313).
 */

/** Unicode `White_Space` and the three bidi marks (written as code points so no invisible character sits in the source). */
const WHITESPACE = String.raw`\p{White_Space}\u{200E}\u{200F}\u{061C}`;
const EDGE_WHITESPACE = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, "gu");
const ONLY_WHITESPACE = new RegExp(`^[${WHITESPACE}]*$`, "u");
/** A lone surrogate half: JSON writes it as an escape that Postgres `jsonb` refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The text without its leading and trailing whitespace (spec 049 §5). */
export function trimImportText(text: string): string {
  return text.replace(EDGE_WHITESPACE, "");
}

/** Whether the text holds nothing but whitespace (or nothing). */
export function isBlankText(text: string): boolean {
  return ONLY_WHITESPACE.test(text);
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
