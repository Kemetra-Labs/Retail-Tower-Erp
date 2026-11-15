import { ARCH, stationForService } from "../model/architecture";
import { isRealDeployment } from "../model/deployments";
import {
  ALARM_STATES,
  firstRelation,
  hostOfMonitor,
  normaliseState,
  sentryAlarms,
  stationOfWorkload,
  workloadServiceMap,
} from "../model/alarms";
import type {
  Collection,
  DatadogMonitor,
  Deployment,
  JiraIssue,
  PullRequest,
  Relation,
  Snapshot,
  StationId,
  WorkflowRun,
} from "../model/types";
import { REPLAY_MS } from "./blueprints";
import { alarmEvent, eventId, type BoardEvent, type DiffOptions } from "./diff";

const stationOf = (relation: Relation): StationId | null => {
  const service = firstRelation(relation);
  return service ? stationForService(service) : null;
};

const stampOf = (...values: (string | null | undefined)[]): string | null =>
  values.find((v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v))) ?? null;

const CONCLUSION_AR: Record<string, string> = {
  success: "ناجح",
  failure: "فشل",
  cancelled: "أُلغي",
  skipped: "اتخطى",
  timedout: "انتهت مهلته",
  neutral: "محايد",
  actionrequired: "محتاج إجراء",
};
/** Jira statuses by their normalised name; an unknown one keeps the raw word. */
const JIRA_STATUS_AR: Record<string, string> = {
  todo: "للعمل",
  inprogress: "قيد التنفيذ",
  inreview: "قيد المراجعة",
  blocked: "متوقفة",
  done: "تمت",
  closed: "اتقفلت",
  resolved: "اتحلت",
  backlog: "في الخلفية",
};
/** Datadog monitor states by their normalised name. */
const MONITOR_STATE_AR: Record<string, string> = {
  ok: "تمام",
  alert: "إنذار",
  warn: "تحذير",
  nodata: "مفيش بيانات",
  unknown: "مجهول",
  skipped: "اتخطى",
  ignored: "متجاهل",
};

function mergeEvent(pr: PullRequest, at: string): BoardEvent {
  return {
    id: eventId("merge", pr.identifier, at),
    at,
    kind: "merge",
    station: stationOf(pr.relations?.service),
    text: { en: `Merged: ${pr.title}`, ar: `تم الدمج: ${pr.title}` },
  };
}

function ciEvent(run: WorkflowRun, at: string): BoardEvent {
  const result = normaliseState(run.properties?.conclusion);
  return {
    id: eventId("ci", run.identifier, at),
    at,
    kind: "ci",
    station: stationOf(run.relations?.service),
    text: {
      en: `CI run ${result}: ${run.title}`,
      ar: `تشغيل CI ${CONCLUSION_AR[result] ?? result}: ${run.title}`,
    },
  };
}

function jiraEvent(issue: JiraIssue, at: string): BoardEvent {
  const status = issue.properties?.status ?? "unknown";
  return {
    id: eventId("jira", issue.identifier, at),
    at,
    kind: "jira",
    station: stationOf(issue.relations?.service),
    text: { en: `${issue.identifier} is now ${status}`, ar: `${issue.identifier} بقت ${JIRA_STATUS_AR[normaliseState(status)] ?? status}` },
  };
}

function deployEvent(deployment: Deployment, at: string): BoardEvent {
  return {
    id: eventId("deploy", deployment.identifier, at),
    at,
    kind: "deploy",
    station: stationOf(deployment.relations?.service),
    text: { en: `Deployed: ${deployment.title}`, ar: `تم النشر: ${deployment.title}` },
  };
}

/** A monitor change (any state). Unplaceable monitors keep `station: null` and carry no host. */
function monitorEvent(monitor: DatadogMonitor, at: string, byWorkload: Map<string, string>): BoardEvent {
  const workload = firstRelation(monitor.relations?.service);
  const host = workload ? "unlocated" : hostOfMonitor(monitor);
  const station = workload
    ? stationOfWorkload(workload, byWorkload)
    : host === "unlocated"
      ? null
      : ARCH.hosts[host];
  const state = monitor.properties?.overallState ?? "unknown";
  return {
    id: eventId("monitor", monitor.identifier, at),
    at,
    kind: "monitor",
    station,
    alarming: ALARM_STATES.has(normaliseState(state)),
    ...(host !== "unlocated" ? { host } : {}),
    alarmId: monitor.identifier,
    text: { en: `Monitor ${monitor.title}: ${state}`, ar: `المراقب ${monitor.title}: ${MONITOR_STATE_AR[normaliseState(state)] ?? state}` },
  };
}

