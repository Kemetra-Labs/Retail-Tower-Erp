import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import { BRANDING_IPC_CHANNELS } from '../../shared/branding/types.js';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { PairedWorkers } from '../app/paired-workers.js';
import { createBrandingCache } from '../branding/branding-cache.js';
import { createBrandingClient } from '../branding/branding-client.js';
import { createBrandingService, type BrandingPairing } from '../branding/branding-service.js';
import { createBrandingWorker } from '../branding/branding-worker.js';
import type { DatabaseHandle } from '../db/client.js';
import { pushBrandingSnapshot, registerBrandingHandlers } from '../ipc/branding.js';
import { resolveApiBaseUrl } from './env.js';
import { broadcastToWindows } from './window.js';

/** Hourly, like the catalogue read-down (spec 039 FR-30). */
export const BRANDING_TICK_INTERVAL_MS = 60 * 60 * 1_000;

/** What `registerBranding` closes over from the composition root (the catalogue deps). */
export interface BrandingDeps {
  guardedIpcMain: IpcMain;
  db: DatabaseHandle;
  /** The pairing store: the scope of every read, at call time (never the renderer). */
  pairingStore: BrandingPairing;
  pairedWorkersLatch: Pick<PairedWorkers, 'register'>;
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  mainLogger: Logger;
  /** The shared Backend-Core fetch (request id, build identity, status observer). */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The one reader of the device token for sending (null unless paired, not revoked). */
  readSendableDeviceToken: () => Promise<string | null>;
}

/**
 * RT-475 — the tenant branding: the `branding:get` bridge (answered from the
 * local cache, paired or not, signed in or not) and the paired-only read-down
 * worker that fills the cache. Called right after `registerCatalogue`, with the
 * same deps. The worker's fetch is deliberately not observed by the RT-215
 * device-revocation detector (decision 2 lists the routes that count).
 */
export function registerBranding(deps: BrandingDeps): void {
  const { guardedIpcMain, db, pairingStore, mainLogger } = deps;
  const cache = createBrandingCache(db);
  const service = createBrandingService({
    cache,
    pairing: pairingStore,
    onError: (err) => {
      mainLogger.warn(
        { error: err instanceof Error ? err.name : 'unknown' },
        'branding:snapshot_failed',
      );
    },
  });
  registerBrandingHandlers(guardedIpcMain, { snapshot: () => service.snapshot() });

  const baseUrl = resolveApiBaseUrl();
  deps.pairedWorkersLatch.register('branding read-down', (terminal) => {
    const worker = createBrandingWorker({
      client: createBrandingClient({ baseUrl, fetch: deps.backendFetch }),
      cache,
      pairing: pairingStore,
      readDeviceToken: deps.readSendableDeviceToken,
      tenantId: terminal.tenant_id,
      now: () => new Date().toISOString(),
      onChanged: () => {
        void pushBrandingSnapshot({
          snapshot: () => service.snapshot(),
          send: (snapshot) => {
            broadcastToWindows(BRANDING_IPC_CHANNELS.CHANGED, snapshot);
          },
        });
      },
      tickIntervalMs: BRANDING_TICK_INTERVAL_MS,
      logger: mainLogger,
    });
    worker.start();
    deps.workerRegistry.register('branding read-down', () => {
      worker.stop();
    });
    mainLogger.info({ tenant_id: terminal.tenant_id }, 'branding_read_down:started');
  });
}
