/**
 * Console system status projections — RT-1062: the state rules of
 * `console-system-status.openapi.yaml` (RT-1056 D-1, D-2, D-5). No DB, no
 * clock: `now` and the facts are inputs, so every reason is unit-testable.
 *
 * `unknown` is never `ok` (D-1): a component without evidence the server can
 * stand behind is `unknown`, and `overall` ranks `unknown` above `ok`.
 */
import {
  DEFAULT_STALENESS_THRESHOLD_MS,
  deriveLiveness,
} from "../connector-health/connector-health.liveness";

export type ComponentState = "ok" | "degraded" | "down" | "unknown";

/** An undelivered `sale.captured` event older than this is `queue_behind` (D-1). */
export const SALE_SYNC_BEHIND_SECONDS = 5 * 60;
/** An undelivered `sale.captured` event older than this is `queue_stalled` (D-1). */
export const SALE_SYNC_STALLED_SECONDS = 30 * 60;

export interface ServerComponent {
  readonly state: "ok";
  readonly reason: "answered";
  readonly observedAt: string;
  readonly link: "none";
}

export interface SaleSyncFacts {
  readonly undeliveredCount: number;
  readonly oldestUndeliveredAgeSeconds: number | null;
  readonly needsRepairCount: number;
}

export type SaleSyncReason = "keeping_up" | "queue_behind" | "needs_repair" | "queue_stalled" | "check_timed_out";

export interface SaleSyncComponent {
  readonly state: ComponentState;
  readonly reason: SaleSyncReason;
  readonly observedAt: string | null;
  readonly link: "sale_sync_ops";
  readonly facts: SaleSyncFacts | null;
}

/** One connector registration as the read sees it (spec 018 + 020 join). */
export interface ConnectorRegistrationFacts {
  readonly disabledAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly erpnextReachable: boolean | null;
}

export interface ErpConnectorFacts {
  readonly registeredCount: number;
  readonly enabledCount: number;
  readonly healthyCount: number;
  readonly staleCount: number;
  readonly neverSeenCount: number;
  readonly erpUnreachableReportedCount: number;
}

export type ErpConnectorReason =
  | "heartbeat_fresh"
  | "erp_unreachable_reported"
  | "some_instances_stale"
  | "heartbeat_stale"
  | "not_configured"
  | "all_disabled"
  | "never_seen"
  | "check_timed_out";

export interface ErpConnectorComponent {
  readonly state: ComponentState;
  readonly reason: ErpConnectorReason;
  readonly observedAt: string | null;
  readonly link: "erp_connection";
  readonly facts: ErpConnectorFacts | null;
}

export interface ConsoleSystemStatus {
  readonly asOf: string;
  readonly overall: ComponentState;
  readonly components: {
    readonly server: ServerComponent;
    readonly saleSync: SaleSyncComponent;
    readonly erpConnector: ErpConnectorComponent;
  };
}

/** `server` in a 200 (D-1): the API answered this read for this tenant. */
export function serverComponent(now: Date): ServerComponent {
  return { state: "ok", reason: "answered", observedAt: now.toISOString(), link: "none" };
}

/**
 * `saleSync` (D-1, first match wins): not read in time → `unknown`; an
 * undelivered event older than 30 min → `down`; older than 5 min →
 * `degraded` / `queue_behind`; an open NEEDS_REPAIR sale → `degraded` /
 * `needs_repair`; otherwise (an empty queue included) `ok`.
 * `facts === null` means the check did not answer in time.
 */
export function saleSyncComponent(facts: SaleSyncFacts | null, now: Date): SaleSyncComponent {
  const base = { link: "sale_sync_ops" as const };
  if (facts === null) {
    return { ...base, state: "unknown", reason: "check_timed_out", observedAt: null, facts: null };
  }
  const observed = { ...base, observedAt: now.toISOString(), facts };
  const age = facts.undeliveredCount > 0 ? facts.oldestUndeliveredAgeSeconds : null;
  if (age !== null && age > SALE_SYNC_STALLED_SECONDS) return { ...observed, state: "down", reason: "queue_stalled" };
  if (age !== null && age > SALE_SYNC_BEHIND_SECONDS) return { ...observed, state: "degraded", reason: "queue_behind" };
  if (facts.needsRepairCount > 0) return { ...observed, state: "degraded", reason: "needs_repair" };
  return { ...observed, state: "ok", reason: "keeping_up" };
}

