/**
 * voucher-redemption-reversal.ts — RT-1343 (items 1 and 3): the one place a
 * voucher redemption is reversed, on the caller's own transaction.
 *
 * Two callers, one body:
 *   - `POST /api/pos/v1/vouchers/reverse` (`VouchersPosService.reverse`);
 *   - a full sale void of a voucher-paid sale (`SalesService.recordVoid`), which
 *     passes `allowConsumingSaleId` so its own sale's tender does not block it
 *     (owner decision 2026-11-12: a void RESTORES the voucher).
 *
 * Lock order (the same everywhere, so no deadlock): sale (void only) → voucher
 * → redemption. Redeem and cancel lock the voucher only; capture
 * (`assertVoucherTendersRedeemed`) locks the redemption only.
 *
 * Why the explicit redemption lock: the `sale_tenders.redemption_id` FK takes
 * only `KEY SHARE` on the redemption, which does not conflict with an UPDATE of
 * non-key columns, so without it a reverse could commit while a capture that
 * already passed its checks is still writing its tender. Two `FOR NO KEY UPDATE`
 * locks do conflict, so a capture and a reverse of one redemption run one after
 * the other, and the consumed check below (its own statement, so READ COMMITTED
 * sees what the winning capture committed) is exact:
 *   - capture first: its tender is committed when the reverse reads → refused;
 *   - reverse first: the capture then reads `reversed_at IS NOT NULL` → 422.
 *
 * The already-reversed early return stays BEFORE the consumed check: after a
 * void restored the voucher, a POS retry of the reverse is a 200 with
 * `already_reversed: true`, never a 409.
 *
 * A broken invariant (a redemption of another store on the void path, a voucher
 * that is not `redeemed` while its redemption is open) is a plain `Error`: it
 * fails closed and rolls the whole transaction back, a void included.
 */
import type { PoolClient } from "pg";

import { VoucherRefusal } from "./vouchers-pos.errors";
import { insertVoucherPosAudit, VOUCHER_REVERSED_ACTION } from "./vouchers-pos-audit";
import {
  LOCK_REDEMPTION_SQL,
  LOCK_VOUCHER_SQL,
  REDEMPTION_CONSUMED_BY_SALE_SQL,
  REDEMPTION_SQL,
  RESTORE_VOUCHER_SQL,
  REVERSE_REDEMPTION_SQL,
} from "./vouchers-pos.queries";

export interface RedemptionRow {
  readonly id: string;
  readonly store_id: string;
  readonly voucher_id: string;
  readonly payment_attempt_id: string;
  readonly operator_user_id: string;
  readonly applied_amount_minor: string;
  readonly reversed_at: Date | null;
}

export interface ReverseRedemptionInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** The device doing the reversing (`reversed_by_device_id`, the audit row). */
  readonly deviceId: string;
  readonly requestId: string | null;
  readonly redemptionId: string;
  /** The one sale whose tender may reference the redemption: the void's own sale. */
  readonly allowConsumingSaleId?: string;
}

export interface ReverseRedemptionResult {
  readonly redemptionId: string;
  readonly reversedAt: Date;
  /** True when the redemption was already reversed: nothing was changed. */
  readonly alreadyReversed: boolean;
}

/**
 * Reverse a redemption on `client` (an open tenant-scoped transaction).
 * Refusals: `redemption_not_found` (also another tenant's id),
 * `redemption_branch_mismatch`, and `redemption_consumed_by_sale` (a sale tender
 * other than `allowConsumingSaleId` uses it).
 */
export async function reverseRedemptionInTx(
  client: PoolClient,
  input: ReverseRedemptionInput,
): Promise<ReverseRedemptionResult> {
  const { tenantId, storeId, deviceId, redemptionId } = input;
  const first = await client.query<RedemptionRow>(REDEMPTION_SQL, [tenantId, redemptionId]);
  const seen = first.rows[0];
  if (!seen) throw new VoucherRefusal("redemption_not_found");
  if (seen.store_id !== storeId) throw new VoucherRefusal("redemption_branch_mismatch");

  // Voucher row first, as redeem and cancel lock it: one lock order, no deadlock.
  await client.query(LOCK_VOUCHER_SQL, [tenantId, seen.voucher_id]);
  // Then the redemption, which also re-reads it as it is after any lock wait.
  const locked = await client.query<RedemptionRow>(LOCK_REDEMPTION_SQL, [tenantId, redemptionId]);
  const redemption = locked.rows[0];
  if (!redemption) throw new Error("a redemption vanished under the voucher lock");
  if (redemption.reversed_at !== null) {
    return { redemptionId: redemption.id, reversedAt: redemption.reversed_at, alreadyReversed: true };
  }

  // A separate statement: it sees a capture that committed while we waited above.
  const consumed = await client.query<{ consumed: boolean }>(REDEMPTION_CONSUMED_BY_SALE_SQL, [
    tenantId,
    redemption.id,
    input.allowConsumingSaleId ?? null,
  ]);
  if (consumed.rows[0]?.consumed === true) throw new VoucherRefusal("redemption_consumed_by_sale");

  const won = await client.query<{ reversed_at: Date }>(REVERSE_REDEMPTION_SQL, [tenantId, redemption.id, deviceId]);
  const reversedAt = won.rows[0]?.reversed_at;
  if (!reversedAt) throw new Error("a redemption changed under the voucher lock");
  const restored = await client.query(RESTORE_VOUCHER_SQL, [tenantId, redemption.voucher_id]);
  if (restored.rowCount !== 1) throw new Error("the redeemed voucher of an open redemption is not 'redeemed'");
  await insertVoucherPosAudit(client, {
    tenantId,
    storeId,
    // The redeem-time cashier: the reverse carries no claim (RT-1110).
    actorUserId: redemption.operator_user_id,
    requestId: input.requestId,
    action: VOUCHER_REVERSED_ACTION,
    voucherId: redemption.voucher_id,
    metadata: {
      voucher_id: redemption.voucher_id,
      redemption_id: redemption.id,
      payment_attempt_id: redemption.payment_attempt_id,
      applied_amount_minor: Number(redemption.applied_amount_minor),
      reversed_by_device_id: deviceId,
      ...(input.allowConsumingSaleId === undefined ? {} : { sale_id: input.allowConsumingSaleId }),
    },
  });
  return { redemptionId: redemption.id, reversedAt, alreadyReversed: false };
}
