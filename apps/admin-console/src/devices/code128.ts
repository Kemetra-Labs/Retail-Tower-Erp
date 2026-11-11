/**
 * RT-1316 (AC7) — a Code 128 encoder, hand-written so the pairing-code barcode
 * needs no package. Code Set B only: it covers printable ASCII, which is more than
 * the pairing-code alphabet needs. Pure: text in, a module string out ("1" a bar
 * module, "0" a space module), without the quiet zones the renderer adds.
 *
 * The table is ISO/IEC 15417's symbol widths (bar, space, bar, space, bar, space),
 * indexed by symbol value. Its unit test checks it against an independent encoding.
 */

/** Symbol widths by value: 0..102 data, 103..105 Start A/B/C. */
// biome-ignore format: eight symbols per row keeps the table checkable against the standard
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232",
];

/** The stop symbol with its final bar: 13 modules. */
export const CODE128_STOP = "2331112";

const START_B = 104;
const CHECK_MODULUS = 103;
const FIRST_B = 32;
const LAST_B = 126;

/** Widths to modules: runs alternate bar ("1") and space ("0"), starting with a bar. */
function modulesOf(widths: string): string {
  return [...widths].map((w, i) => (i % 2 === 0 ? "1" : "0").repeat(Number(w))).join("");
}

/** The barcode's modules, or null when the text is empty or not all in Code Set B. */
export function code128Modules(text: string): string | null {
  if (text === "") return null;
  const values: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_B || code > LAST_B) return null;
    values.push(code - FIRST_B);
  }
  const weighted = values.reduce((total, value, i) => total + value * (i + 1), START_B);
  const symbols = [START_B, ...values, weighted % CHECK_MODULUS];
  return (
    symbols.map((value) => modulesOf(CODE128_PATTERNS[value])).join("") + modulesOf(CODE128_STOP)
  );
}
