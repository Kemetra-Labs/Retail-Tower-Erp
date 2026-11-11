/**
 * RT-1108 — voucher code generation, normalisation and hashing (RT-922 section 5.3).
 * Docker-free. The format regex is the contract's `IssuedVoucher.code` pattern.
 */
import { createHash } from "node:crypto";

import { hashToken } from "@data-pulse-2/auth";

import {
  formatVoucherCode,
  generateVoucherCode,
  hashVoucherCode,
  normaliseVoucherCode,
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_LENGTH,
} from "../../src/vouchers-admin/voucher-code";

const CONTRACT_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

describe("voucher codes", () => {
  it("uses the 32-symbol Crockford alphabet without I, L, O, U", () => {
    expect(VOUCHER_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(VOUCHER_CODE_ALPHABET).size).toBe(32);
    for (const banned of "ILOU") expect(VOUCHER_CODE_ALPHABET).not.toContain(banned);
  });

  it("generates 16 alphabet characters and formats as the contract pattern", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateVoucherCode();
      expect(code).toHaveLength(VOUCHER_CODE_LENGTH);
      expect([...code].every((c) => VOUCHER_CODE_ALPHABET.includes(c))).toBe(true);
      expect(formatVoucherCode(code)).toMatch(CONTRACT_CODE);
    }
  });

  it("formats in four groups of four", () => {
    expect(formatVoucherCode("0123456789ABCDEF")).toBe("0123-4567-89AB-CDEF");
  });

  it("is unique across a large batch (5000 codes, 80 bits each)", () => {
    const codes = new Set(Array.from({ length: 5000 }, () => generateVoucherCode()));
    expect(codes.size).toBe(5000);
  });

  it("reaches every symbol of the alphabet (no dead position or symbol)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) for (const c of generateVoucherCode()) seen.add(c);
    expect(seen.size).toBe(32);
  });

  it("normalises case, hyphens and whitespace the same way", () => {
    expect(normaliseVoucherCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normaliseVoucherCode(" ABCD EFGH\tJKMN-PQRS ")).toBe("ABCDEFGHJKMNPQRS");
    expect(normaliseVoucherCode("ABCDEFGHJKMNPQRS")).toBe("ABCDEFGHJKMNPQRS");
  });

  it("hashes the normalised code with hashToken (sha-256), however it was typed", () => {
    const shown = "0123-4567-89AB-CDEF";
    const expected = hashToken("0123456789ABCDEF");
    expect(expected.equals(createHash("sha256").update("0123456789ABCDEF", "utf8").digest())).toBe(true);
    expect(hashVoucherCode(shown).equals(expected)).toBe(true);
    expect(hashVoucherCode("0123 4567 89ab cdef").equals(expected)).toBe(true);
    expect(hashVoucherCode("0123456789abcdef").equals(expected)).toBe(true);
    expect(hashVoucherCode("0123-4567-89AB-CDEE").equals(expected)).toBe(false);
  });
});