const byId = <T extends { identifier: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((i) => [i.identifier, i]));

/**
 * Entity changes between two snapshots: a PR merged, a CI run concluded, a Jira
 * issue changing status, a deployment. Alarm sources (Sentry, Datadog) are
 * diffed on the boards instead. A collection in `opts.baseline` was read for
 * the first time in this poll, so its content is a baseline and raises nothing.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot, opts: DiffOptions = {}): BoardEvent[] {
  const events: BoardEvent[] = [];
  const skip = (c: Collection): boolean => opts.baseline?.has(c) ?? false;

  if (!skip("prs")) {
    const old = byId(prev.prs);
    for (const pr of next.prs) {
      const mergedAt = stampOf(pr.properties?.mergedAt);
      if (mergedAt && !old.get(pr.identifier)?.properties?.mergedAt) events.push(mergeEvent(pr, mergedAt));
    }
  }
  if (!skip("runs")) {
    const old = byId(prev.runs);
    for (const run of next.runs) {
      const at = stampOf(run.properties?.createdAt, run.createdAt);
      const conclusion = run.properties?.conclusion;
      // New runs and runs seen in progress (no conclusion) that have concluded since both count.
      if (at && conclusion && old.get(run.identifier)?.properties?.conclusion !== conclusion) {
        events.push(ciEvent(run, at));
      }
    }
  }
  if (!skip("jira")) {
    const old = byId(prev.jira);
    const polledAt = Date.parse(prev.fetchedAt);
    for (const issue of next.jira) {
      const at = stampOf(issue.updatedAt);
      const before = old.get(issue.identifier);
      const changed = before
        ? before.properties?.status !== issue.properties?.status
        : at !== null && Date.parse(at) > polledAt;
      if (at && changed) events.push(jiraEvent(issue, at));
    }
  }
  if (!skip("deployments")) {
    const old = byId(prev.deployments);
    for (const d of next.deployments) {
      const at = stampOf(d.createdAt);
      if (at && isRealDeployment(d) && !old.has(d.identifier)) events.push(deployEvent(d, at));
    }
  }
  return events;
}

/**
 * The 24 h replay: a reconstruction, not a history. Port keeps no change log,
 * so only entities that still exist and changed in the last 24 h appear;
 * resolved Sentry issues and past monitor states are not recoverable. Returned
 * newest first, every event flagged `replay: true`.
 */
export function replayEvents(snapshot: Snapshot, now: Date): BoardEvent[] {
  const from = now.getTime() - REPLAY_MS;
  const to = now.getTime();
  const recent = (stamp: string | null): stamp is string => {
    const ms = stamp === null ? NaN : Date.parse(stamp);
    return !Number.isNaN(ms) && ms > from && ms <= to;
  };
  const byWorkload = workloadServiceMap(snapshot.workloads);
  const events: BoardEvent[] = [];

  for (const pr of snapshot.prs) {
    const at = stampOf(pr.properties?.mergedAt);
    if (recent(at)) events.push(mergeEvent(pr, at));
  }
  for (const run of snapshot.runs) {
    const at = stampOf(run.properties?.createdAt, run.createdAt);
    if (recent(at) && run.properties?.conclusion) events.push(ciEvent(run, at));
  }
  for (const issue of snapshot.jira) {
    const at = stampOf(issue.updatedAt);
    if (recent(at)) events.push(jiraEvent(issue, at));
  }
  for (const d of snapshot.deployments) {
    const at = stampOf(d.createdAt);
    if (recent(at) && isRealDeployment(d)) events.push(deployEvent(d, at));
  }
  for (const alarm of sentryAlarms(snapshot.sentryIssues, byWorkload)) {
    if (recent(stampOf(alarm.since))) events.push(alarmEvent(alarm, alarm.since as string));
  }
  for (const monitor of snapshot.monitors) {
    const at = stampOf(monitor.updatedAt);
    if (recent(at)) events.push(monitorEvent(monitor, at, byWorkload));
  }
  return events
    .map((e) => ({ ...e, replay: true }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
