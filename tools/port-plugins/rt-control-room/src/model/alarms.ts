import { ARCH, isHostId, stationForService } from "./architecture";
import type {
  Alarm,
  AlarmAt,
  AlarmKind,
  CableId,
  DatadogMonitor,
  HostId,
  Relation,
  SentryIssue,
  StationId,
  WorkloadEntity,
} from "./types";

/** First identifier of a Port relation value, or null when it is empty. */
export function firstRelation(value: Relation): string | null {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Workload identifier to the identifier of the service it belongs to. */
export function workloadServiceMap(workloads: WorkloadEntity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of workloads) {
    const service = firstRelation(w.relations?.service);
    if (service) map.set(w.identifier, service);
  }
  return map;
}

/** Only http(s) links are kept; anything else is dropped rather than rendered. */
function safeLink(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Kind of a Sentry issue from its title (spec section 7b). Order matters. */
export function classifySentryKind(title: string): AlarmKind {
  if (/\b403\b|forbidden/i.test(title)) return "refused";
  if (/\b50[23]\b|bad gateway/i.test(title)) return "down";
  if (/timeout|timed out/i.test(title)) return "timeout";
  if (/reset|aborted/i.test(title)) return "reset";
  return "bug";
}

/**
 * Where a Sentry issue sits: a Connector issue whose title targets an ERPNext
 * route is pinned on the Invoices cable (c4); every other issue stays inside
 * its station. A route is never invented to make a count.
 */
export function placeSentryAlarm(station: StationId, title: string): StationId | CableId {
  if (station === "conn" && /\/erpnext\//i.test(title)) return "c4";
  return station;
}

export function stationOfWorkload(
  workload: Relation,
  workloadToService: Map<string, string>,
): StationId | null {
  const workloadId = firstRelation(workload);
  if (!workloadId) return null;
  const serviceId = workloadToService.get(workloadId);
  return serviceId ? stationForService(serviceId) : null;
}

export function sentryAlarms(
  issues: SentryIssue[],
  workloadToService: Map<string, string>,
): Alarm[] {
  const alarms: Alarm[] = [];
  for (const issue of issues) {
    if (issue.properties?.status !== "unresolved") continue;
    const title = issue.title ?? "";
    const station = stationOfWorkload(issue.relations?.workload, workloadToService);
    const at: AlarmAt = station ? placeSentryAlarm(station, title) : "unlocated";
    alarms.push({
      id: issue.identifier,
      kind: classifySentryKind(title),
      source: "Sentry",
      station,
      at,
      title,
      message: title,
      since: issue.createdAt ?? null,
      link: safeLink(issue.properties?.link),
    });
  }
  return alarms;
}

export const ALARM_STATES = new Set(["alert", "warn", "nodata"]);

export function normaliseState(state: string | null | undefined): string {
  return (state ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * The host a monitor without a workload names: a `host:` tag wins over the
 * title. A name outside ARCH.hosts, or several different names, is never
 * coerced to a known host.
 */
function hostOfMonitor(monitor: DatadogMonitor): HostId | "unlocated" {
  const tagged = (monitor.properties?.tags ?? [])
    .filter((t) => typeof t === "string" && /^host:/i.test(t))
    .map((t) => t.slice(5));
  const named = tagged.length > 0 ? tagged : (monitor.title ?? "").match(/\blab-\d+\b/gi) ?? [];
  const distinct = Array.from(new Set(named));
  if (distinct.length === 1 && isHostId(distinct[0])) return distinct[0];
  return "unlocated";
}

function monitorKind(title: string, state: string): AlarmKind {
  if (/latency|p95/i.test(title)) return "latency";
  if (state === "nodata") return "nodata";
  return "monitor";
}

export function datadogAlarms(
  monitors: DatadogMonitor[],
  workloadToService: Map<string, string>,
): Alarm[] {
  const alarms: Alarm[] = [];
  for (const monitor of monitors) {
    const rawState = monitor.properties?.overallState ?? "";
    const state = normaliseState(rawState);
    if (!ALARM_STATES.has(state)) continue;
    const title = monitor.title ?? "";
    const workload = firstRelation(monitor.relations?.service);

    let station: StationId | null;
    let at: AlarmAt;
    if (workload) {
      station = stationOfWorkload(workload, workloadToService);
      at = station ?? "unlocated";
    } else {
      at = hostOfMonitor(monitor);
      station = at === "unlocated" ? null : ARCH.hosts[at];
    }

    alarms.push({
      id: monitor.identifier,
      kind: monitorKind(title, state),
      source: "Datadog",
      station,
      at,
      title,
      message: `${title} (${rawState})`,
      since: null,
      link: safeLink(monitor.properties?.link),
    });
  }
  return alarms;
}
