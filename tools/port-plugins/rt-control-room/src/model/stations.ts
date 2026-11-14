import { ARCH, STATION_IDS } from "./architecture";
import { firstRelation, normaliseState } from "./alarms";
import { lampEvidence, stationLamps } from "./lamps";
import { completedDays, dailySeries } from "./telemetry";
import type {
  Alarm,
  AlarmReading,
  Lamp,
  PullRequest,
  Relation,
  SourceId,
  Snapshot,
  StationId,
  StationView,
} from "./types";

const WEEK_MS = 7 * 86_400_000;
const DONE = new Set(["done", "closed", "resolved"]);

export const isDone = (status: string | null | undefined): boolean => DONE.has(normaliseState(status));

/** A pull request that is neither merged nor closed. */
const isOpenPr = (pr: PullRequest): boolean =>
  !pr.properties?.mergedAt && !["closed", "merged", "declined"].includes(normaliseState(pr.properties?.status));

const linked = <T extends { relations?: { service?: Relation } }>(items: T[], serviceId: string): T[] =>
  items.filter((i) => firstRelation(i.relations?.service) === serviceId);

/** The example alarm lowers one check on its station's Datadog lamp, as in the approved mockup. */
function withExampleAlarms(lamps: Record<SourceId, Lamp>, station: StationId, alarms: Alarm[]): Record<SourceId, Lamp> {
  const hit = alarms.some((a) => a.example && a.source === "Datadog" && a.station === station);
  const checks = lamps.datadog.checks;
  if (!hit || !checks) return lamps;
  return { ...lamps, datadog: { state: "alert", checks: { ok: Math.max(0, checks.ok - 1), total: checks.total } } };
}

function checksReading(lamp: Lamp, hasService: boolean): StationView["readings"]["checks"] {
  if (lamp.state === "na") return "na";
  return hasService ? (lamp.checks ?? null) : null;
}

const NO_DATA = { ci7d: null, tasks: null, prs: null, merged7d: null, deploys: null, ciFails7d: null };

function readingsFrom(snapshot: Snapshot, id: StationId, now: Date) {
  const serviceId = ARCH.stations[id].serviceId;
  const service = serviceId ? snapshot.services.find((s) => s.identifier === serviceId) : undefined;
  if (!serviceId || !service) return { ...NO_DATA, merged: [] as string[], runs7d: null };

  const runs = service.properties?.github_workflow_runs_7d;
  const fails = service.properties?.github_failed_workflow_runs_7d;
  const prs = linked(snapshot.prs, serviceId);
  const merged = prs.map((p) => p.properties?.mergedAt).filter((m): m is string => typeof m === "string");
  const recent = merged.filter((m) => Date.parse(m) > now.getTime() - WEEK_MS).length;
  return {
    // A pass rate needs runs; zero or missing runs is "no data", never 0 or 100.
    ci7d: typeof runs === "number" && runs > 0 ? Math.round(((runs - (fails ?? 0)) / runs) * 100) : null,
    tasks: linked(snapshot.jira, serviceId).filter((j) => !isDone(j.properties?.status)).length,
    prs: prs.filter(isOpenPr).length,
    merged7d: recent,
    deploys: linked(snapshot.deployments, serviceId).length,
    ciFails7d: typeof fails === "number" ? fails : null,
    merged,
    runs7d: typeof runs === "number" ? runs : null,
  };
}

/**
 * The five stations with their readings. A missing service entity (and the
 * ERPNext ledger, which has none by design) reads `null` ("no data"), never 0.
 * Alarm counts come from the alarms themselves, or "not-read" when the Sentry
 * read failed, so a failed read can never show as 0.
 */
export function buildStations(
  snapshot: Snapshot,
  alarms: Alarm[],
  now: Date,
  sentryRead: boolean,
): StationView[] {
  return STATION_IDS.map((id) => {
    const arch = ARCH.stations[id];
    const hasService = snapshot.services.some((s) => s.identifier === arch.serviceId);
    const lamps = withExampleAlarms(stationLamps(id, lampEvidence(id, snapshot)), id, alarms);
    const r = readingsFrom(snapshot, id, now);
    const alarmReading: AlarmReading = sentryRead ? alarms.filter((a) => a.station === id).length : "not-read";
    return {
      id,
      name: arch.name,
      role: arch.role,
      lamps,
      readings: {
        alarms: alarmReading,
        checks: checksReading(lamps.datadog, hasService),
        ci7d: r.ci7d,
        tasks: r.tasks,
        prs: r.prs,
        merged7d: r.merged7d,
        deploys: r.deploys,
        ciFails7d: r.ciFails7d,
      },
      merged13d: hasService ? completedDays(dailySeries(r.merged, now)) : [],
      activity7d: (r.runs7d ?? 0) + (r.merged7d ?? 0),
    };
  });
}
