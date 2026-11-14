import { ARCH, CABLE_IDS } from "./architecture";
import { datadogAlarms, firstRelation, sentryAlarms, stationOfWorkload, workloadServiceMap } from "./alarms";
import { buildCi, buildHealthChecks, buildHosts, buildJira, buildPerStation, buildTelemetry } from "./panels";
import { buildSources } from "./sources";
import { buildStations } from "./stations";
import { buildVerdict } from "./verdict";
import type { Alarm, Board, CableView, Collection, Snapshot, StationId, StationView } from "./types";

export type BoardOptions = {
  /** The instant "now" is measured from (freshness, 7-day windows, Cairo days). */
  now: Date;
  /** Adds the labelled example latency alarm (`?demo=1`). Never real data. */
  demo: boolean;
  /**
   * `sentry` is false when the Sentry issue read has never succeeded or the
   * latest one failed. Station alarm counts then read "not-read" and no light
   * claims there are no errors; alarms already known are still listed. Default true.
   */
  alarmRead?: { sentry: boolean };
  /**
   * Collections never read successfully yet. What is derived from one reads
   * "no data" (`null`), never 0 or "none": tasks, PRs, merges, deploys, CI,
   * the matching telemetry traces, and the Datadog checks (a station is then
   * "not read", not "no health check"). Sentry has its own `alarmRead`.
   */
  unread?: readonly Collection[];
};

/** The example alarm of the approved mockup: a latency alarm on Backend-Core, labelled example. */
const EXAMPLE_ALARM: Alarm = {
  id: "example-latency",
  kind: "latency",
  source: "Datadog",
  station: "core",
  at: "core",
  title: "[EXAMPLE] backend-api p95 latency high (lab)",
  message: "[EXAMPLE] backend-api p95 latency high (lab): p95 = 1.8 s, threshold 1 s, for 5 min",
  since: null,
  link: null,
  example: true,
};

/** Stations with a Sentry project on some workload (the snapshot's `sentry_project` relation). */
function sentryWatched(snapshot: Snapshot): Set<StationId> {
  const byWorkload = workloadServiceMap(snapshot.workloads);
  const out = new Set<StationId>();
  for (const w of snapshot.workloads) {
    if (firstRelation(w.relations?.sentry_project) === null) continue;
    const station = stationOfWorkload(w.identifier, byWorkload);
    if (station) out.add(station);
  }
  return out;
}

function buildCables(alarms: Alarm[], snapshot: Snapshot): CableView[] {
  const watchedBy = sentryWatched(snapshot);
  return CABLE_IDS.map((id) => {
    const faults = alarms.filter((a) => a.at === id).length;
    const { from, to, carries } = ARCH.cables[id];
    const watched = watchedBy.has(ARCH.cableReporter[id]);
    return { id, from, to, carries, state: faults > 0 ? "fault" : "live", faults, watched };
  });
}

function unknownStations(stations: StationView[]): Board["unknowns"] {
  // A station with no health check at all. POS (none by design) and ERPNext (external ledger) are "na".
  return stations
    .filter((s) => s.lamps.datadog.state === "none" && !s.lamps.datadog.unread)
    .map((s) => ({ station: s.id, reason: "no-health-check" as const }));
}

/**
 * The pure model of the control room: Port entities in, everything the board
 * draws out. It never mutates the snapshot and never throws on missing data:
 * a missing figure is `null`, an unreadable one "not-read", never 0.
 */
export function buildBoard(snapshot: Snapshot, opts: BoardOptions): Board {
  const sentryRead = opts.alarmRead?.sentry !== false;
  const byWorkload = workloadServiceMap(snapshot.workloads);
  const alarms: Alarm[] = [
    ...sentryAlarms(snapshot.sentryIssues, byWorkload),
    ...datadogAlarms(snapshot.monitors, byWorkload),
    ...(opts.demo ? [EXAMPLE_ALARM] : []),
  ];
  const unread = new Set<Collection>(opts.unread ?? []);
  const stations = buildStations(snapshot, alarms, opts.now, sentryRead, unread);
  const sources = buildSources(snapshot, opts.now);
  const checks = (id: "core" | "conn") => stations.find((s) => s.id === id)?.readings.checks ?? null;

  return {
    stations,
    cables: buildCables(alarms, snapshot),
    alarms,
    unknowns: unknownStations(stations),
    sources,
    telemetry: buildTelemetry(snapshot, opts.now, unread),
    verdict: buildVerdict({
      alarms,
      checks: { core: checks("core"), conn: checks("conn") },
      sources,
      sentryRead,
      monitorsRead: !unread.has("monitors"),
    }),
    hosts: buildHosts(snapshot, unread),
    perStation: buildPerStation(snapshot, stations),
    healthChecks: buildHealthChecks(snapshot, stations, unread),
    jira: buildJira(snapshot, unread),
    ci: buildCi(snapshot, unread),
    alarmRead: { sentry: sentryRead },
  };
}
