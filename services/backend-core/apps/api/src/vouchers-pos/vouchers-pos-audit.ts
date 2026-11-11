/**
 * vouchers-pos-audit.ts — RT-1112: the V-A change events, written on the
 * operation's own transaction (never by the async `AuditEmitterInterceptor`), so
 * an audit row never exists for work that rolled back, and a failed insert fails
 * the operation. An idempotent replay never reaches the handler, so it writes
 * nothing (no double emission).
 *
 *   - `voucher.validated` — a redemption intent was issued;
 *   - `voucher.redeemed`  — the voucher was consumed;
 *   - `voucher.reversed`  — a redemption was undone. The actor is the cashier
 *     recorded at redeem time (the reverse carries no claim, RT-1110), and the
 *     metadata names the reversing device.
 *
 * All three are store-level events. Metadata is ids and the applied amount only:
 * never the code, a code hash, the intent token or its hash, and never
 * `forfeited_amount_minor` (contract V-A, the one FR-017 exception is not
 * audited; RT-810 section 6, Constitution XIV).
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

export const VOUCHER_VALIDATED_ACTION = "voucher.validated";
export const VOUCHER_REDEEMED_ACTION = "voucher.redeemed";
export const VOUCHER_REVERSED_ACTION = "voucher.reversed";

type VoucherPosAction = typeof VOUCHER_VALIDATED_ACTION | typeof VOUCHER_REDEEMED_ACTION | typeof VOUCHER_REVERSED_ACTION;

/** The only metadata keys a V-A audit row may carry. */
type VoucherPosAuditField =
  | "voucher_id"
  | "intent_id"
  | "redemption_id"
  | "payment_attempt_id"
  | "applied_amount_minor"
  | "device_id"
  | "reversed_by_device_id";

export interface VoucherPosAudit {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly action: VoucherPosAction;
  readonly voucherId: string;
  readonly metadata: Readonly<Partial<Record<VoucherPosAuditField, string | number>>>;
}

export async function insertVoucherPosAudit(client: PoolClient, audit: VoucherPosAudit): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, $4, $5, 'voucher', $6, $7, $8::jsonb)`,
    [
      newId(),
      audit.actorUserId,
      audit.tenantId,
      audit.storeId,
      audit.action,
      audit.voucherId,
      audit.requestId,
      JSON.stringify(audit.metadata),
    ],
  );
}
