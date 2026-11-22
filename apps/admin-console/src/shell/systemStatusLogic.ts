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
 *  - RT-1552: `shipmentTransfers` is optional (RT-1516). Absent (an older
 *    server), the block is exactly the three components. Present, it follows
 *    the same rules, has no destination (its contract `link` is `none`), and a
 *    degraded one carries one count line taken only from the facts the server
 *    sent: nothing is invented, and no line for ok or unknown.
 */
import type { MessageKey } from "@/i18n";
import type { ComponentLink, ConsoleSystemStatus } from "@/lib/system-status-queries";

export type StatusState = "ok" | "degraded" | "down" | "unknown";
export type ComponentId = "server" | "saleSync" | "erpConnector" | "shipmentTransfers";

/** The components every server sends. `shipmentTransfers` is optional and is added when present. */
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
  shipmentTransfers: {
    keeping_up: "ok",
    transfers_delayed: "degraded",
    postings_stuck: "degraded",
    postings_need_attention: "degraded",
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
  shipmentTransfers: "shell.status.component.shipmentTransfers",
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

/** One count line under a degraded `shipmentTransfers` row: the message, its number, and the threshold days when it names one. */
interface ComponentFact {
  key: MessageKey;
  count: number;
  days: number | null;
}

export interface ComponentView {
  id: ComponentId;
  state: StatusState;
  /** The reason message, only when the server's reason agrees with its state. */
  reasonKey: MessageKey | null;
  route: string | null;
  /** RT-1552: the count line of a degraded `shipmentTransfers`; null everywhere else. */
  fact: ComponentFact | null;
}

export interface StatusView {
  overall: StatusState;
  components: readonly ComponentView[];
}

function reasonKey(reason: string): MessageKey {
  return `shell.status.reason.${reason}` as MessageKey;
}

/** A count the server sent: a finite whole number, zero or more. Anything else is not a count. */
function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type Facts = Record<string, unknown>;

function delayedFact(f: Facts): ComponentFact | null {
  const count = countOf(f.delayedTransferCount);
  const days = countOf(f.delayedThresholdDays);
  return count && days ? { key: "shell.status.fact.transfers_delayed", count, days } : null;
}

function stuckFact(f: Facts): ComponentFact | null {
  const count = countOf(f.stuckPostingCount);
  return count ? { key: "shell.status.fact.postings_stuck", count, days: null } : null;
}

function attentionFact(f: Facts): ComponentFact | null {
  const postings = countOf(f.postingsNeedingAttentionCount);
  const receipts = countOf(f.unreleasedReceiptCount);
  // Both halves must be counts: a malformed half is never shown as a partial total.
  if (postings === null || receipts === null) return null;
  const count = postings + receipts;
  return count > 0 && Number.isSafeInteger(count)
    ? { key: "shell.status.fact.postings_need_attention", count, days: null }
    : null;
}

const FACT_OF: Record<string, (f: Facts) => ComponentFact | null> = {
  transfers_delayed: delayedFact,
  postings_stuck: stuckFact,
  postings_need_attention: attentionFact,
};

/**
 * The count line of a degraded `shipmentTransfers` row, from the server's facts only (RT-1552).
 * `postings_need_attention` covers both rejected or reconciliation-needed postings and receipts
 * left unreleased, so its count is their sum. No line for a zero, a missing or a malformed count,
 * and none when either half of that sum is malformed.
 */
function shipmentFact(reason: string, facts: unknown): ComponentFact | null {
  if (typeof facts !== "object" || facts === null) return null;
  return FACT_OF[reason]?.(facts as Facts) ?? null;
}

/** One component: its state only if its reason agrees with it, otherwise `unknown`. */
function viewOf(
  id: ComponentId,
  raw: { state?: string; reason?: string; link?: string; facts?: unknown } | undefined,
): ComponentView {
  // `shipmentTransfers` has no destination: its contract `link` is `none`, so none is ever mapped.
  const route = id === "shipmentTransfers" ? null : linkRoute(raw?.link);
  const state = STATES.find((s) => s === raw?.state);
  const reason = raw?.reason;
  if (!raw || !state || !reason || REASON_STATE[id][reason] !== state) {
    return { id, state: "unknown", reasonKey: null, route, fact: null };
  }
  const fact =
    id === "shipmentTransfers" && state === "degraded" ? shipmentFact(reason, raw.facts) : null;
  return { id, state, reasonKey: reasonKey(reason), route, fact };
}

/** Worst-of in the order down > degraded > unknown > ok (D-1). */
export function worstOf(states: readonly StatusState[]): StatusState {
  for (const s of ["down", "degraded", "unknown"] as const) {
    if (states.includes(s)) return s;
  }
  return states.length === 0 ? "unknown" : "ok";
}

/**
 * The components of a 200 body: the three every server sends, then `shipmentTransfers` when the
 * server sent it. The overall is recomputed, never trusted to be `ok`.
 */
export function statusView(body: ConsoleSystemStatus): StatusView {
  const components = COMPONENT_IDS.map((id) => viewOf(id, body.components?.[id]));
  // Only an absent key means an older server; a present but malformed one shows `unknown`.
  const transfers = body.components?.shipmentTransfers;
  if (transfers !== undefined) components.push(viewOf("shipmentTransfers", transfers));
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
      fact: null,
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
