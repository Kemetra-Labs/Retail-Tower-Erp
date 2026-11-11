/**
 * vouchers-pos.dto.ts — RT-1112: the request boundary of Contract V-A
 * (`pos-payments/vouchers.yaml`).
 *
 * Every body is strict (an unknown field, a tenant or a store is refused), and a
 * failed parse is the contract's 400 `validation_failure`
 * (`ContractValidationPipe`, shared with the issuance routes). The money fields
 * are integers within the 0092 CHECK bound (2^53 - 1), so an out-of-range amount
 * is a 400, never the database's 23514. A zero `applied_amount_minor` is
 * refused here too: a voucher is consumed whole (decision 1A), so applying
 * nothing would forfeit all of it (contract, `posValidateVoucher`).
 */
import { z } from "zod";

const MONEY_MAX = Number.MAX_SAFE_INTEGER;
const money = z.number().int().min(0).max(MONEY_MAX);
const uuid = z.string().uuid().transform((id) => id.toLowerCase());

export const ValidateVoucherSchema = z
  .object({
    operatorUserId: uuid,
    code: z.string().min(1).max(64),
    payment_attempt_id: uuid,
    applied_amount_minor: money.refine((amount) => amount > 0, "a voucher is consumed whole: apply a positive amount"),
    remaining_balance_minor: money,
  })
  .strict();
export type ValidateVoucherDto = z.infer<typeof ValidateVoucherSchema>;

export const RedeemVoucherSchema = z
  .object({
    operatorUserId: uuid,
    redemption_intent_token: z.string().min(32).max(256),
    payment_attempt_id: uuid,
  })
  .strict();
export type RedeemVoucherDto = z.infer<typeof RedeemVoucherSchema>;

export const ReverseVoucherSchema = z
  .object({
    redemption_id: uuid,
  })
  .strict();
export type ReverseVoucherDto = z.infer<typeof ReverseVoucherSchema>;

/** `PosValidateVoucherResponse`. */
export interface ValidateVoucherBody {
  readonly kind: "validated";
  readonly redemption_intent_token: string;
  readonly applied_amount_minor: number;
  readonly forfeited_amount_minor: number;
  readonly intent_expires_at: string;
}

/** `PosRedeemVoucherResponse`. */
export interface RedeemVoucherBody {
  readonly kind: "redeemed";
  readonly redemption_id: string;
  readonly redeemed_at: string;
  readonly idempotent_replayed: boolean;
}

/** `PosReverseVoucherResponse`. */
export interface ReverseVoucherBody {
  readonly kind: "reversed";
  readonly redemption_id: string;
  readonly reversed_at: string;
  readonly already_reversed: boolean;
}
