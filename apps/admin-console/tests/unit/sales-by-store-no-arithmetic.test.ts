import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * RT-1054 AC 2 (AI-13, spec 009 AC-9): the Console presents the server's
 * figures as given and never sums, subtracts or divides one. This is the static
 * half of the evidence; the page tests are the behavioural half (they assert
 * the printed strings are the served ones). It scans the report's own code,
 * comments removed, for every way a figure could be turned into a number.
 */

const ROOT = join(__dirname, "..", "..", "src");
const FILES = [
  ...readdirSync(join(ROOT, "sales-by-store"))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => join(ROOT, "sales-by-store", f)),
  join(ROOT, "lib", "sales-by-store-queries.ts"),
];

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Anything that parses a served string into a number, or rounds or scales one. */
const NUMERIC_CONVERSION =
  /\bparseFloat\b|\bparseInt\b|\bNumber\s*\(|\bBigInt\b|\.toFixed\b|\.toPrecision\b|\bMath\.|\bunary\s*\+|Intl\.NumberFormat|\+\s*(?:ranking|store|facts|report)\./;

/** A reduce or an accumulating `+=` is how a list of figures becomes a sum. */
const ACCUMULATION = /\+=|-=|\*=|\/=|\.reduce\s*\(\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\w+\s*\+/;

describe("the report does no arithmetic on figures (RT-1054 AC 2)", () => {
  test("the scan covers the report's code", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of FILES) {
    const name = file.slice(ROOT.length + 1);
    test(`${name} converts no figure to a number`, () => {
      expect(code(file)).not.toMatch(NUMERIC_CONVERSION);
    });
    test(`${name} accumulates nothing`, () => {
      expect(code(file)).not.toMatch(ACCUMULATION);
    });
  }

  test("ranks and ratios are printed from the served fields, not derived", () => {
    const logic = code(join(ROOT, "sales-by-store", "storeLogic.ts"));
    // A rank change is never `rank - baselineRank`, a share never `total / scope`.
    expect(logic).not.toMatch(/rank\s*-\s*\w*baselineRank|baselineRank\s*-\s*\w*rank/i);
    expect(logic).not.toMatch(/total\s*\/\s*\w*total/i);
  });
});