/** The spec 020 liveness counts over the tenant's registrations (derived at read, 5-minute threshold). */
export function erpConnectorFacts(
  registrations: readonly ConnectorRegistrationFacts[],
  now: Date,
): { facts: ErpConnectorFacts; newestEnabledLastSeenAt: Date | null } {
  let enabledCount = 0;
  let healthyCount = 0;
  let staleCount = 0;
  let neverSeenCount = 0;
  let erpUnreachableReportedCount = 0;
  let newest: Date | null = null;
  for (const r of registrations) {
    const verdict = deriveLiveness(r.lastSeenAt, now, DEFAULT_STALENESS_THRESHOLD_MS, r.disabledAt);
    if (verdict === "disabled") continue;
    enabledCount += 1;
    if (verdict === "healthy") healthyCount += 1;
    else if (verdict === "stale") staleCount += 1;
    else neverSeenCount += 1;
    if (r.erpnextReachable === false) erpUnreachableReportedCount += 1;
    if (r.lastSeenAt !== null && (newest === null || r.lastSeenAt.getTime() > newest.getTime())) {
      newest = r.lastSeenAt;
    }
  }
  return {
    facts: {
      registeredCount: registrations.length,
      enabledCount,
      healthyCount,
      staleCount,
      neverSeenCount,
      erpUnreachableReportedCount,
    },
    newestEnabledLastSeenAt: newest,
  };
}

/** The reason over the counts (D-1, first match wins). */
function erpConnectorVerdict(f: ErpConnectorFacts): { state: ComponentState; reason: ErpConnectorReason } {
  if (f.registeredCount === 0) return { state: "unknown", reason: "not_configured" };
  if (f.enabledCount === 0) return { state: "unknown", reason: "all_disabled" };
  if (f.neverSeenCount === f.enabledCount) return { state: "unknown", reason: "never_seen" };
  if (f.healthyCount === 0) return { state: "down", reason: "heartbeat_stale" };
  if (f.healthyCount < f.enabledCount) return { state: "degraded", reason: "some_instances_stale" };
  if (f.erpUnreachableReportedCount > 0) return { state: "degraded", reason: "erp_unreachable_reported" };
  return { state: "ok", reason: "heartbeat_fresh" };
}

/**
 * `erpConnector` (D-1). `registrations === null` means the check did not
 * answer in time. `observedAt` is the newest `lastSeenAt` of an enabled
 * registration, null when there is none (D-2).
 */
export function erpConnectorComponent(
  registrations: readonly ConnectorRegistrationFacts[] | null,
  now: Date,
): ErpConnectorComponent {
  const base = { link: "erp_connection" as const };
  if (registrations === null) {
    return { ...base, state: "unknown", reason: "check_timed_out", observedAt: null, facts: null };
  }
  const { facts, newestEnabledLastSeenAt } = erpConnectorFacts(registrations, now);
  return {
    ...base,
    ...erpConnectorVerdict(facts),
    observedAt: newestEnabledLastSeenAt === null ? null : newestEnabledLastSeenAt.toISOString(),
    facts,
  };
}

const SEVERITY: Readonly<Record<ComponentState, number>> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/** The worst state, in the order `down` > `degraded` > `unknown` > `ok` (D-1). */
export function worstOf(states: readonly ComponentState[]): ComponentState {
  return states.reduce<ComponentState>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), "ok");
}

/** The 200 body at `now`. */
export function toConsoleSystemStatus(
  now: Date,
  saleSyncFacts: SaleSyncFacts | null,
  registrations: readonly ConnectorRegistrationFacts[] | null,
): ConsoleSystemStatus {
  const server = serverComponent(now);
  const saleSync = saleSyncComponent(saleSyncFacts, now);
  const erpConnector = erpConnectorComponent(registrations, now);
  return {
    asOf: now.toISOString(),
    overall: worstOf([server.state, saleSync.state, erpConnector.state]),
    components: { server, saleSync, erpConnector },
  };
}
