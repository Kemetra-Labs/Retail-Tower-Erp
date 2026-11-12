/**
 * VouchersPosService — RT-1112 (RT-1098 slice R-3): the V-A runtime
 * (`pos-payments/vouchers.yaml`): validate, redeem and reverse.
 *
 * Scope (tenant, store, device) comes only from the authenticated device; the
 * cashier only from the guard's verified claim. Every statement runs under the
 * device's tenant (RLS) and names `tenant_id`; another tenant's code, token or
 * redemption is therefore the same 404 as an unknown one.
 *
 * validate (one transaction):
 *   take a failed-lookup hit → look up `hashVoucherCode(code)` → 404
 *   `voucher_not_found` (the hit stays) → give the hit back → refuse a
 *   cancelled, redeemed, expired (wall clock) or ineligible voucher → refuse an
 *   applied amount above the voucher value or the remaining balance
 *   (`non_cash_overpayment_refused`) → insert one intent (only the token's hash;
 *   `expires_at = now() + 240 s`) → audit `voucher.validated` → the 200 with the
 *   token and `forfeited_amount_minor` (decision 1A).
 *
 * redeem (one transaction):
 *   take a hit → look up the intent by `hashToken(token)` → 404
 *   `intent_token_not_found` when unknown, of another store, or consumed (the
 *   hit stays only for the first two) → 400 `intent_token_payment_attempt_mismatch`
 *   → 400 `intent_token_expired` → lock the voucher row (`FOR UPDATE`) → the
 *   intent consumed meanwhile (the same token, concurrently): 404 → read its
 *   state after the lock: 409 `voucher_already_redeemed`, `voucher_cancelled`,
 *   `voucher_expired`, `voucher_branch_mismatch` → consume the intent (a
 *   conditional UPDATE, database clock) → the conditional voucher UPDATE with
 *   the `clock_timestamp()` expiry predicate (the guard; zero rows re-reads:
 *   cancelled first, then expired) → insert the redemption with the intent's
 *   binding columns → audit `voucher.redeemed`.
 *   Two redeems of one voucher serialize on the row lock: exactly one wins, the
 *   other reads `redeemed`. A cancel racing a redeem is the same: the cancel's
 *   `WHERE status = 'active'` UPDATE waits on the lock.
 *
 * reverse (one transaction, `reverseRedemptionInTx`):
 *   read the redemption → 404 `redemption_not_found` → 400
 *   `redemption_branch_mismatch` for another store (same store, any device) →
 *   lock the voucher (the same lock order as redeem), then the redemption →
 *   already reversed: 200 with the original `reversed_at` and
 *   `already_reversed: true` → a sale tender pays with it: 409
 *   `redemption_consumed_by_sale` (RT-1343; only the sale's void reverses it) →
 *   reverse it (`reversed_at = now()`, the reversing device) → restore the
 *   voucher to `active` (an expired voucher too: decision 2, RT-1112 c16636) →
 *   audit `voucher.reversed`, attributed to the redeem-time cashier.
 *
 * Secrecy: the code and the token are never logged or audited, and this
 * service stores only their hashes. One accepted exception: the validate 200
 * (token and `forfeited_amount_minor`) is kept by the idempotency layer for its
 * replay, for no longer than the intent lives (`VALIDATE_REPLAY_TTL_SEC`), so a
 * same-key retry gets the same answer (contract V-A). A stored token is
 * single-use, bound to its store and attempt, needs a live cashier of that store
 * to redeem, and is dead once its intent expires. The code never reaches
 * idempotency storage (only the request body's hash does).
 */
import { Inject, Injectable } from "@nestjs/common";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { hashVoucherCode } from "../vouchers-admin/voucher-code";
import type {
  RedeemVoucherBody,
  RedeemVoucherDto,
  ReverseVoucherBody,
  ReverseVoucherDto,
  ValidateVoucherBody,
  ValidateVoucherDto,
} from "./vouchers-pos.dto";
import { VoucherRefusal } from "./vouchers-pos.errors";
import {
  insertVoucherPosAudit,
  VOUCHER_REDEEMED_ACTION,
  VOUCHER_VALIDATED_ACTION,
} from "./vouchers-pos-audit";
import {
  CONSUME_INTENT_SQL,
  INSERT_INTENT_SQL,
  INSERT_REDEMPTION_SQL,
  INTENT_BY_TOKEN_SQL,
  INTENT_CONSUMED_SQL,
  LOCK_VOUCHER_SQL,
  REDEEM_VOUCHER_SQL,
  VALIDATE_LOOKUP_SQL,
  VOUCHER_STATE_SQL,
} from "./vouchers-pos.queries";
import { VoucherLookupLimiter } from "./voucher-lookup-limit";
import { reverseRedemptionInTx } from "./voucher-redemption-reversal";

