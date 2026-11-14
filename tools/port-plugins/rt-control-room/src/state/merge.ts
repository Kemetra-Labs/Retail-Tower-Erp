import type { Collection, Deployment, JiraIssue, PullRequest, Snapshot, WorkflowRun } from "../model/types";
import { DAY_MS, WINDOW_DAYS } from "./blueprints";

type Entity = { identifier: string };

/** Collections of entities (everything but the integration list). */
const ENTITY_COLLECTIONS: Exclude<Collection, "integrations">[] = [
  "services",
  "workloads",
  "sentryIssues",
  "monitors",
  "hosts",
  "jira",
  "prs",
  "runs",
  "deployments",
];

/**
 * The base before the first poll: every collection empty and the integration
 * list unread. It exists so a partial first load still builds a board.
 */
export function emptySnapshot(fetchedAt: string): Snapshot {
  return {
    services: [],
    workloads: [],
    sentryIssues: [],
    monitors: [],
    hosts: [],
    jira: [],
    prs: [],
    runs: [],
    deployments: [],
    integrations: "forbidden",
    fetchedAt,
  };
}

function mergeById<T extends Entity>(prev: T[], incoming: T[]): T[] {
  const index = new Map(prev.map((e, i) => [e.identifier, i]));
  const out = prev.slice();
  for (const entity of incoming) {
    const at = index.get(entity.identifier);
    if (at === undefined) {
      index.set(entity.identifier, out.length);
      out.push(entity);
    } else {
      out[at] = entity;
    }
  }
  return out;
}

const before = (stamp: string | null | undefined, cutoff: number): boolean => {
  const ms = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  return !Number.isNaN(ms) && ms < cutoff;
};

const DONE = /^(done|closed|resolved)$/i;

/** Windowed collections drop entities older than the window; an entity with no usable date is kept. */
function prune(collection: Collection, items: Entity[], cutoff: number): Entity[] {
  switch (collection) {
    case "jira":
      return (items as JiraIssue[]).filter(
        (j) => !(DONE.test(j.properties?.status ?? "") && before(j.properties?.resolutionDate, cutoff)),
      );
    case "prs":
      return (items as PullRequest[]).filter((p) => !before(p.properties?.mergedAt, cutoff));
    case "runs":
      return (items as WorkflowRun[]).filter((r) => !before(r.properties?.createdAt ?? r.createdAt, cutoff));
    case "deployments":
      return (items as Deployment[]).filter((d) => !before(d.createdAt, cutoff));
    default:
      return items;
  }
}

/**
 * Fold one poll's reads into the cached snapshot. A key ABSENT from `delta`
 * means "unchanged" (its fetch failed, was incomplete, or was not scheduled);
 * only a key that is present, including `[]` or `"forbidden"`, is authoritative.
 * Collections named in `replace` are REPLACED by the fetched array; every other
 * collection is merged by `identifier` (a delta never removes anything) and
 * pruned to its window. The integration list is always replaced.
 */
export function mergeSnapshot(prev: Snapshot, delta: Partial<Snapshot>, replace: Collection[]): Snapshot {
  const fetchedAt = delta.fetchedAt ?? prev.fetchedAt;
  const cutoff = Date.parse(fetchedAt) - WINDOW_DAYS * DAY_MS;
  const out: Snapshot = { ...prev, fetchedAt };
  const target = out as Record<string, unknown>;
  const incomingOf = delta as Record<string, unknown>;
  const previousOf = prev as Record<string, unknown>;

  if (delta.integrations !== undefined) out.integrations = delta.integrations;
  for (const collection of ENTITY_COLLECTIONS) {
    const incoming = incomingOf[collection] as Entity[] | undefined;
    if (incoming === undefined) continue;
    target[collection] = replace.includes(collection)
      ? incoming
      : prune(collection, mergeById(previousOf[collection] as Entity[], incoming), cutoff);
  }
  return out;
}
