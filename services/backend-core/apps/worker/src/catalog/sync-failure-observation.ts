/**
 * RT-1525 — the failure state the sync-failure alert observes, owned by `catalog` (module-map.json:
 * `erpnext_posting_status`, `sales`). Moved from sync-failure-alert.repository.ts (RT-1034).
 *
 * SELECT only: it never writes a posting or sale table. It runs on the CALLER's client, so the
 * caller's transaction and tenant GUC stay in force. It does not read `stores`: the caller keeps only
 * live stores through the `stores` port (these counts include a deleted store's rows).
 */
import type { PoolClient } from "pg";

/** The two failure conditions (the alert's condition keys). */
export type SyncFailureConditionKey = "posting_permanently_rejected" | "sale_failed_needs_repair";

export interface SyncFailureCount {
  readonly storeId: string;
  readonly condition: SyncFailureConditionKey;
  readonly failureCount: number;
}

const COUNTS_SQL = `
  SELECT s.store_id, 'posting_permanently_rejected' AS condition_key, count(*)::int AS failure_count
    FROM erpnext_posting_status s
   WHERE s.tenant_id = $1 AND s.status = 'permanently_rejected'
   GROUP BY s.store_id
  UNION ALL
  SELECT sa.store_id, 'sale_failed_needs_repair' AS condition_key, count(*)::int AS failure_count
    FROM sales sa
   WHERE sa.tenant_id = $1 AND sa.sync_status = 'failed-needs-repair'
   GROUP BY sa.store_id
  ORDER BY store_id, condition_key`;

const PRESENT_SQL: Readonly<Record<SyncFailureConditionKey, string>> = {
  posting_permanently_rejected: `
    SELECT 1 FROM erpnext_posting_status s
     WHERE s.tenant_id = $1 AND s.store_id = $2 AND s.status = 'permanently_rejected'
     LIMIT 1`,
  sale_failed_needs_repair: `
    SELECT 1 FROM sales sa
     WHERE sa.tenant_id = $1 AND sa.store_id = $2 AND sa.sync_status = 'failed-needs-repair'
     LIMIT 1`,
};

/** Per store and condition, how many rows are in the failure state; ordered by store, then condition. */
export async function syncFailureCounts(client: Pick<PoolClient, "query">, tenantId: string): Promise<SyncFailureCount[]> {
  const r = await client.query<{ store_id: string; condition_key: SyncFailureConditionKey; failure_count: number }>(
    COUNTS_SQL,
    [tenantId],
  );
  return r.rows.map((row) => ({ storeId: row.store_id, condition: row.condition_key, failureCount: row.failure_count }));
}

/** Whether one store still has at least one row in the condition's failure state. */
export async function syncFailurePresent(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  storeId: string,
  condition: SyncFailureConditionKey,
): Promise<boolean> {
  const r = await client.query(PRESENT_SQL[condition], [tenantId, storeId]);
  return (r.rowCount ?? 0) > 0;
}
