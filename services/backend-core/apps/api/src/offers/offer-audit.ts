/**
 * The offers change audit (`offers.openapi.yaml` "Audit", Jira RT-1337): one
 * `audit_events` row per Console write, written on the operation's own
 * transaction (never by the async `AuditEmitterInterceptor`), so an audit row
 * never exists for work that rolled back. Ids, versions, counts and the short
 * `reason` (documented "no PII") only; names and rules are not copied.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

export type OfferAuditAction =
  | "offer.draft_created"
  | "offer.draft_updated"
  | "offer.published"
  | "offer.paused"
  | "offer.resumed"
  | "offer.ended"
  | "offer.archived";

export async function insertOfferAudit(
  client: PoolClient,
  audit: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly requestId: string | null;
    readonly action: OfferAuditAction;
    readonly offerId: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, NULL, $4, 'offer', $5, $6, $7::jsonb)`,
    [newId(), audit.actorUserId, audit.tenantId, audit.action, audit.offerId, audit.requestId, JSON.stringify({ offer_id: audit.offerId, ...audit.metadata })],
  );
}
