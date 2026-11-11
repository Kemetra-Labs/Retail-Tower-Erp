/**
 * Voucher code generation, normalisation and hashing (RT-1108, RT-922 section 5.3).
 *
 * A code is 16 characters of Crockford base32 (no I, L, O or U), shown as
 * `XXXX-XXXX-XXXX-XXXX`, about 80 bits of entropy. The server generates it; it
 * is stored only as `hashToken(normalise(code))` and appears in the issue
 * response alone. `normaliseVoucherCode` and `hashVoucherCode` are the shared
 * input path: redemption (RT-1110 and later) hashes what a till types the same
 * way, so a typed code with lower case, hyphens or spaces still matches.
 */
import { randomInt } from "node:crypto";

import { hashToken } from "@data-pulse-2/auth";

/** Crockford base32 without I, L, O, U. 32 symbols, so `randomInt(32)` is unbiased. */
export const VOUCHER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const VOUCHER_CODE_LENGTH = 16;
const GROUP_SIZE = 4;

/** A fresh, normalised (undashed) code. */
export function generateVoucherCode(): string {
  let code = "";
  for (let i = 0; i < VOUCHER_CODE_LENGTH; i += 1) {
    code += VOUCHER_CODE_ALPHABET[randomInt(VOUCHER_CODE_ALPHABET.length)];
  }
  return code;
}

/** `XXXX-XXXX-XXXX-XXXX`, the form shown to the issuer (and the contract's `code` pattern). */
export function formatVoucherCode(normalised: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalised.length; i += GROUP_SIZE) groups.push(normalised.slice(i, i + GROUP_SIZE));
  return groups.join("-");
}

/** Upper case, hyphens and whitespace removed (RT-922 section 5.3). */
export function normaliseVoucherCode(input: string): string {
  return input.replace(/[-\s]+/g, "").toUpperCase();
}

/** The `vouchers.code_hash` of a code, however it was typed. */
export function hashVoucherCode(input: string): Buffer {
  return hashToken(normaliseVoucherCode(input));
}