/** The authenticated device: the only source of scope. */
export interface DeviceCaller {
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly requestId: string | null;
}

/** A device with the guard's VERIFIED cashier (validate, redeem). */
export interface CashierCaller extends DeviceCaller {
  readonly cashierUserId: string;
}

interface VoucherStateRow {
  readonly status: string;
  readonly expired: boolean;
  readonly eligible: boolean;
}

interface IntentRow {
  readonly id: string;
  readonly store_id: string;
  readonly voucher_id: string;
  readonly payment_attempt_id: string;
  readonly applied_amount_minor: string;
  readonly forfeited_amount_minor: string;
  readonly consumed_at: Date | null;
  readonly live: boolean;
}

@Injectable()
export class VouchersPosService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly lookups: VoucherLookupLimiter,
  ) {}

  async validate(caller: CashierCaller, body: ValidateVoucherDto): Promise<ValidateVoucherBody> {
    const hit = await this.lookups.take(caller.deviceId);
    return runWithTenantContext(this.pool, tenantScope(caller.tenantId), async (client) => {
      const found = await client.query<VoucherStateRow & { id: string; amount_minor: string }>(VALIDATE_LOOKUP_SQL, [
        caller.tenantId,
        hashVoucherCode(body.code),
        caller.storeId,
      ]);
      const voucher = found.rows[0];
      if (!voucher) throw new VoucherRefusal("voucher_not_found");
      await this.lookups.giveBack(hit);
      refuseUnusable(voucher);

      const value = Number(voucher.amount_minor);
      if (body.applied_amount_minor > value || body.applied_amount_minor > body.remaining_balance_minor) {
        throw new VoucherRefusal("non_cash_overpayment_refused");
      }
      const forfeited = value - body.applied_amount_minor;
      const token = generateRawToken();
      const inserted = await client.query<{ id: string; expires_at: Date }>(INSERT_INTENT_SQL, [
        caller.tenantId,
        caller.storeId,
        voucher.id,
        body.payment_attempt_id,
        body.applied_amount_minor,
        forfeited,
        hashToken(token),
        caller.cashierUserId,
        caller.deviceId,
      ]);
      const intent = inserted.rows[0]!;
      await insertVoucherPosAudit(client, {
        tenantId: caller.tenantId,
        storeId: caller.storeId,
        actorUserId: caller.cashierUserId,
        requestId: caller.requestId,
        action: VOUCHER_VALIDATED_ACTION,
        voucherId: voucher.id,
        metadata: {
          voucher_id: voucher.id,
          intent_id: intent.id,
          payment_attempt_id: body.payment_attempt_id,
          applied_amount_minor: body.applied_amount_minor,
          device_id: caller.deviceId,
        },
      });
      return {
        kind: "validated",
        redemption_intent_token: token,
        applied_amount_minor: body.applied_amount_minor,
        forfeited_amount_minor: forfeited,
        intent_expires_at: intent.expires_at.toISOString(),
      };
    });
  }

  async redeem(caller: CashierCaller, body: RedeemVoucherDto): Promise<RedeemVoucherBody> {
    const hit = await this.lookups.take(caller.deviceId);
    return runWithTenantContext(this.pool, tenantScope(caller.tenantId), async (client) => {
      const found = await client.query<IntentRow>(INTENT_BY_TOKEN_SQL, [caller.tenantId, hashToken(body.redemption_intent_token)]);
      const intent = found.rows[0];
      // Another store's intent is the same 404: an intent is bound to its store.
      if (!intent || intent.store_id !== caller.storeId) throw new VoucherRefusal("intent_token_not_found");
      await this.lookups.giveBack(hit);
      if (intent.payment_attempt_id !== body.payment_attempt_id) {
        throw new VoucherRefusal("intent_token_payment_attempt_mismatch");
      }
      if (intent.consumed_at !== null) throw new VoucherRefusal("intent_token_not_found");
      if (!intent.live) throw new VoucherRefusal("intent_token_expired");

      await client.query(LOCK_VOUCHER_SQL, [caller.tenantId, intent.voucher_id]);
      // The same token redeemed concurrently (a retry under a new key) waited on
      // the lock: its own redemption consumed the intent, so it is the 404, never
      // a `voucher_already_redeemed` that reads as another attempt's (review, PR).
      const recheck = await client.query<{ consumed: boolean }>(INTENT_CONSUMED_SQL, [caller.tenantId, intent.id]);
      if (recheck.rows[0]?.consumed === true) throw new VoucherRefusal("intent_token_not_found");
      const state = await voucherState(client, caller, intent.voucher_id);
      refuseUnusable(state);

      const consumed = await client.query(CONSUME_INTENT_SQL, [caller.tenantId, intent.id]);
      if (consumed.rowCount !== 1) {
        // Consumed or expired between the read and the update (database clock).
        const again = await client.query<IntentRow>(INTENT_BY_TOKEN_SQL, [caller.tenantId, hashToken(body.redemption_intent_token)]);
        throw new VoucherRefusal(again.rows[0]?.consumed_at === null ? "intent_token_expired" : "intent_token_not_found");
      }
      const redeemed = await client.query(REDEEM_VOUCHER_SQL, [caller.tenantId, intent.voucher_id]);
      if (redeemed.rowCount !== 1) {
        // The guard refused under the lock: expiry passed since the state read.
        refuseUnusable(await voucherState(client, caller, intent.voucher_id));
        throw new VoucherRefusal("voucher_expired");
      }
      const inserted = await client.query<{ id: string; redeemed_at: Date }>(INSERT_REDEMPTION_SQL, [
        caller.tenantId,
        intent.store_id,
        intent.voucher_id,
        intent.id,
        intent.payment_attempt_id,
        intent.applied_amount_minor,
        intent.forfeited_amount_minor,
        caller.cashierUserId,
        caller.deviceId,
      ]);
      const redemption = inserted.rows[0]!;
      await insertVoucherPosAudit(client, {
        tenantId: caller.tenantId,
        storeId: caller.storeId,
        actorUserId: caller.cashierUserId,
        requestId: caller.requestId,
        action: VOUCHER_REDEEMED_ACTION,
        voucherId: intent.voucher_id,
        metadata: {
          voucher_id: intent.voucher_id,
          intent_id: intent.id,
          redemption_id: redemption.id,
          payment_attempt_id: intent.payment_attempt_id,
          applied_amount_minor: Number(intent.applied_amount_minor),
          device_id: caller.deviceId,
        },
      });
      return {
        kind: "redeemed",
        redemption_id: redemption.id,
        redeemed_at: redemption.redeemed_at.toISOString(),
        idempotent_replayed: false,
      };
    });
  }

  reverse(caller: DeviceCaller, body: ReverseVoucherDto): Promise<ReverseVoucherBody> {
    return runWithTenantContext(this.pool, tenantScope(caller.tenantId), async (client) => {
      const done = await reverseRedemptionInTx(client, {
        tenantId: caller.tenantId,
        storeId: caller.storeId,
        deviceId: caller.deviceId,
        requestId: caller.requestId,
        redemptionId: body.redemption_id,
      });
      return reversed(done.redemptionId, done.reversedAt, done.alreadyReversed);
    });
  }
}

