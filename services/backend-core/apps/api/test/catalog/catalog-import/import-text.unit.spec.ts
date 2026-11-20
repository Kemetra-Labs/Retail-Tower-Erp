/**
 * RT-1505 (spec 049 §5, OD-10 A): the import's text rules, and the pinned
 * parser versions the batch records.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { CSV_PARSER_VERSION, XLSX_PARSER_VERSION } from "../../../src/catalog/catalog-import/catalog-import.limits";
import { charCount, isBlankText, isStorableText, trimImportText } from "../../../src/catalog/catalog-import/import-text";
import { isPlainTextCell } from "../../../src/catalog/catalog-import/staged-cell";

describe("trimImportText: Unicode White_Space plus the bidi marks, at the edges only", () => {
  it.each([
    ["spaces and tabs", "  a\t", "a"],
    ["NBSP", "\u{a0}a\u{a0}", "a"],
    ["bidi marks U+200E, U+200F and U+061C", "\u{200e}\u{200f}\u{61c}a\u{61c}\u{200f}", "a"],
    ["mixed", " \u{200f}\u{a0}\t a b \u{a0}\u{200e}", "a b"],
    ["an Arabic value with a right-to-left mark", "\u{200f}\u{634}\u{627}\u{64a} ", "\u{634}\u{627}\u{64a}"],
    ["other Unicode spaces (U+2003, U+3000)", "\u{2003}a\u{3000}", "a"],
  ])("trims %s", (_label, input, expected) => {
    expect(trimImportText(input)).toBe(expected);
  });

  it("keeps whitespace and bidi marks inside the text (inside an identifier they are a validate error, not a trim)", () => {
    expect(trimImportText("a\u{a0}b")).toBe("a\u{a0}b");
    expect(trimImportText("a\u{200f}b")).toBe("a\u{200f}b");
  });

  it("does not normalise: case and digit scripts are kept", () => {
    expect(trimImportText(" ABC \u{660}\u{661}")).toBe("ABC \u{660}\u{661}");
  });

  it("recognises blank text", () => {
    expect(isBlankText("")).toBe(true);
    expect(isBlankText(" \u{a0}\u{200f}\u{61c}\t")).toBe(true);
    expect(isBlankText(" a ")).toBe(false);
  });
});

describe("trimImportText is linear on adversarial input (security review of PR #761, M6)", () => {
  const adversarial = [
    `${" ".repeat(1999)}a`,
    `a${" ".repeat(1999)}`,
    " a".repeat(1000),
    `${"\u{a0}".repeat(1000)}x${"\u{200f}".repeat(999)}`,
    `${" ".repeat(1000)}${"a".repeat(500)}${" ".repeat(500)}`,
  ];

  it("trims 2,000-character cells, 200 times each, in well under a second", () => {
    const started = process.hrtime.bigint();
    for (let i = 0; i < 200; i += 1) for (const text of adversarial) trimImportText(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(1000);
  });

  it("gives the same answer as the definition", () => {
    expect(trimImportText(adversarial[0] as string)).toBe("a");
    expect(trimImportText(adversarial[1] as string)).toBe("a");
    expect(trimImportText(adversarial[2] as string)).toBe(`a${" a".repeat(999)}`);
    expect(trimImportText(adversarial[3] as string)).toBe("x");
    expect(trimImportText(adversarial[4] as string)).toBe("a".repeat(500));
    expect(trimImportText("   ")).toBe("");
    expect(trimImportText("")).toBe("");
    expect(isBlankText(" ".repeat(2000))).toBe(true);
    expect(isBlankText(`${" ".repeat(1999)}a`)).toBe(false);
  });
});

describe("storable text and length", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(charCount("abc")).toBe(3);
    expect(charCount("\u{1f600}\u{1f600}")).toBe(2);
    expect("\u{1f600}".length).toBe(2);
  });

  it("refuses text jsonb cannot store: NUL and a lone surrogate", () => {
    expect(isStorableText("plain \u{633}")).toBe(true);
    expect(isStorableText("with \u{1f600} astral")).toBe(true);
    expect(isStorableText("a\u{0}b")).toBe(false);
    expect(isStorableText(String.fromCharCode(0xd800))).toBe(false);
    expect(isStorableText(String.fromCharCode(0xdc00, 0x61))).toBe(false);
    expect(isStorableText(`a${String.fromCharCode(0xd83d)}`)).toBe(false);
  });

  it("tells a plain text cell from a typed one", () => {
    expect(isPlainTextCell(null)).toBe(true);
    expect(isPlainTextCell("x")).toBe(true);
    expect(isPlainTextCell({ t: "n", v: "1" })).toBe(false);
    expect(isPlainTextCell({ t: "f", v: "x" })).toBe(false);
  });
});

describe("the parser versions the batch records", () => {
  const pins = JSON.parse(readFileSync(path.join(__dirname, "../../../package.json"), "utf8")) as { dependencies: Record<string, string> };

  it("name the exact versions apps/api pins (RT-1504), so a bump cannot leave a stale recording", () => {
    expect(CSV_PARSER_VERSION).toBe(`csv-parse@${pins.dependencies["csv-parse"]}`);
    expect(XLSX_PARSER_VERSION.startsWith(`read-excel-file@${pins.dependencies["read-excel-file"]}+`)).toBe(true);
  });
});
