/**
 * RT-1358 — in-transaction audit rows of the provisioning surface (`erp.provisioning.*`
 * and `erp.provisioner_credential.*`). Ids, enum tokens and short scrubbed reasons
 * only (§XIV): never a secret, token, hash or tenant business content. Each row is
 * written in the transaction of the change it records.
 */
import type { PoolClient } from "pg";
import { newId } from "@data-pulse-2/shared";

import { recordProvisioningEvent } from "../observability/metrics/api.metrics";

export const AUDIT = {
  requested: "erp.provisioning.requested",
  claimed: "erp.provisioning.claimed",
  stepRecorded: "erp.provisioning.step_recorded",
  retryScheduled: "erp.provisioning.retry_scheduled",
  leaseExpired: "erp.provisioning.lease_expired",
  credentialIssued: "erp.provisioning.credential_issued",
  succeeded: "erp.provisioning.succeeded",
  failed: "erp.provisioning.failed",
  cancelled: "erp.provisioning.cancelled",
  provisionerIssued: "erp.provisioner_credential.issued",
  provisionerRotated: "erp.provisioner_credential.rotated",
  provisionerRevoked: "erp.provisioner_credential.revoked",
  provisionerRevokeNoop: "erp.provisioner_credential.revoke_noop",
  provisionerExpiredRevoked: "erp.provisioner_credential.expired_revoked",
} as const;

type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

export interface ProvisioningAuditInput {
  readonly actorUserId: string;
  readonly actorLabel?: string | null;
  readonly tenantId: string | null;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly requestId?: string | null;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export async function insertProvisioningAudit(client: PoolClient, input: ProvisioningAuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9::jsonb)`,
    [
      newId(),
      input.actorUserId,
      input.actorLabel ?? null,
      input.tenantId,
      input.action,
      input.targetType,
      input.targetId,
      input.requestId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  recordProvisioningEvent(input.action);
}
