/**
 * RT-1578 (RT-1511 S3, spec 013) — the availability cache service.
 *
 * Fills the local cache from `posGetStoreAvailability`, tells the renderer how fresh it is and what each
 * product shows. It is display-only: nothing here reads a cart, blocks a sale, or calls anything but the
 * GET snapshot (FR-5, FR-6). Rules it enforces:
 *
 *   • a refresh pages with `nextCursor` until it is null, even after an empty page, and keeps the OLDEST
 *     page `asOf` as the cache freshness;
 *   • any failed page fails the whole refresh and leaves the cache as it was (one transaction at the end);
 *   • the cache is scoped to the pairing (`tenant|branch|paired_at`): a store change or a re-pair purges it
 *     (FR-7), checked on every read and again just before a write, so a worker started under an older
 *     pairing can never write into the new one;
 *   • the band is the server's; it is never recomputed from the number;
 *   • concurrent refreshes share one run.
 */

import type {
  AvailabilityFreshness,
  AvailabilityRefreshOutcome,
  AvailabilityRowState,
} from '../../shared/availability/types.js';
import type { AvailabilityClient, WireAvailabilityItem, WireBand } from './availability-client.js';
import type { AvailabilityConfig } from './availability-config.js';
import type { AvailabilityRepo } from './availability-repo.js';

/** The pairing the cache is read under (from the pairing store, never from the renderer). */
export interface AvailabilityScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly pairedAt: number;
}

/** A server that never ends its cursor chain fails closed instead of looping forever. */
const MAX_PAGES = 10_000;

export interface AvailabilityServiceDeps {
  readonly client: AvailabilityClient;
  readonly repo: AvailabilityRepo;
  readonly config: AvailabilityConfig;
  /** The current pairing, or null when unpaired. */
  readonly readScope: () => Promise<AvailabilityScope | null>;
  readonly now: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface AvailabilityService {
  refresh(): Promise<AvailabilityRefreshOutcome>;
  freshness(): Promise<AvailabilityFreshness>;
  states(productIds: readonly string[]): Promise<{
    readonly freshness: AvailabilityFreshness;
    readonly states: Readonly<Record<string, AvailabilityRowState>>;
  }>;
  /** Starts the interval and the first refresh; returns the stop function. */
  start(): () => void;
}

const NEVER: AvailabilityFreshness = { state: 'never', as_of: null };

function scopeKeyOf(scope: AvailabilityScope): string {
  return `${scope.tenantId}|${scope.branchId}|${String(scope.pairedAt)}`;
}

/** The older of two ISO instants (an unparseable one counts as oldest, so it reads as stale). */
function older(a: string, b: string): string {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isNaN(ta) || ta <= tb ? a : b;
}

export function createAvailabilityService(deps: AvailabilityServiceDeps): AvailabilityService {
  const { client, repo, config } = deps;
  let inFlight: Promise<AvailabilityRefreshOutcome> | null = null;

  /** The freshness under `scope`; a cache stored under another scope is purged and reads as never. */
  function freshnessUnder(scope: AvailabilityScope | null): AvailabilityFreshness {
    const stored = repo.readState();
    if (stored === null) return NEVER;
    if (scope === null || stored.scope_key !== scopeKeyOf(scope)) {
      repo.purge();
      return NEVER;
    }
    const age = deps.now().getTime() - Date.parse(stored.oldest_as_of);
    const stale = Number.isNaN(age) || age > config.staleAfterMs;
    return { state: stale ? 'stale' : 'fresh', as_of: stored.oldest_as_of };
  }

  async function pullAll(
    scope: AvailabilityScope,
  ): Promise<
    | { readonly ok: true; readonly items: WireAvailabilityItem[]; readonly oldestAsOf: string }
    | { readonly ok: false; readonly outcome: AvailabilityRefreshOutcome }
  > {
    const items = new Map<string, WireAvailabilityItem>();
    let oldestAsOf: string | null = null;
    let cursor: string | null = null;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const result = await client.fetchPage(scope.branchId, cursor);
      if (result.kind !== 'ok') return { ok: false, outcome: result.kind };
      const { page } = result;
      // A page computed for another store is never merged (the device row decides the store).
      if (page.storeId !== scope.branchId) return { ok: false, outcome: 'failed' };
      for (const item of page.items) items.set(item.productId, item);
      oldestAsOf = oldestAsOf === null ? page.asOf : older(oldestAsOf, page.asOf);
      if (page.nextCursor === null) {
        return { ok: true, items: [...items.values()], oldestAsOf: oldestAsOf };
      }
      cursor = page.nextCursor;
    }
    return { ok: false, outcome: 'failed' };
  }

  async function runRefresh(): Promise<AvailabilityRefreshOutcome> {
    const scope = await deps.readScope();
    if (scope === null) {
      repo.purge();
      return 'unpaired';
    }
    freshnessUnder(scope); // drops a cache that belongs to another pairing
    const pulled = await pullAll(scope);
    if (!pulled.ok) return pulled.outcome;
    // The pairing may have changed while the pages were read: write only into the pairing they were read for.
    const current = await deps.readScope();
    if (current === null || scopeKeyOf(current) !== scopeKeyOf(scope)) return 'failed';
    repo.replaceAll({
      scopeKey: scopeKeyOf(scope),
      oldestAsOf: pulled.oldestAsOf,
      refreshedAt: deps.now().toISOString(),
      items: pulled.items,
    });
    return 'refreshed';
  }

  function refresh(): Promise<AvailabilityRefreshOutcome> {
    inFlight ??= runRefresh()
      .catch((error: unknown): AvailabilityRefreshOutcome => {
        deps.onError?.(error);
        return 'failed';
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function freshness(): Promise<AvailabilityFreshness> {
    return freshnessUnder(await deps.readScope());
  }

  return {
    refresh,
    freshness,
    async states(productIds) {
      const fresh = await freshness();
      const bands =
        fresh.state === 'fresh' ? repo.readBands(productIds) : new Map<string, WireBand>();
      const unseen: AvailabilityRowState = fresh.state === 'stale' ? 'uncertain' : 'unknown';
      const states: Record<string, AvailabilityRowState> = {};
      for (const id of productIds) states[id] = bands.get(id) ?? unseen;
      return { freshness: fresh, states };
    },
    start() {
      void refresh();
      const timer = setInterval(() => {
        void refresh();
      }, config.refreshIntervalMs);
      timer.unref();
      return () => {
        clearInterval(timer);
      };
    },
  };
}
