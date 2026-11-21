/**
 * RT-1539 — the invisible and joining characters the Manager Sales text handling removes, built from
 * code points so that no control character sits in the source (the E1 hostile-input pattern).
 */
const hex = (code: number): string => `\\u{${code.toString(16)}}`;
const range = (from: number, to: number = from): string => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`);
const classOf = (...parts: string[]): RegExp => new RegExp(`[${parts.join("")}]`, "gu");

/** Bidirectional controls: Arabic letter mark, LRM/RLM, embeddings and overrides, isolates (X-5). */
const BIDI_CONTROLS = classOf(range(0x061c), range(0x200e, 0x200f), range(0x202a, 0x202e), range(0x2066, 0x2069));

/** What the matcher ignores: zero-width and bidi characters, tatweel, tashkeel and the superscript alef. */
export const MATCH_IGNORABLES = classOf(
  range(0x061c),
  range(0x200b, 0x200f),
  range(0x202a, 0x202e),
  range(0x2066, 0x2069),
  range(0x0640),
  range(0x064b, 0x065f),
  range(0x0670),
);

export const ARABIC_INDIC_DIGITS = classOf(range(0x0660, 0x0669));
export const PERSIAN_DIGITS = classOf(range(0x06f0, 0x06f9));
export const APOSTROPHES = classOf(range(0x27), range(0x2018, 0x2019), range(0x60), range(0x2bc));
/** Hamza-carrying alefs and alef wasla. */
export const ALEF_VARIANTS = classOf(range(0x0622, 0x0623), range(0x0625), range(0x0671));

export const ALEF = String.fromCodePoint(0x0627);
export const YA = String.fromCodePoint(0x064a);
export const ALEF_MAQSURA = new RegExp(hex(0x0649), "gu");
export const TA_MARBUTA = new RegExp(hex(0x0629), "gu");
export const HA = String.fromCodePoint(0x0647);

export function stripBidi(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}
