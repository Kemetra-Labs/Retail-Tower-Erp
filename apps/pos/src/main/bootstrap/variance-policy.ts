import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { PairedWorkers } from '../app/paired-workers.js';
import { createPolicyCache } from '../cash-variance-policy/policy-cache.js';
import { createPolicyClient } from '../cash-variance-policy/policy-client.js';
import {
  createPolicyService,
  type PolicyRefreshResult,
  type PolicyService,
} from '../cash-variance-policy/policy-service.js';
import type { DatabaseHandle } from '../db/client.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { PairingStore } from '../pairing/store.js';

/**
 * The longest an open waits for the policy read. The read is best effort: the open
 * freezes the cached policy (or the fail-closed fallback) when it is slower or fails.
 */
const POLICY_BEFORE_OPEN_WAIT_MS = 2_500;

interface VariancePolicyLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

/** What `registerVariancePolicy` closes over from the composition (the shift deps). */
export interface VariancePolicyDeps {
  /** The open database handle the policy cache lives in (migration 0067). */
  db: DatabaseHandle;
  /** The pairing store: the tenant and branch of every read and cache lookup. */
  pairingStore: Pick<PairingStore, 'getStatus'>;
  pairedWorkersLatch: Pick<PairedWorkers, 'register'>;
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  /** Each new operator session (any role, online or not) triggers a read. */
  operatorSessionManager: Pick<SessionManager, 'onStarted'>;
  mainLogger: VariancePolicyLogger;
  /** The shared Backend-Core fetch (request id, build identity, status observer). */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The one reader of the device token for sending (null unless paired, not revoked). */
  readSendableDeviceToken: () => Promise<string | null>;
  apiBaseUrl: string;
  now: () => string;
  /** The bound of `refreshBeforeOpen`; tests shorten it. */
  beforeOpenWaitMs?: number;
}

export interface VariancePolicyWiring {
  /** What an open freezes: the cached policy, else the fail-closed fallback. */
  resolvePolicy: PolicyService['resolve'];
  /** A bounded read the open path awaits; never rejects. */
  refreshBeforeOpen: () => Promise<void>;
}

/**
 * RT-388 — the shift variance policy wiring (AD-CASH-001 D-5): the device read, its cache
 * and the triggers. A read happens when the paired worker starts (after pairing and at
 * every boot), at each new operator session (the first online sign-in after the upgrade
 * included) and before an open. There is no timer: a change applies from the next open,
 * which reads first. A failed read keeps the cached policy; the cache has no maximum age.
 * The worker's fetch is deliberately not observed by the RT-215 device-revocation detector.
 */
export function registerVariancePolicy(deps: VariancePolicyDeps): VariancePolicyWiring {
  const { mainLogger } = deps;
  const service = createPolicyService({
    client: createPolicyClient({ baseUrl: deps.apiBaseUrl, fetch: deps.backendFetch }),
    cache: createPolicyCache(deps.db),
    readDeviceToken: deps.readSendableDeviceToken,
    getScope: async () => {
      const status = await deps.pairingStore.getStatus();
      return status.kind === 'paired'
        ? { tenantId: status.tenant_id, branchId: status.branch_id }
        : null;
    },
    now: deps.now,
  });

  /** One read, its closed-set result logged (no ids, no values). */
  async function refresh(): Promise<PolicyRefreshResult> {
    const result = await service.refresh();
    if (result === 'failed') mainLogger.warn({ result }, 'variance_policy:refresh');
    else mainLogger.info({ result }, 'variance_policy:refresh');
    return result;
  }

  deps.pairedWorkersLatch.register('variance policy read', () => {
    void refresh();
    deps.workerRegistry.register('variance policy read', () => {
      service.stop();
    });
  });
  deps.operatorSessionManager.onStarted(() => {
    void refresh();
  });

  return {
    resolvePolicy: (input) => service.resolve(input),
    refreshBeforeOpen: async () => {
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deps.beforeOpenWaitMs ?? POLICY_BEFORE_OPEN_WAIT_MS);
      });
      try {
        await Promise.race([refresh().then(() => undefined), bound]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
