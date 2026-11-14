import { sourceFreshness } from "./freshness";
import type { Collection, Integration, SourceId, SourceView, Snapshot } from "./types";

/** The Port blueprints (as snapshot collections) each source's entities live in. */
const COLLECTIONS: Record<SourceId, Collection[]> = {
  sentry: ["sentryIssues"],
  datadog: ["monitors", "hosts"],
  github: ["prs", "runs", "deployments"],
  jira: ["jira"],
};

/** `integrationType` values as Port reports them: GitHub's Ocean integration is `github-ocean`. */
const INTEGRATION_TYPES: Record<SourceId, string[]> = {
  sentry: ["sentry"],
  datadog: ["datadog"],
  github: ["github-ocean", "github"],
  jira: ["jira"],
};

const SOURCES: SourceId[] = ["sentry", "datadog", "github", "jira"];

function newest(stamps: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const stamp of stamps) {
    if (typeof stamp !== "string") continue;
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    best = stamp;
    bestMs = ms;
  }
  return best;
}

function lastSyncOf(source: SourceId, integrations: Integration[]): string | null {
  const types = INTEGRATION_TYPES[source];
  return newest(
    integrations
      .filter((i) => types.includes(String(i.integrationType).toLowerCase()))
      .map((i) => i.resyncState?.lastResyncEnd),
  );
}

/**
 * Freshness of the four sources from the snapshot alone: the newest `updatedAt`
 * of each source's entities, plus the integration's last completed sync when
 * `GET /v1/integration` was readable. When it was forbidden, the newest change
 * is all there is, and the result never defaults to fresh.
 */
export function buildSources(snapshot: Snapshot, now: Date): Record<SourceId, SourceView> {
  const forbidden = snapshot.integrations === "forbidden";
  const integrations = Array.isArray(snapshot.integrations) ? snapshot.integrations : [];
  const out = {} as Record<SourceId, SourceView>;
  for (const id of SOURCES) {
    const stamps = COLLECTIONS[id].flatMap((c) => (snapshot[c] as { updatedAt?: string }[]).map((e) => e.updatedAt));
    const view = sourceFreshness({
      lastSync: lastSyncOf(id, integrations),
      newestChange: newest(stamps),
      integrationForbidden: forbidden,
      now,
    });
    out[id] = { id, ...view };
  }
  return out;
}
