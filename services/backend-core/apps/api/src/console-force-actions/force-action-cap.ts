/**
 * The D9 rate cap and the audit row of a Console force action (RT-1437 D9,
 * D5a; RT-1445). SHARED: `consoleForceCloseShift` (this slice) and the store
 * deletion `consoleDeleteStore` (RT-1439) use this one helper, so the cap is
 * one cap, not two counters that can disagree.
 *
 * The cap: at most `FORCE_ACTION_CAP` (10) FIRST-TIME SUCCESSFUL force actions
 * per tenant per rolling hour. Replays, refusals and previews never count. The
 * count source is the audit rows the writes themselves leave, in the write's own
 * transaction: a Console force action is its `audit_events` row with
 * `metadata.channel = 'console'` and one of `COUNTED_ACTIONS`. A POS force close
 * (`channel: pos`) and the legacy `DELETE` (`channel: api`) never count, and a
 * replay writes no row, so each counted action is exactly one row. A
 * transaction-scoped advisory lock keyed on the tenant serialises the writers:
 * two concurrent actions that both read nine could otherwise both commit and
 * make eleven. The lock is held to COMMIT, so the count a writer reads includes
 * every action that committed before it, and its own row is written after the
 * read.
 *
 * Contract: `console-force-actions.openapi.yaml` "Rate cap (D9)",
 * `stores.openapi.yaml` `consoleDeleteStore`.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import { ConsoleActionRateLimited } from "../stores/deletion/console-429";

const FORCE_ACTION_CAP = 10;
const FORCE_ACTION_WINDOW_SECONDS = 3600;

/** The audit actions that count against the cap, when written with `channel: console`. */
const COUNTED_FORCE_ACTIONS = ["shift.force_closed", "store.deleted"] as const;

/**
 * The 429 `force_action_rate_limited`: the tenant's hourly cap is spent. It is a
 * `ConsoleActionRateLimited` (the one console 429 family, `stores/deletion/console-429`), so the
 * store-deletion controller's catch and the force-close controller's catch both handle it.
 */
export class ForceActionRateLimitedError extends ConsoleActionRateLimited {
  /** Whole seconds until the oldest counted action leaves the window (1 to 3600). */
  constructor(retryAfterSeconds: number) {
    super("force_action_rate_limited", retryAfterSeconds);
    this.name = "ForceActionRateLimitedError";
  }
}

/**
 * Refuses (429) when the tenant already made `FORCE_ACTION_CAP` force actions in
 * the last hour. Call it inside the write's tenant transaction, after every
 * other refusal and before the write, and write the action's audit row in the
 * same transaction.
 */
export async function enforceForceActionCap(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`force_action_cap:${tenantId}`]);
  // The newest FORCE_ACTION_CAP counted rows of the window, newest first. With fewer, the cap is not spent.
  // With a full set, the last row is the one whose expiry frees a slot: the n-9th oldest of n counted rows,
  // which is the 10th newest. So Retry-After stays exact even if a writer without the lock pushed n past 10.
  const r = await client.query<{ retry_after: number }>(
    `SELECT CEIL(EXTRACT(EPOCH FROM (occurred_at + make_interval(secs => $3) - now())))::int AS retry_after
       FROM audit_events
      WHERE tenant_id = $1
        AND occurred_at > now() - make_interval(secs => $3)
        AND metadata->>'channel' = 'console'
        AND action = ANY($2::text[])
      ORDER BY occurred_at DESC
      LIMIT $4`,
    [tenantId, [...COUNTED_FORCE_ACTIONS], FORCE_ACTION_WINDOW_SECONDS, FORCE_ACTION_CAP],
  );
  if (r.rows.length < FORCE_ACTION_CAP) return;
  const wait = r.rows[r.rows.length - 1]!.retry_after;
  throw new ForceActionRateLimitedError(Math.min(FORCE_ACTION_WINDOW_SECONDS, Math.max(1, wait)));
}

/** One Console force action's audit row (`audit_events`), written in the action's transaction. */
export interface ForceActionAuditRow {
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly actorUserId: string;
  readonly requestId: string | null;
  /** One of `COUNTED_FORCE_ACTIONS`. */
  readonly action: (typeof COUNTED_FORCE_ACTIONS)[number];
  readonly targetType: string;
  readonly targetId: string;
  /** Ids, codes and counts only; never a password, a token or (for a shift) the reason. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function insertForceActionAudit(client: PoolClient, row: ForceActionAuditRow): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      newId(),
      row.actorUserId,
      row.tenantId,
      row.storeId,
      row.action,
      row.targetType,
      row.targetId,
      row.requestId,
      JSON.stringify(row.metadata),
    ],
  );
}
