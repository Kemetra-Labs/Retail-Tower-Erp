/**
 * RT-1525 — a worker sweep's own audit row, written by `audit` (module-map.json: `audit_events`).
 * Moved from sync-failure-alert.repository.ts (RT-1034); the statement is unchanged.
 *
 * A system actor: no user, a label (`system:<sweep>`). The caller passes a deterministic id per fact,
 * so a retried write is a no-op (`ON CONFLICT (id) DO NOTHING`). It runs on the CALLER's client, so
 * the caller's transaction and tenant GUC stay in force.
 */
import type { PoolClient } from "pg";

export interface SystemAuditEvent {
  readonly id: string;
  readonly actorLabel: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: Record<string, unknown>;
}

/** Insert the row once; returns 1 when written, 0 when the id was already there. */
export async function insertSystemAuditEvent(client: Pick<PoolClient, "query">, row: SystemAuditEvent): Promise<number> {
  const r = await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, metadata)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [row.id, row.actorLabel, row.tenantId, row.storeId, row.action, row.targetType, row.targetId, JSON.stringify(row.metadata)],
  );
  return r.rowCount ?? 0;
}
