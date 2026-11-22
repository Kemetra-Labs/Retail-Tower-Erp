/**
 * RT-1551 — the `outbox_pending_total` gauge's read, owned by `outbox` (module-map.json:
 * `outbox_events`). Moved verbatim from observability/metrics/worker.metrics.ts (T595 PR-B-2).
 *
 * It runs on the CALLER's client: the gauge registrar in worker.metrics.ts wraps it in the
 * platform-admin context (that RT-1389 allowlisted site stays there), so the outbox RLS policy lets
 * the SELECT aggregate across tenants. The worker
 * root binds it to the `OUTBOX_PENDING_ROWS` token; observability never imports outbox (outbox already
 * imports observability, RT-1454).
 */
import type { OutboxPendingRow } from "../observability/metrics/worker.metrics";

/**
 * Bounded list of `delivery_state` values that contribute to the pending gauge. `delivered` is
 * terminal (success); `dead_lettered` is terminal and separately tracked by
 * `outbox_dead_letter_total`. Including either would double-count.
 *
 * Mirrors the runtime check pinned by `drainer.processor.ts` and the CHECK constraint in
 * `packages/db/drizzle/0006_outbox_events.sql` (delivery_state must be one of: 'pending','claimed',
 * 'delivered','failed','dead_lettered').
 */
const PENDING_DELIVERY_STATES = ["pending", "claimed", "failed"] as const;

/** The minimal client the read needs (the lazily required `runWithTenantContext` gives one). */
export interface PendingRowsClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ event_type: string; count: string }> }>;
}

/** Pending outbox events per `event_type` (pending, claimed, failed). */
export async function pendingOutboxByEventType(client: PendingRowsClient): Promise<OutboxPendingRow[]> {
  // Parameterized query — even though PENDING_DELIVERY_STATES is a compile-time const today, the
  // repo's house style for any SQL taking a list of values is `= ANY($1::text[])` (see drainer,
  // repository, retention). Future-proofs against the constant ever becoming non-literal.
  const result = await client.query(
    `SELECT event_type, COUNT(*)::text AS count
       FROM outbox_events
      WHERE delivery_state = ANY($1::text[])
      GROUP BY event_type`,
    [[...PENDING_DELIVERY_STATES]],
  );
  return result.rows.map((r) => ({
    event_type: r.event_type,
    count: Number(r.count),
  }));
}
