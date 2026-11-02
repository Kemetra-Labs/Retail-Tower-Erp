/**
 * RT-1071 pure helpers for the sidebar system-status block (RT-1056 D-1..D-5).
 * No React, no fetch.
 *
 * Truth rules:
 *  - `unknown` is never `ok` (D-1). A state the client does not know, or a
 *    reason that does not belong to the state it arrives with, is `unknown`.
 *  - A failed read shows every component `unknown`: the Console cannot tell a
 *    down server from a lost network (D-1, `server`).
 *  - A 404 is the non-disclosing refusal of a role outside the allowed set: the
 *    block is hidden, nothing is shown (D-3).
 *  - A snapshot is stale 10 minutes after the Console received it, by its own
 *    clock; `asOf` is never compared with the local clock (D-2).
 *  - Destinations are the closed `link` values of D-5, mapped to the Console's
 *    own routes; `none` renders no link (UX-09).
 */
import type { MessageKey } from "@/i18n";
import type { ComponentLink, ConsoleSystemStatus } from "@/lib/system-status-queries";

export type StatusState = "ok" | "degraded" | "down" | "unknown";
export type ComponentId = "server" | "saleSync" | "erpConnector";

export const COMPONENT_IDS: readonly ComponentId[] = ["server", "saleSync", "erpConnector"];

/** The snapshot is stale this long after the Console received it (D-2). */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Closed reason → the state the contract maps it to (D-1), per component: a
 * reason that belongs to another component is not valid here.
 */
const REASON_STATE: Record<ComponentId, Record<string, StatusState>> = {
  server: { answered: "ok" },
  saleSync: {
    keeping_up: "ok",
    queue_behind: "degraded",
    needs_repair: "degraded",
    queue_stalled: "down",
    check_timed_out: "unknown",
  },
  erpConnector: {
    heartbeat_fresh: "ok",
    erp_unreachable_reported: "degraded",
    some_instances_stale: "degraded",
    heartbeat_stale: "down",
    not_configured: "unknown",
    all_disabled: "unknown",
    never_seen: "unknown",
    check_timed_out: "unknown",
  },
};

const STATES: readonly StatusState[] = ["ok", "degraded", "down", "unknown"];

export const STATE_LABEL: Record<StatusState, MessageKey> = {
  ok: "shell.status.state.ok",
  degraded: "shell.status.state.degraded",
  down: "shell.status.state.down",
  unknown: "shell.status.state.unknown",
};

export const COMPONENT_LABEL: Record<ComponentId, MessageKey> = {
  server: "shell.status.component.server",
  saleSync: "shell.status.component.saleSync",
  erpConnector: "shell.status.component.erpConnector",
};

/** The Console routes for the D-5 destinations; `none` has no route. */
const LINK_ROUTE: Record<string, string | null> = {
  sale_sync_ops: "/sales-needing-repair",
  erp_connection: "/erp-connection",
  none: null,
};

export function linkRoute(link: ComponentLink | string | undefined): string | null {
  return link === undefined ? null : (LINK_ROUTE[link] ?? null);
}

export interface ComponentView {
  id: ComponentId;
  state: StatusState;
  /** The reason message, only when the server's reason agrees with its state. */
  reasonKey: MessageKey | null;
  route: string | null;
}

export interface StatusView {
  overall: StatusState;
  components: readonly ComponentView[];
}

function reasonKey(reason: string): MessageKey {
  return `shell.status.reason.${reason}` as MessageKey;
}

/** One component: its state only if its reason agrees with it, otherwise `unknown`. */
function viewOf(
  id: ComponentId,
  raw: { state?: string; reason?: string; link?: string } | undefined,
): ComponentView {
  const state = STATES.find((s) => s === raw?.state);
  const reason = raw?.reason;
  if (!raw || !state || !reason || REASON_STATE[id][reason] !== state) {
    return { id, state: "unknown", reasonKey: null, route: linkRoute(raw?.link) };
  }
  return { id, state, reasonKey: reasonKey(reason), route: linkRoute(raw.link) };
}

/** Worst-of in the order down > degraded > unknown > ok (D-1). */
export function worstOf(states: readonly StatusState[]): StatusState {
  for (const s of ["down", "degraded", "unknown"] as const) {
    if (states.includes(s)) return s;
  }
  return states.length === 0 ? "unknown" : "ok";
}

/** The three components from a 200 body. The overall is recomputed, never trusted to be `ok`. */
export function statusView(body: ConsoleSystemStatus): StatusView {
  const components = COMPONENT_IDS.map((id) => viewOf(id, body.components?.[id]));
  const computed = worstOf(components.map((c) => c.state));
  const sent = STATES.find((s) => s === body.overall) ?? "unknown";
  // Never better than the components or the server's own overall: `ok` only when both are.
  const overall = worstOf([computed, sent]);
  return { overall, components };
}

/** A failed or absent read: every component `unknown`, no destination invented. */
export function unknownView(): StatusView {
  return {
    overall: "unknown",
    components: COMPONENT_IDS.map((id) => ({
      id,
      state: "unknown" as const,
      reasonKey: null,
      route: null,
    })),
  };
}

export function isStale(receivedAt: number, now: number): boolean {
  return now - receivedAt >= STALE_AFTER_MS;
}

/** Whole minutes since receipt, at least 1, for the «stale» phrase. */
export function ageMinutes(receivedAt: number, now: number): number {
  return Math.max(1, Math.floor((now - receivedAt) / 60_000));
}
