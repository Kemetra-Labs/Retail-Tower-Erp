import { CODE128_PATTERNS, CODE128_STOP, code128Modules } from "@/devices/code128";
import { describe, expect, test } from "vitest";

/**
 * RT-1316 (AC7) — the hand-written Code 128 encoder behind the pairing-code
 * barcode. The literal module strings below come from an independent encoder
 * built on the binary-pattern column of the Code 128 symbol table, not from this
 * module's widths table, so a typo in either one fails here. The codes are fake.
 */
const sum = (widths: string) => [...widths].reduce((total, w) => total + Number(w), 0);

describe("the Code 128 symbol table", () => {
  test("106 symbols of three bars and three spaces, 11 modules each, all distinct", () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
    for (const widths of CODE128_PATTERNS) {
      expect(widths, widths).toMatch(/^[1-4]{6}$/);
      expect(sum(widths), widths).toBe(11);
    }
  });

  test("the stop pattern is 13 modules", () => {
    expect(CODE128_STOP).toBe("2331112");
    expect(sum(CODE128_STOP)).toBe(13);
  });
});

describe("code128Modules (Code Set B)", () => {
  test.each([
    [
      "FAKETESTCODE0000",
      "1101001000010001100010101000110001011000111010001101000110111000101000110100011011101000110111000101000100011010001110110101100010001000110100010011101100100111011001001110110010011101100101100001001100011101011",
    ],
    [
      "ABCDEFGHJKMNPQRS",
      "1101001000010100011000100010110001000100011010110001000100011010001000110001011010001000110001010001011011100010110001110101110110001011100011011101110110110100011101100010111011011101000110001001001100011101011",
    ],
  ])("%s matches the independent encoding", (text, modules) => {
    expect(code128Modules(text)).toBe(modules);
  });

  test("16 characters are 211 modules: start, data, check, stop", () => {
    expect(code128Modules("ABCD2345EFGH6789")).toHaveLength(11 * 18 + 13);
  });

  test("starts with a bar, ends with the stop's final bar", () => {
    const modules = code128Modules("ABCD2345EFGH6789") ?? "";
    expect(modules.startsWith("1")).toBe(true);
    expect(modules.endsWith("11")).toBe(true);
  });

  test("empty text or a character outside Code Set B has no barcode", () => {
    expect(code128Modules("")).toBeNull();
    expect(code128Modules("ABC\u0007")).toBeNull();
    expect(code128Modules("رمز")).toBeNull();
  });
});
