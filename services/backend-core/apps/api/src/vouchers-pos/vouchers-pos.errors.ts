/**
 * vouchers-pos.errors.ts — RT-1112: the V-A refusals as one domain error class
 * carrying a closed-set code, and its HTTP mapping (`pos-payments/vouchers.yaml`).
 *
 *   validate: 404 `voucher_not_found` (also another tenant's code: the same
 *             non-disclosing body); 400 for every other refusal
 *             (`voucher_cancelled`, `voucher_already_redeemed`, `voucher_expired`,
 *             `voucher_branch_mismatch`, `non_cash_overpayment_refused`).
 *   redeem:   404 `intent_token_not_found` (unknown, another tenant's or another
 *             store's token, or one already consumed); 400 `intent_token_expired`
 *             and `intent_token_payment_attempt_mismatch`; 409 for the voucher
 *             states (`voucher_already_redeemed`, `voucher_cancelled`,
 *             `voucher_expired`, `voucher_branch_mismatch`).
 *   reverse:  404 `redemption_not_found` (also another tenant's id); 400
 *             `redemption_branch_mismatch` (a redemption of another store of the
 *             same tenant: "same store, any device", RT-1110 c16417).
 *
 * Messages are fixed text: never a code, a token, an amount or an id.
 */
import { HttpException, HttpStatus } from "@nestjs/common";

export type VoucherRefusalCode =
  | "voucher_not_found"
  | "voucher_cancelled"
  | "voucher_already_redeemed"
  | "voucher_expired"
  | "voucher_branch_mismatch"
  | "non_cash_overpayment_refused"
  | "intent_token_not_found"
  | "intent_token_expired"
  | "intent_token_payment_attempt_mismatch"
  | "redemption_not_found"
  | "redemption_branch_mismatch";

export type VoucherOperation = "validate" | "redeem" | "reverse";

export class VoucherRefusal extends Error {
  constructor(readonly code: VoucherRefusalCode) {
    super(code);
    this.name = "VoucherRefusal";
  }
}

const MESSAGES: Readonly<Record<VoucherRefusalCode, string>> = {
  voucher_not_found: "Voucher not found.",
  voucher_cancelled: "The voucher was cancelled.",
  voucher_already_redeemed: "The voucher was already redeemed.",
  voucher_expired: "The voucher has expired.",
  voucher_branch_mismatch: "The voucher is not valid in this store.",
  non_cash_overpayment_refused: "The amount exceeds the voucher value or the remaining balance.",
  intent_token_not_found: "Redemption intent not found.",
  intent_token_expired: "The redemption intent has expired. Validate the voucher again.",
  intent_token_payment_attempt_mismatch: "The redemption intent belongs to another payment attempt.",
  redemption_not_found: "Redemption not found.",
  redemption_branch_mismatch: "The redemption belongs to another store.",
};

const NOT_FOUND = new Set<VoucherRefusalCode>(["voucher_not_found", "intent_token_not_found", "redemption_not_found"]);
const REDEEM_CONFLICTS = new Set<VoucherRefusalCode>([
  "voucher_already_redeemed",
  "voucher_cancelled",
  "voucher_expired",
  "voucher_branch_mismatch",
]);

/** The HTTP status of a refusal on an operation (see the file header). */
export function refusalStatus(operation: VoucherOperation, code: VoucherRefusalCode): number {
  if (NOT_FOUND.has(code)) return HttpStatus.NOT_FOUND;
  if (operation === "redeem" && REDEEM_CONFLICTS.has(code)) return HttpStatus.CONFLICT;
  return HttpStatus.BAD_REQUEST;
}

export function toHttpRefusal(operation: VoucherOperation, refusal: VoucherRefusal): HttpException {
  return new HttpException({ code: refusal.code, message: MESSAGES[refusal.code] }, refusalStatus(operation, refusal.code));
}
