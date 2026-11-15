import { ARCH, STATION_IDS, failingHopOf } from "./architecture";
import { isRealDeployment } from "./deployments";
import { firstRelation, normaliseState } from "./alarms";
import { lampEvidence, stationLamps } from "./lamps";
import { completedDays, dailySeries } from "./telemetry";
import type {
  Alarm,
  AlarmReading,
  Collection,
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
export const isOpenPr = (pr: PullRequest): boolean =>
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

/** Collections never read yet; a reading derived from one is `null` ("no data"), never 0. */
type Unread = ReadonlySet<Collection>;

function readingsFrom(snapshot: Snapshot, id: StationId, now: Date, unread: Unread) {
  const serviceId = ARCH.stations[id].serviceId;
  const service = serviceId ? snapshot.services.find((s) => s.identifier === serviceId) : undefined;
  if (!serviceId || !service) return { ...NO_DATA, merged: [] as string[], runs7d: null };

  const runs = service.properties?.github_workflow_runs_7d;
  const fails = service.properties?.github_failed_workflow_runs_7d;
  const prs = linked(snapshot.prs, serviceId);
  const merged = unread.has("prs")
    ? []
    : prs.map((p) => p.properties?.mergedAt).filter((m): m is string => typeof m === "string");
  const recent = merged.filter((m) => Date.parse(m) > now.getTime() - WEEK_MS).length;
  return {
    // A pass rate needs runs AND a failed count; a missing figure is "no data", never 0 or 100.
    ci7d:
      typeof runs === "number" && runs > 0 && typeof fails === "number"
        ? Math.round(((runs - fails) / runs) * 100)
        : null,
    tasks: unread.has("jira") ? null : linked(snapshot.jira, serviceId).filter((j) => !isDone(j.properties?.status)).length,
    prs: unread.has("prs") ? null : prs.filter(isOpenPr).length,
    merged7d: unread.has("prs") ? null : recent,
    deploys: unread.has("deployments") ? null : linked(snapshot.deployments.filter(isRealDeployment), serviceId).length,
    ciFails7d: typeof fails === "number" ? fails : null,
    merged,
    runs7d: typeof runs === "number" ? runs : null,
  };
}

/**
 * The alarms a station counts and lists (RT-1408 A): where they FAIL (the verdict light's scope), or,
 * with no known hop, where they were reported. POS also counts what its own app reports (the
 * Cashier light's scope), so an error the POS app reports about Backend-Core's cable shows on both.
 * The card, the table row and the detail panel all use this one predicate.
 */
export function alarmsOfStation(alarms: Alarm[], id: StationId): Alarm[] {
  return alarms.filter((a) => (failingHopOf(a.at) ?? a.station) === id || (id === "pos" && a.station === "pos"));
}

/**
 * The five stations with their readings. A missing service entity (and the
 * ERPNext ledger, which has none by design) reads `null` ("no data"), never 0.
 * Alarm counts come from the alarms themselves, or "not-read" when the Sentry
 * read failed, so a failed read can never show as 0. A collection in `unread`
 * (never read yet) makes the readings derived from it `null`, "no data".
 */
export function buildStations(
  snapshot: Snapshot,
  alarms: Alarm[],
  now: Date,
  sentryRead: boolean,
  unread: Unread = new Set(),
  failed: Unread = new Set(),
): StationView[] {
  return STATION_IDS.map((id) => {
    const arch = ARCH.stations[id];
    const hasService = snapshot.services.some((s) => s.identifier === arch.serviceId);
    const lamps = withExampleAlarms(stationLamps(id, lampEvidence(id, snapshot), unread, failed), id, alarms);
    const r = readingsFrom(snapshot, id, now, unread);
    // One reading everywhere (RT-1408 A): an alarm counts where it FAILS (the verdict light's scope),
    // not where it was reported. An alarm with no known hop falls back to the reporting service. The
    // POS card also counts what the POS app itself reports (the Cashier light's scope), even when
    // the failing hop is Backend-Core's cable, so the card and that light never disagree.
    const alarmReading: AlarmReading = sentryRead ? alarmsOfStation(alarms, id).length : "not-read";
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
      merged13d: hasService && !unread.has("prs") ? completedDays(dailySeries(r.merged, now)) : [],
      activity7d: (r.runs7d ?? 0) + (r.merged7d ?? 0),
    };
  });
}
