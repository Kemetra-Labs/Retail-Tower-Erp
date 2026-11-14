import type { SourceView } from "./types";

/** A source whose newest change or completed sync is older than this is stale. */
export const STALE_AFTER_HOURS = 6;

export type FreshnessInput = {
  /** `resyncState.lastResyncEnd` of the source's integration, or null when not read. */
  lastSync: string | null;
  /** Newest `updatedAt` among the source's entities, or null when there are none. */
  newestChange: string | null;
  /** `GET /v1/integration` answered 403 (or otherwise could not be read). */
  integrationForbidden: boolean;
  now: Date;
};

function parse(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Freshness of one source (spec section 7b). Fresh when the newer of its last
 * completed sync and its newest change is at most 6 hours old, stale beyond
 * that, unknown when neither is known. A forbidden integration read drops the
 * sync time and falls back to the newest change alone. Unknown is never fresh.
 */
export function sourceFreshness(args: FreshnessInput): Omit<SourceView, "id"> {
  const lastSync = args.integrationForbidden ? null : args.lastSync;
  const syncMs = parse(lastSync);
  const changeMs = parse(args.newestChange);
  const known = [syncMs, changeMs].filter((v): v is number => v !== null);
  const lastChange = changeMs === null ? null : args.newestChange;
  const keptSync = syncMs === null ? null : lastSync;
  if (known.length === 0) return { state: "unknown", lastChange, lastSync: keptSync };
  const ageMs = args.now.getTime() - Math.max(...known);
  const state = ageMs <= STALE_AFTER_HOURS * 3_600_000 ? "fresh" : "stale";
  return { state, lastChange, lastSync: keptSync };
}
