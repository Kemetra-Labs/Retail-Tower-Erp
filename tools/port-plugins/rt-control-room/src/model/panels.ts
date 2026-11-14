import { ARCH, HOST_IDS } from "./architecture";
import { ALARM_STATES, firstRelation, hostOfMonitor, normaliseState } from "./alarms";
import { isDone } from "./stations";
import { completedDays, dailySeries, traceStats } from "./telemetry";
import type {
  Board,
  Collection,
  DatadogMonitor,
  HealthGroup,
  HostView,
  PerStationRow,
  Snapshot,
  StationView,
  TraceView,
} from "./types";

/** Collections never read yet (see `BoardOptions.unread`). */
type Unread = ReadonlySet<Collection>;
const NO_UNREAD: Unread = new Set();

const FAILED = new Set(["failure", "timedout", "startupfailure"]);

const runStamp = (r: Snapshot["runs"][number]): string | null => r.properties?.createdAt ?? r.createdAt ?? null;
const isFailedRun = (r: Snapshot["runs"][number]) => FAILED.has(normaliseState(r.properties?.conclusion));

function trace(
  key: TraceView["key"],
  stamps: (string | null | undefined)[],
  now: Date,
  failures: boolean,
  unread: boolean,
): TraceView {
  const series = completedDays(dailySeries(stamps.filter((s): s is string => typeof s === "string"), now));
  return { key, series, ...traceStats(series, failures ? "failures" : "count"), ...(unread ? { unread: true } : {}) };
}

/**
 * Four traces over the 13 completed days. Today is partial and never in a
 * series. A trace whose collection was never read is marked `unread`: it reads
 * "no data" instead of drawing a flat zero line.
 */
export function buildTelemetry(snapshot: Snapshot, now: Date, unread: Unread = NO_UNREAD): TraceView[] {
  return [
    trace("merged", snapshot.prs.map((p) => p.properties?.mergedAt), now, false, unread.has("prs")),
    trace("runs", snapshot.runs.map(runStamp), now, false, unread.has("runs")),
    trace("fails", snapshot.runs.filter(isFailedRun).map(runStamp), now, true, unread.has("runs")),
    trace("done", snapshot.jira.map((j) => j.properties?.resolutionDate), now, false, unread.has("jira")),
  ];
}

/** Per-station table. A service Port does not have reads `null`; the ERPNext ledger has no row. */
export function buildPerStation(snapshot: Snapshot, stations: StationView[]): PerStationRow[] {
  return stations
    .filter((s) => ARCH.stations[s.id].serviceId !== null)
    .map((s) => {
      const service = snapshot.services.find((x) => x.identifier === ARCH.stations[s.id].serviceId);
      const num = (v: number | null | undefined) => (service && typeof v === "number" ? v : null);
      return {
        station: s.id,
        tasks: s.readings.tasks,
        prs: s.readings.prs,
        runs: num(service?.properties?.github_workflow_runs_7d),
        failed: num(service?.properties?.github_failed_workflow_runs_7d),
      };
    });
}

export function buildJira(snapshot: Snapshot, unread: Unread = NO_UNREAD): Board["jira"] {
  if (unread.has("jira")) return { todo: null, inProgress: null, review: null, done: null };
  const out = { todo: 0, inProgress: 0, review: 0, done: 0 };
  for (const issue of snapshot.jira) {
    const status = normaliseState(issue.properties?.status);
    if (isDone(status)) out.done += 1;
    else if (status === "inprogress") out.inProgress += 1;
    else if (status === "inreview" || status === "review") out.review += 1;
    else if (["todo", "backlog", "open"].includes(status)) out.todo += 1;
  }
  return out;
}

const CI_CODE: Record<string, "s" | "f" | "c" | "k"> = {
  success: "s",
  failure: "f",
  timedout: "f",
  startupfailure: "f",
  cancelled: "c",
  skipped: "k",
  neutral: "k",
};

/**
 * The last 72 runs that finished, oldest first. The pass rate is passed over
 * passed plus failed (cancelled and skipped are neither), to one decimal, and
 * `null` when no run passed or failed.
 */
