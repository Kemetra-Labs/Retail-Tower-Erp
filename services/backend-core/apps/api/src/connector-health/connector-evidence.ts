/**
 * RT-1513: the newest Connector heartbeat evidence of a tenant, as a public port of `connector-health`. The shipment
 * Transfer activation switch (inventory) asks this instead of naming `connector_health` itself, on the caller's client
 * (so the caller's transaction and RLS context stay in force). Read only; null fields mean never reported.
 */
import type { PoolClient } from "pg";

export interface ConnectorEvidence {
  /** Server clock of the last accepted heartbeat; null for no row. */
  readonly lastSeenAt: Date | null;
  /** The work-item kinds the Connector reported accepting; null = never reported. */
  readonly acceptedKinds: readonly string[] | null;
  /** `verified`, `missing`, `unknown`, or null = no evidence. */
  readonly backDatedRoleStatus: string | null;
  /** SERVER clock of the last role report: freshness is judged by this, never by the Connector clock. */
  readonly backDatedRoleReportedAt: Date | null;
}

export async function latestConnectorEvidence(client: PoolClient, tenantId: string): Promise<ConnectorEvidence> {
  const r = await client.query<{
    last_seen_at: Date | null;
    accepted_work_item_kinds: string[] | null;
    back_dated_role_status: string | null;
    back_dated_role_reported_at: Date | null;
  }>(
    `SELECT last_seen_at, accepted_work_item_kinds, back_dated_role_status, back_dated_role_reported_at
       FROM connector_health WHERE tenant_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
    [tenantId],
  );
  const h = r.rows[0];
  return {
    lastSeenAt: h?.last_seen_at ?? null,
    acceptedKinds: h?.accepted_work_item_kinds ?? null,
    backDatedRoleStatus: h?.back_dated_role_status ?? null,
    backDatedRoleReportedAt: h?.back_dated_role_reported_at ?? null,
  };
}
