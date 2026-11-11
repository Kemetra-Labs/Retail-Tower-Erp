/**
 * The voucher change events (`vouchers-admin.openapi.yaml` `x-audit-action`,
 * RT-922 section 5.5): `voucher.issued` and `voucher.cancelled`.
 *
 * Written on the operation's own transaction (never by the async
 * `AuditEmitterInterceptor`), so a failed insert fails the issue or the cancel
 * and an audit row never exists for work that rolled back. Both are tenant-level
 * events (`store_id` NULL). Metadata is ids, counts, amounts and the actor's
 * facts only: a code, a code hash and the free-text note are NEVER written
 * (RT-922 section 5.3, Constitution XIV).
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

export const VOUCHER_ISSUED_ACTION = "voucher.issued";
export const VOUCHER_CANCELLED_ACTION = "voucher.cancelled";

interface VoucherAudit {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly action: typeof VOUCHER_ISSUED_ACTION | typeof VOUCHER_CANCELLED_ACTION;
  readonly targetType: "voucher_batch" | "voucher";
  readonly targetId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function insertVoucherAudit(client: PoolClient, audit: VoucherAudit): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6, $7, $8::jsonb)`,
    [
      newId(),
      audit.actorUserId,
      audit.tenantId,
      audit.action,
      audit.targetType,
      audit.targetId,
      audit.requestId,
      JSON.stringify(audit.metadata),
    ],
  );
}
