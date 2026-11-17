/**
 * RT-1440 (U1) A4: the read-only list of shifts closed without a count, from the audit search
 * (`GET /api/v1/audit/events?action=shift.force_closed`, an existing operation: no new contract).
 * Pure, no React.
 *
 * Each row is one `shift.force_closed` audit event, written for both channels (POS and Console)
 * with ids, codes and counts only. The reason is stored on the fact and NEVER in the audit row
 * (RT-1437 D5a), so this list has no reason column. A field the row does not carry stays null
 * (unknown, never zero), and an item that is not a force-close audit row is dropped.
 */

/** The audit action both channels write. */
export const FORCE_CLOSED_ACTION = "shift.force_closed";

/** The ledger row counts the last 30 days (RT-1437 A1, Health). */
export const FORCE_CLOSED_WINDOW_DAYS = 30;

export type ForceClosedChannel = "pos" | "console" | "unknown";

export interface ForceClosedRow {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorRole: string | null;
  channel: ForceClosedChannel;
  shiftId: string;
  storeId: string | null;
  ageMinutes: number | null;
}

/** The start of the counting window as an ISO instant, `FORCE_CLOSED_WINDOW_DAYS` before `nowMs`. */
export function windowStart(nowMs: number): string {
  return new Date(nowMs - FORCE_CLOSED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function channelOf(v: unknown): ForceClosedChannel {
  return v === "pos" || v === "console" ? v : "unknown";
}

/** One audit event as a row, or null when it is not a well-formed `shift.force_closed` event. */
export function forceClosedRowOf(event: unknown): ForceClosedRow | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  const meta = (typeof e.metadata === "object" && e.metadata !== null ? e.metadata : {}) as Record<string, unknown>;
  const id = str(e.id);
  const occurredAt = str(e.occurred_at);
  const shiftId = str(meta.shift_id) ?? str(e.target_id);
  if (e.action !== FORCE_CLOSED_ACTION || id === null || occurredAt === null || shiftId === null) return null;
  const age = meta.shift_age_minutes;
  return {
    id,
    occurredAt,
    actorUserId: str(e.actor_user_id),
    actorRole: str(meta.actor_role),
    channel: channelOf(meta.channel),
    shiftId,
    storeId: str(e.store_id),
    ageMinutes: typeof age === "number" && Number.isFinite(age) && age >= 0 ? age : null,
  };
}

/** The rows of a page body's `items`, in the server's order (newest first); malformed items are skipped. */
export function forceClosedRows(items: unknown): ForceClosedRow[] {
  const list = Array.isArray(items) ? items : (items as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(list)) return [];
  return list.map(forceClosedRowOf).filter((r): r is ForceClosedRow => r !== null);
}
