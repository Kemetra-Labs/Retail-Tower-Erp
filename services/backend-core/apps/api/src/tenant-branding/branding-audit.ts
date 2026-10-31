/**
 * The tenant logo audit rows (spec 039 FR-15, contract §7), written in the
 * same transaction as the write they record. Versions only: image bytes,
 * base64 and file names are never logged or audited (§XIV).
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

export const LOGO_REPLACED_ACTION = "tenant.logo.replaced";
export const LOGO_REMOVED_ACTION = "tenant.logo.removed";
export const LOGO_TARGET = "tenant_logo";

export interface LogoAudit {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

async function insert(client: PoolClient, audit: LogoAudit, action: string, metadata: Record<string, string | null>): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, NULL, $4, $5, $3, $6, $7::jsonb)`,
    [newId(), audit.actorUserId, audit.tenantId, action, LOGO_TARGET, audit.requestId, JSON.stringify(metadata)],
  );
}

/** `tenant.logo.replaced` `{from_version, to_version}` (`from_version` null on a first save). */
export function insertLogoReplaced(client: PoolClient, audit: LogoAudit, fromVersion: string | null, toVersion: string): Promise<void> {
  return insert(client, audit, LOGO_REPLACED_ACTION, { from_version: fromVersion, to_version: toVersion });
}

/** `tenant.logo.removed` `{from_version}`. */
export function insertLogoRemoved(client: PoolClient, audit: LogoAudit, fromVersion: string): Promise<void> {
  return insert(client, audit, LOGO_REMOVED_ACTION, { from_version: fromVersion });
}
