/**
 * The Console force-action hourly cap — RT-1437 D9 (`console-force-actions.openapi.yaml`, "Rate cap").
 *
 * At most 10 force actions per tenant per rolling hour, across `consoleForceCloseShift` and
 * `consoleDeleteStore` together. Only first-time successful writes count: they are counted from
 * the audit rows those writes leave (`shift.force_closed` and `store.deleted` with
 * `metadata.channel = 'console'`), so a replay, a refusal and a preview never count and no
 * counter table exists. The count is read in the write's own transaction, after an advisory lock
 * on the tenant, so two concurrent writes cannot both see 9 and both pass. The caller writes its
 * audit row in the same transaction AFTER this check.
 */
import type { PoolClient } from "pg";

import { ConsoleActionRateLimited } from "../stores/deletion/console-429";

const FORCE_ACTION_CAP = 10;
const FORCE_ACTION_WINDOW_SECONDS = 60 * 60;
/** The audit actions the cap counts (with `channel = 'console'`). */
const FORCE_ACTION_AUDIT_ACTIONS = ["shift.force_closed", "store.deleted"] as const;

/** Throws `ConsoleActionRateLimited("force_action_rate_limited")` when the tenant's hour is spent. */
export async function enforceForceActionCap(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('force_action_cap:' || $1::text, 0))`, [tenantId]);
  const counted = await client.query<{ retry_after: string }>(
    `SELECT CEIL(EXTRACT(EPOCH FROM (occurred_at + make_interval(secs => $3::double precision) - now())))::text AS retry_after
       FROM audit_events
      WHERE tenant_id = $1
        AND action = ANY($2::text[])
        AND metadata->>'channel' = 'console'
        AND occurred_at > now() - make_interval(secs => $3::double precision)
      ORDER BY occurred_at ASC
      LIMIT $4`,
    [tenantId, FORCE_ACTION_AUDIT_ACTIONS, FORCE_ACTION_WINDOW_SECONDS, FORCE_ACTION_CAP],
  );
  if (counted.rows.length < FORCE_ACTION_CAP) return;
  const oldest = Number(counted.rows[0]?.retry_after ?? FORCE_ACTION_WINDOW_SECONDS);
  throw new ConsoleActionRateLimited("force_action_rate_limited", oldest);
}
