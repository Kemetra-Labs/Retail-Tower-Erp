import { PortApiError, type PortClient, type PortQuery, type PortRule } from "../api/portClient";
import { firstRelation } from "../model/alarms";
import { isDone, isOpenPr } from "../model/stations";
import type { Collection, Integration, JiraIssue, PullRequest, Snapshot } from "../model/types";
import { BLUEPRINTS, DAY_MS, JIRA_SERVICE_RELATION, WINDOW_DAYS } from "./blueprints";

export type FetchOptions = {
  /** The instant this poll starts; the windows end here. Defaults to the clock. */
  now?: Date;
  /** Collections never read successfully: they get a full or window fetch, never a delta. */
  neverRead?: ReadonlySet<Collection>;
};

export type FetchResult = {
  /** Only collections whose fetch completed (every page). Present means authoritative. */
  data: Partial<Snapshot>;
  /** Collections whose fetch failed or came back incomplete: "unchanged", never "empty". */
  failed: Collection[];
  /** Collections of `data` that a full fetch produced, so merging must REPLACE them. */
  replace: Collection[];
  /** Collections fetched as a delta (updated since `since`) this poll. */
  delta: Collection[];
  /** HTTP status of the first failure, when it had one. Never a response body. */
  errorStatus: number | null;
};

type Plan = {
  collection: Collection;
  blueprint: string;
  query: PortQuery;
  replace: boolean;
  delta: boolean;
  /** Client-side narrowing of what the server returned (see `keepJira`). */
  keep?: (entity: never) => boolean;
};

const rule = (property: string, operator: string, value?: unknown): PortRule =>
  value === undefined ? { property, operator } : { property, operator, value };
const between = (property: string, from: string, to: string): PortRule =>
  rule(property, "between", { from, to });

/**
 * Only Port-documented or live-proven rule shapes are sent: `{ combinator: "and", rules: [] }`
 * for "everything of this blueprint" (the endpoint is already per blueprint), `between` on a
 * date property, and a plain property `=`. A 422 on an unproven shape would keep the board
 * stale forever, so anything else (set tests, `notIn`, nested groups) is filtered on the client.
 */
const EVERYTHING: PortRule[] = [];

/** Jira issues the board reads: linked to a service, and not resolved before the window. */
const keepJira =
  (windowStart: number) =>
  (issue: JiraIssue): boolean => {
    if (!firstRelation(issue.relations?.[JIRA_SERVICE_RELATION])) return false;
    const resolved = Date.parse(issue.properties?.resolutionDate ?? "");
    return !(isDone(issue.properties?.status) && !Number.isNaN(resolved) && resolved < windowStart);
  };

/**
 * Pull requests the board reads. An open PR has no `mergedAt`, so a window rule on it would never
 * return one: a full read takes EVERY PR and keeps service-linked ones that are open or were merged
 * inside the window. A delta read (`$updatedAt between`) keeps every service-linked PR it returns,
 * so a PR that just closed replaces its cached open copy instead of leaving it counted.
 */
const keepPr =
  (windowStart: number, full: boolean) =>
  (pr: PullRequest): boolean => {
    if (!firstRelation(pr.relations?.service)) return false;
    if (!full) return true;
    const merged = Date.parse(pr.properties?.mergedAt ?? "");
    return isOpenPr(pr) || (!Number.isNaN(merged) && merged >= windowStart);
  };

