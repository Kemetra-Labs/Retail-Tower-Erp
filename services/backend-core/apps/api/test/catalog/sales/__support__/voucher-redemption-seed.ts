/**
 * voucher-redemption-seed.ts — RT-1343: a voucher, its consumed intent and its
 * redemption, written as the superuser (the capture harness' `env.admin`), for
 * specs that pay a sale with a `voucher` tender (RT-1114) and then void or
 * reverse it. Not a spec file (no `.spec`), so Jest's testMatch ignores it.
 *
 * Ids: `seed.id` must end in `0e<3 hex digits>`; the voucher and the intent
 * take the same tail with `0c` and `0d`, so one id names all three rows.
 * Each redemption owns its voucher (decision 1A: one open redemption per voucher).
 */
import type { PgTestEnv } from "../capture/__capture-harness";

export interface RedemptionSeed {
  /** The redemption id, ending in `0e<3 hex digits>`. */
  readonly id: string;
  readonly tenant: string;
  readonly store: string;
  /** The device that redeemed it (a `devices` row of `store`). */
  readonly device: string;
  /** The voucher's batch id and the redeem-time cashier (no FK needed). */
  readonly batch: string;
  readonly cashier: string;
  readonly attempt: string;
  readonly currency?: string;
  readonly appliedMinor?: number;
  /** Seed an already reversed redemption (the voucher is `active`). */
  readonly reversed?: boolean;
}

export const voucherIdOf = (redemptionId: string): string => redemptionId.replace(/0e(\d{3})$/, "0c$1");

export async function seedRedemption(admin: PgTestEnv["admin"], seed: RedemptionSeed): Promise<void> {
  const voucher = voucherIdOf(seed.id);
  const intent = seed.id.replace(/0e(\d{3})$/, "0d$1");
  const hex = seed.id.slice(-2);
  const applied = seed.appliedMinor ?? 1000;
  await admin.query(
    `INSERT INTO vouchers (id, tenant_id, batch_id, code_hash, amount_minor, currency_code, applies_to_all_stores, issued_by_user_id, status)
     VALUES ($1, $2, $3, decode(repeat($4, 32), 'hex'), $5, $6, true, $7, $8)`,
    [voucher, seed.tenant, seed.batch, hex, applied, seed.currency ?? "USD", seed.cashier, seed.reversed ? "active" : "redeemed"],
  );
  await admin.query(
    `INSERT INTO voucher_redemption_intents
       (id, tenant_id, store_id, voucher_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor,
        token_hash, operator_user_id, device_id, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, decode(repeat($7, 32), 'hex'), $8, $9, now() + interval '4 minutes', now())`,
    [intent, seed.tenant, seed.store, voucher, seed.attempt, applied, hex, seed.cashier, seed.device],
  );
  await admin.query(
    `INSERT INTO voucher_redemptions
       (id, tenant_id, store_id, voucher_id, intent_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor,
        operator_user_id, device_id, reversed_at, reversed_by_device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9,
             CASE WHEN $10 THEN now() END, CASE WHEN $10 THEN $9::uuid END)`,
    [seed.id, seed.tenant, seed.store, voucher, intent, seed.attempt, applied, seed.cashier, seed.device, seed.reversed === true],
  );
}