/** The RLS context of a device request: its tenant, never a platform admin. */
const tenantScope = (tenantId: string) => ({ tenantId, isPlatformAdmin: false });

async function voucherState(client: PoolClient, caller: DeviceCaller, voucherId: string): Promise<VoucherStateRow> {
  const r = await client.query<VoucherStateRow>(VOUCHER_STATE_SQL, [caller.tenantId, voucherId, caller.storeId]);
  const row = r.rows[0];
  // The intent's composite FK keeps its voucher; RLS hides nothing of the own tenant.
  if (!row) throw new Error("the voucher of an intent is missing");
  return row;
}

/** Refuse a voucher that cannot be used here: redeemed, then cancelled, then expired, then the store. */
function refuseUnusable(state: VoucherStateRow): void {
  if (state.status === "redeemed") throw new VoucherRefusal("voucher_already_redeemed");
  if (state.status === "cancelled") throw new VoucherRefusal("voucher_cancelled");
  if (state.expired) throw new VoucherRefusal("voucher_expired");
  if (!state.eligible) throw new VoucherRefusal("voucher_branch_mismatch");
}

function reversed(redemptionId: string, reversedAt: Date, already: boolean): ReverseVoucherBody {
  return { kind: "reversed", redemption_id: redemptionId, reversed_at: reversedAt.toISOString(), already_reversed: already };
}
