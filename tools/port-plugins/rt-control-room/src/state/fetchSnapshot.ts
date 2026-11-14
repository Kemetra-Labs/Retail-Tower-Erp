import { PortApiError, type PortClient, type PortQuery, type PortRule } from "../api/portClient";
import type { Collection, Integration, Snapshot } from "../model/types";
import { BLUEPRINTS, DAY_MS, JIRA_DONE_STATUSES, JIRA_SERVICE_RELATION, WINDOW_DAYS } from "./blueprints";

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

type Plan = { collection: Collection; blueprint: string; query: PortQuery; replace: boolean; delta: boolean };

const rule = (property: string, operator: string, value?: unknown): PortRule =>
  value === undefined ? { property, operator } : { property, operator, value };
const between = (property: string, from: string, to: string): PortRule =>
  rule(property, "between", { from, to });
const all = (blueprint: string): PortQuery => ({
  combinator: "and",
  rules: [rule("$blueprint", "=", blueprint)],
});

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
    query: all(blueprint),
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
  const windowed = (collection: Collection, blueprint: string, rules: (PortRule | PortQuery)[]): Plan => ({
    collection,
    blueprint,
    query: { combinator: "and", rules: [...rules, ...updated(collection)] },
    replace: false,
    delta: isDelta(collection),
  });

  return [
    tiny("services", BLUEPRINTS.service),
    tiny("workloads", BLUEPRINTS.workload),
    tiny("hosts", BLUEPRINTS.host),
    alarm("sentryIssues", BLUEPRINTS.sentryIssue, [rule("status", "=", "unresolved")]),
    alarm("monitors", BLUEPRINTS.monitor, [rule("$blueprint", "=", BLUEPRINTS.monitor)]),
    // Unconfirmed against live Port until Task 12: the relation-set rule and the nested "or" group.
    windowed("jira", BLUEPRINTS.jira, [
      rule(JIRA_SERVICE_RELATION, "isNotEmpty"),
      {
        combinator: "or",
        rules: [rule("status", "notIn", JIRA_DONE_STATUSES), between("resolutionDate", start, to)],
      },
    ]),
    windowed("prs", BLUEPRINTS.pullRequest, [between("mergedAt", start, to)]),
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
    store[plan.collection] = res.value;
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
