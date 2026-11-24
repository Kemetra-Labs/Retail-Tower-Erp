import type { PairingStatus } from '../../shared/pairing-types.js';
import { createAvailabilityClient } from '../availability/availability-client.js';
import { resolveAvailabilityConfig } from '../availability/availability-config.js';
import { createAvailabilityRepo } from '../availability/availability-repo.js';
import {
  createAvailabilityService,
  type AvailabilityScope,
} from '../availability/availability-service.js';
import { registerAvailabilityHandlers } from '../ipc/availability.js';
import type { CatalogueDeps } from './catalogue.js';
import { resolveApiBaseUrl } from './env.js';

/** The pairing as the availability cache scopes by it; null unless paired. */
export function scopeOfPairing(status: PairingStatus): AvailabilityScope | null {
  if (status.kind !== 'paired') return null;
  return { tenantId: status.tenant_id, branchId: status.branch_id, pairedAt: status.paired_at };
}

/**
 * RT-1578 (RT-1511 S3, spec 013) — the store-availability cache: the `availability:*` bridge (answered from
 * the local cache) and the paired-only refresh worker (an immediate pull, then every 15 minutes by default).
 * Called from `registerCatalogue` with the same deps, like the offers (RT-893: `index.ts` may not grow).
 *
 * Deliberately NOT observed by the RT-215 device-revocation detector: registering a route there means
 * editing `src/main/pairing/`, and the branding worker sets the same precedent. A 401 here only fails the
 * refresh; the catalogue read-down still counts toward a confirmed revocation.
 */
export function registerAvailability(deps: CatalogueDeps): void {
  const { db, pairingStore, operatorSessionManager, mainLogger } = deps;
  const service = createAvailabilityService({
    client: createAvailabilityClient({
      baseUrl: resolveApiBaseUrl(),
      fetch: deps.backendFetch,
      readToken: deps.readSendableDeviceToken,
    }),
    repo: createAvailabilityRepo(db),
    config: resolveAvailabilityConfig(process.env),
    readScope: async () => scopeOfPairing(await pairingStore.getStatus()),
    now: () => new Date(),
    onError: (error) => {
      mainLogger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'availability:refresh_failed',
      );
    },
  });
  registerAvailabilityHandlers(deps.guardedIpcMain, {
    service,
    hasSession: () => operatorSessionManager.getCurrent() !== null,
  });
  deps.pairedWorkersLatch.register('availability refresh', () => {
    deps.workerRegistry.register('availability refresh', service.start());
    mainLogger.info('availability:started');
  });
}
