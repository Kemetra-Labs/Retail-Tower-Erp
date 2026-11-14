import { ARCH, HOST_IDS } from "./architecture";
import { firstRelation, hostOfMonitor, normaliseState } from "./alarms";
import { isDone } from "./stations";
import { completedDays, dailySeries, traceStats } from "./telemetry";
import type { Board, HostView, PerStationRow, Snapshot, StationView, TraceView } from "./types";

const FAILED = new Set(["failure", "timedout", "startupfailure"]);

const runStamp = (r: Snapshot["runs"][number]): string | null => r.properties?.createdAt ?? r.createdAt ?? null;
const isFailedRun = (r: Snapshot["runs"][number]) => FAILED.has(normaliseState(r.properties?.conclusion));

function trace(key: TraceView["key"], stamps: (string | null | undefined)[], now: Date, failures: boolean): TraceView {
  const series = completedDays(dailySeries(stamps.filter((s): s is string => typeof s === "string"), now));
  return { key, series, ...traceStats(series, failures ? "failures" : "count") };
}

/** Four traces over the 13 completed days. Today is partial and never in a series. */
export function buildTelemetry(snapshot: Snapshot, now: Date): TraceView[] {
  return [
    trace("merged", snapshot.prs.map((p) => p.properties?.mergedAt), now, false),
    trace("runs", snapshot.runs.map(runStamp), now, false),
    trace("fails", snapshot.runs.filter(isFailedRun).map(runStamp), now, true),
    trace("done", snapshot.jira.map((j) => j.properties?.resolutionDate), now, false),
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

export function buildJira(snapshot: Snapshot): Board["jira"] {
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
export function buildCi(snapshot: Snapshot): Board["ci"] {
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
export function buildHosts(snapshot: Snapshot): HostView[] {
  const own = snapshot.monitors.filter((m) => firstRelation(m.relations?.service) === null);
  const isPack = (m: Snapshot["monitors"][number]) =>
    (m.properties?.tags ?? []).some((t) => typeof t === "string" && t.toLowerCase() === "integration:host");
  return HOST_IDS.map((id) => {
    const mine = own.filter((m) => (isPack(m) ? true : hostOfMonitor(m) === id));
    const entity = snapshot.hosts.find((h) => h.identifier === id || h.properties?.host_name === id);
    const up = typeof entity?.properties?.up === "boolean" ? entity.properties.up : null;
    const ok = mine.filter((m) => normaliseState(m.properties?.overallState) === "ok").length;
    return { id, station: ARCH.hosts[id], up, checks: { ok, total: mine.length } };
  });
}