export function buildCi(snapshot: Snapshot, unread: Unread = NO_UNREAD): Board["ci"] {
  if (unread.has("runs")) return { last72: [], passRate: null };
  const finished = snapshot.runs
    .map((r) => ({ at: Date.parse(runStamp(r) ?? ""), code: CI_CODE[normaliseState(r.properties?.conclusion)] }))
    .filter((r) => !Number.isNaN(r.at) && r.code !== undefined)
    .sort((a, b) => a.at - b.at)
    .slice(-72);
  const last72 = finished.map((r) => r.code);
  const passed = last72.filter((c) => c === "s").length;
  const failed = last72.filter((c) => c === "f").length;
  const passRate = passed + failed > 0 ? Math.round((passed / (passed + failed)) * 1000) / 10 : null;
  return { last72, passRate };
}

/**
 * Datadog checks per lab server: the multi-host monitors (`integration:host`)
 * watch every server, a monitor that names one server counts for it alone, and
 * a monitor that cannot be placed counts for none.
 */
export function buildHosts(snapshot: Snapshot, unread: Unread = NO_UNREAD): HostView[] {
  const own = snapshot.monitors.filter((m) => firstRelation(m.relations?.service) === null);
  const isPack = (m: Snapshot["monitors"][number]) =>
    (m.properties?.tags ?? []).some((t) => typeof t === "string" && t.toLowerCase() === "integration:host");
  return HOST_IDS.map((id) => {
    const mine = own.filter((m) => (isPack(m) ? true : hostOfMonitor(m) === id));
    const entity = snapshot.hosts.find((h) => h.identifier === id || h.properties?.host_name === id);
    const up = typeof entity?.properties?.up === "boolean" ? entity.properties.up : null;
    const ok = mine.filter((m) => normaliseState(m.properties?.overallState) === "ok").length;
    return {
      id,
      station: ARCH.hosts[id],
      up,
      checks: { ok, total: mine.length },
      ...(unread.has("monitors") ? { unread: true } : {}),
    };
  });
}

const isPackMonitor = (m: DatadogMonitor): boolean =>
  (m.properties?.tags ?? []).some((t) => typeof t === "string" && t.toLowerCase() === "integration:host");

function tally(key: HealthGroup["key"], monitors: DatadogMonitor[], unread: boolean): HealthGroup {
  const states = monitors.map((m) => normaliseState(m.properties?.overallState));
  return {
    key,
    ok: states.filter((s) => s === "ok").length,
    total: monitors.length,
    alert: states.some((s) => ALARM_STATES.has(s)),
    na: false,
    ...(unread ? { unread: true } : {}),
  };
}

/**
 * Datadog checks grouped by what they watch, in the order the panel shows them.
 * Station groups read the station's Datadog lamp; the monitors that have no
 * workload are split into the multi-host pack, the ones that name one server
 * (databases and cache) and the ones that cannot be placed ("other", only when
 * there are any). Every monitor is counted exactly once.
 */
export function buildHealthChecks(snapshot: Snapshot, stations: StationView[], unread: Unread = NO_UNREAD): HealthGroup[] {
  const noMonitors = unread.has("monitors");
  const own = snapshot.monitors.filter((m) => firstRelation(m.relations?.service) === null);
  const pack = own.filter(isPackMonitor);
  const rest = own.filter((m) => !isPackMonitor(m));
  const named = rest.filter((m) => hostOfMonitor(m) !== "unlocated");
  const other = rest.filter((m) => hostOfMonitor(m) === "unlocated");
  const fromStation = (key: "core" | "admin" | "conn" | "pos"): HealthGroup => {
    const lamp = stations.find((s) => s.id === key)?.lamps.datadog;
    const checks = lamp?.checks;
    return {
      key,
      ok: checks?.ok ?? 0,
      total: checks?.total ?? 0,
      alert: lamp?.state === "alert",
      na: lamp?.state === "na",
      ...(noMonitors && lamp?.state !== "na" ? { unread: true } : {}),
    };
  };
  const groups = [
    fromStation("core"),
    tally("servers", pack, noMonitors),
    tally("databases", named, noMonitors),
    fromStation("admin"),
    fromStation("conn"),
    fromStation("pos"),
  ];
  return other.length > 0 ? [...groups, tally("other", other, noMonitors)] : groups;
}
