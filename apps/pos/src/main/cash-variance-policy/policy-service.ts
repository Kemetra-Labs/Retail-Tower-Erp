/**
 * RT-388 — the shift variance policy service (AD-CASH-001 D-5, DR-6, DR-7).
 *
 *   • `refresh` — one conditional device read, stored in the local cache. The
 *     caller triggers it when the paired worker starts, at each new operator
 *     session and before an online open. It is single-flight (overlapping calls
 *     share one read), never throws, and a failed, unreachable, unauthorized or
 *     off-contract answer leaves the cached policy untouched: the cache has no
 *     maximum age. An answer that arrives after the pairing changed or after
 *     `stop` is dropped, never written.
 *   • `resolve` — what an open freezes: the cached policy of the pairing, else the
 *     fail-closed fallback (`limit 0`, DR-6). Synchronous and read-only: the open
 *     never waits for the network here.
 *
 * Backend-Core only (the shared client); the device token is read per call and
 * never kept.
 */
import type { PolicyCache, PolicyCacheScope } from './policy-cache.js';
import type { PolicyClient } from './policy-client.js';
import { fallbackPolicy, type VariancePolicy } from './policy-core.js';

export type PolicyRefreshResult = 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface PolicyService {
  refresh(): Promise<PolicyRefreshResult>;
  resolve(input: { scope: PolicyCacheScope; shiftCurrencyCode: string }): VariancePolicy;
  /** Latches the service: no further read, and an answer in flight is dropped. */
  stop(): void;
}

export interface PolicyServiceDeps {
  client: PolicyClient;
  cache: PolicyCache;
  /** The sendable device token; null unless paired and not revoked. */
  readDeviceToken: () => Promise<string | null>;
  /** The current pairing's tenant and branch; null while unpaired. */
  getScope: () => Promise<PolicyCacheScope | null>;
  /** Canonical ISO-8601 UTC instant. */
  now: () => string;
}

function sameScope(a: PolicyCacheScope | null, b: PolicyCacheScope): boolean {
  return a !== null && a.tenantId === b.tenantId && a.branchId === b.branchId;
}

export function createPolicyService(deps: PolicyServiceDeps): PolicyService {
  let stopped = false;
  let inFlight: Promise<PolicyRefreshResult> | null = null;

  /** `stop` may run while a read is in flight, so this is read again after each await. */
  const isStopped = (): boolean => stopped;

  /** The cached ETag, or null when nothing (readable) is cached. */
  function cachedEtag(scope: PolicyCacheScope): string | null {
    return deps.cache.read(scope)?.etag ?? null;
  }

  async function run(): Promise<PolicyRefreshResult> {
    const scope = await deps.getScope();
    const token = scope === null ? null : await deps.readDeviceToken();
    if (scope === null || token === null || isStopped()) return 'skipped';
    const outcome = await deps.client.read(token, cachedEtag(scope));
    const current = await deps.getScope();
    if (isStopped() || !sameScope(current, scope)) return 'skipped';
    if (outcome.kind === 'not_modified') return 'unchanged';
    if (outcome.kind !== 'ok') return 'failed';
    deps.cache.write(scope, {
      policy: outcome.policy.policy,
      etag: outcome.etag,
      serverTime: outcome.policy.serverTime,
      fetchedAt: deps.now(),
    });
    return 'updated';
  }

  return {
    refresh() {
      inFlight ??= run()
        .catch((): PolicyRefreshResult => 'failed')
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    resolve({ scope, shiftCurrencyCode }) {
      try {
        return deps.cache.read(scope)?.policy ?? fallbackPolicy(shiftCurrencyCode);
      } catch {
        return fallbackPolicy(shiftCurrencyCode);
      }
    },

    stop() {
      stopped = true;
    },
  };
}
