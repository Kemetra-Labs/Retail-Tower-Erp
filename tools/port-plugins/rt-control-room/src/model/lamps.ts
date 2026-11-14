import { ARCH } from "./architecture";
import {
  ALARM_STATES,
  firstRelation,
  normaliseState,
  stationOfWorkload,
  workloadServiceMap,
} from "./alarms";
import type { Collection, Lamp, Relation, SourceId, Snapshot, StationId } from "./types";

/** What a station's four link lamps are drawn from; counts, never guesses. */
export type LampEvidence = {
  /** Some workload of the station has a Sentry project relation. */
  sentryProject: boolean;
  /** Sentry issues attached to the station's workloads: the "sending" evidence. */
  sentryIssues: number;
  /** Datadog monitors on the station's workloads, split by state. */
  monitors: { ok: number; alarming: number; total: number };
  /** Pull requests, workflow runs and deployments linked to the station's service. */
  github: number;
  /** Jira issues linked to the station's service. */
  jira: number;
};

const SOURCES: SourceId[] = ["sentry", "datadog", "github", "jira"];

/** Collections never read yet (see `BoardOptions.unread`). */
type Unread = ReadonlySet<Collection>;
const NO_UNREAD: Unread = new Set();

/** "None" with no evidence is "not read" when a collection behind it was never read. */
const noEvidence = (unread: boolean): Lamp => (unread ? { state: "none", unread: true } : { state: "none" });

function datadogLamp(station: StationId, m: LampEvidence["monitors"], unread: boolean): Lamp {
  // POS has no Datadog by design; it is "not needed", not "missing".
  if (station === "pos") return { state: "na" };
  if (m.total === 0) return noEvidence(unread);
  const checks = { ok: m.ok, total: m.total };
  if (m.alarming > 0) return { state: "alert", checks };
  // "Sending" needs evidence: at least one monitor reporting OK.
  return { state: m.ok > 0 ? "sending" : "linked", checks };
}

/** The four link lamps of one station. The ERPNext ledger has none: all "na". */
export function stationLamps(
  station: StationId,
  evidence: LampEvidence,
  unread: Unread = NO_UNREAD,
): Record<SourceId, Lamp> {
  if (station === "erp") {
    return Object.fromEntries(SOURCES.map((s) => [s, { state: "na" } satisfies Lamp])) as Record<
      SourceId,
      Lamp
    >;
  }
  const githubUnread = unread.has("prs") || unread.has("runs") || unread.has("deployments");
  return {
    sentry: evidence.sentryProject
      ? { state: evidence.sentryIssues > 0 ? "sending" : "linked" }
      : noEvidence(unread.has("workloads")),
    datadog: datadogLamp(station, evidence.monitors, unread.has("monitors")),
    github: evidence.github > 0 ? { state: "live" } : noEvidence(githubUnread),
    jira: evidence.jira > 0 ? { state: "live" } : noEvidence(unread.has("jira")),
  };
}

function linkedTo(entities: { relations?: { service?: Relation } }[], serviceId: string): number {
  let n = 0;
  for (const e of entities) if (firstRelation(e.relations?.service) === serviceId) n += 1;
  return n;
}

/** Derive a station's lamp evidence from the snapshot collections. */
export function lampEvidence(station: StationId, snapshot: Snapshot): LampEvidence {
  const serviceId = ARCH.stations[station].serviceId;
  const workloadToService = workloadServiceMap(snapshot.workloads);
  const mine = (workload: Relation): boolean => stationOfWorkload(workload, workloadToService) === station;

  const sentryProject = snapshot.workloads.some(
    (w) => mine(w.identifier) && firstRelation(w.relations?.sentry_project) !== null,
  );
  const sentryIssues = snapshot.sentryIssues.filter((i) => mine(i.relations?.workload)).length;

  const monitors = { ok: 0, alarming: 0, total: 0 };
  for (const m of snapshot.monitors) {
    if (!mine(m.relations?.service)) continue;
    monitors.total += 1;
    const state = normaliseState(m.properties?.overallState);
    if (state === "ok") monitors.ok += 1;
    else if (ALARM_STATES.has(state)) monitors.alarming += 1;
  }

  const github =
    serviceId === null
      ? 0
      : linkedTo(snapshot.prs, serviceId) +
        linkedTo(snapshot.runs, serviceId) +
        linkedTo(snapshot.deployments, serviceId);
  const jira = serviceId === null ? 0 : linkedTo(snapshot.jira, serviceId);

  return { sentryProject, sentryIssues, monitors, github, jira };
}