/** Fetch scope per blueprint (plan Task 7). Bodies are nested under `query`. */
function plansFor(since: string | null, full: boolean, now: Date, neverRead?: ReadonlySet<Collection>): Plan[] {
  const to = now.toISOString();
  const start = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const isDelta = (c: Collection): boolean => !full && since !== null && !(neverRead?.has(c) ?? false);
  const updated = (c: Collection): PortRule[] =>
    isDelta(c) && since !== null ? [between("$updatedAt", since, to)] : [];

  const tiny = (collection: Collection, blueprint: string): Plan => ({
    collection,
    blueprint,
    query: { combinator: "and", rules: EVERYTHING },
    replace: true,
    delta: false,
  });
  const alarm = (collection: Collection, blueprint: string, base: PortRule[]): Plan => ({
    collection,
    blueprint,
    query: { combinator: "and", rules: [...base, ...updated(collection)] },
    replace: !isDelta(collection),
    delta: isDelta(collection),
  });
  const windowed = (collection: Collection, blueprint: string, rules: PortRule[]): Plan => ({
    collection,
    blueprint,
    query: { combinator: "and", rules: [...rules, ...updated(collection)] },
    replace: false,
    delta: isDelta(collection),
  });

  const jira = (): Plan => ({
    collection: "jira",
    blueprint: BLUEPRINTS.jira,
    query: { combinator: "and", rules: [...EVERYTHING, ...updated("jira")] },
    replace: !isDelta("jira"),
    delta: isDelta("jira"),
    keep: keepJira(Date.parse(start)),
  });

  const prs = (): Plan => ({
    collection: "prs",
    blueprint: BLUEPRINTS.pullRequest,
    query: { combinator: "and", rules: [...EVERYTHING, ...updated("prs")] },
    replace: !isDelta("prs"),
    delta: isDelta("prs"),
    keep: keepPr(Date.parse(start), !isDelta("prs")),
  });

  return [
    tiny("services", BLUEPRINTS.service),
    tiny("workloads", BLUEPRINTS.workload),
    tiny("hosts", BLUEPRINTS.host),
    alarm("sentryIssues", BLUEPRINTS.sentryIssue, [rule("status", "=", "unresolved")]),
    alarm("monitors", BLUEPRINTS.monitor, EVERYTHING),
    // Jira: the first load and every full poll read EVERY issue (`rules: []`, paged) so an open issue
    // untouched for months is still counted, then `keepJira` keeps service-linked issues and drops old
    // Done ones; that read is authoritative and replaces the collection. A delta reads only issues
    // updated since the last poll (`$updatedAt between`) and is merged by identifier.
    jira(),
    // Pull requests follow the Jira rhythm: every PR on a full poll (an open one is never "merged in
    // the window"), only the ones updated since the last poll on a delta.
    prs(),
    windowed("runs", BLUEPRINTS.workflowRun, [between("createdAt", start, to)]),
    windowed("deployments", BLUEPRINTS.deployment, [between("createdAt", start, to)]),
  ];
}

const statusOf = (reason: unknown): number | null =>
  reason instanceof PortApiError ? reason.status : null;

/**
 * One poll's reads. Each collection is read independently: a failure (or a
 * missing page, which the client reports as an error) puts it in `failed` and
 * leaves it out of `data`. `GET /v1/integration` answering 403 is data
 * (`"forbidden"`), not a failure. Full versus delta, and which collections the
 * merge must replace, follow the plan's Task 7 table.
 */
export async function fetchSnapshot(
  client: PortClient,
  since: string | null,
  full: boolean,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const now = opts.now ?? new Date();
  const plans = plansFor(since, full, now, opts.neverRead);
  const [searches, integration] = await Promise.all([
    Promise.allSettled(plans.map((p) => client.search<unknown>(p.blueprint, p.query))),
    client.get<{ integrations?: Integration[] } | Integration[]>("/v1/integration").then(
      (value) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason }),
    ),
  ]);

  const data: Partial<Snapshot> = { fetchedAt: now.toISOString() };
  const store = data as Record<string, unknown>;
  const failed: Collection[] = [];
  const replace: Collection[] = [];
  const delta: Collection[] = [];
  let errorStatus: number | null = null;
  const fail = (collection: Collection, reason: unknown): void => {
    failed.push(collection);
    errorStatus ??= statusOf(reason);
  };

  plans.forEach((plan, i) => {
    const res = searches[i];
    if (res.status === "rejected") return fail(plan.collection, res.reason);
    store[plan.collection] = plan.keep ? (res.value as never[]).filter(plan.keep) : res.value;
    if (plan.replace) replace.push(plan.collection);
    if (plan.delta) delta.push(plan.collection);
  });

  if (!integration.ok) {
    if (statusOf(integration.reason) === 403) {
      store.integrations = "forbidden";
      replace.push("integrations");
    } else {
      fail("integrations", integration.reason);
    }
  } else {
    const value = integration.value;
    const list = Array.isArray(value) ? value : value?.integrations;
    if (Array.isArray(list)) {
      store.integrations = list;
      replace.push("integrations");
    } else {
      fail("integrations", null);
    }
  }
  return { data, failed, replace, delta, errorStatus };
}
