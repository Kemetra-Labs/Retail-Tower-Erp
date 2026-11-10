import { createHeartbeatClient } from '../device-health/heartbeat-client.js';
import {
  createSaleQueueReader,
  readSchemaHead,
  updaterFacts,
} from '../device-health/heartbeat-facts.js';
import { createHeartbeatScheduler } from '../device-health/heartbeat-scheduler.js';
import { RELEASE_APP_VERSION } from '../observability/build-identity.js';
import type { PairingStore } from '../pairing/store.js';
import { SALE_DISCOUNT_CAPTURE_SUPPORTED } from '../sales-sync/discount-hold.js';
import { createSaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import { resolveUpdateConfig } from '../update/update-config.js';
import type { UpdateService } from '../update/update-service.js';
import type { BrandingDeps } from './branding.js';
import { resolveApiBaseUrl } from './env.js';

/**
 * What `registerDeviceHeartbeat` closes over from the composition root: the read-down deps the
 * branding worker takes (the database for the sale-sync state and the applied migrations, the
 * latch, the worker registry, the shared fetch, the sendable device token), plus the updater.
 */
export interface DeviceHeartbeatDeps extends Pick<
  BrandingDeps,
  | 'db'
  | 'pairedWorkersLatch'
  | 'workerRegistry'
  | 'mainLogger'
  | 'backendFetch'
  | 'readSendableDeviceToken'
> {
  /** The live terminal id the sale-queue counts are scoped to (RT-221). */
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  /** The updater: its state at beat time, and a beat on every state change. */
  updateService: Pick<UpdateService, 'getStatus' | 'onStatusChange'>;
  /** The launch environment (the update channel); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * RT-1312 Phase 1 (owner decision P1-D1) — the device heartbeat
 * (`posReportDeviceHeartbeat`), so the till's stranded-sale counts reach the
 * Console. A paired-only worker: it starts when the terminal is paired (at boot,
 * or right after an in-app pairing), beats at once, every 15 minutes, soon after
 * the sale-queue counts change and on every update state change, at most once per
 * 61 s (see `device-health/heartbeat-scheduler.ts`). It sends nothing without a
 * sendable device token (unpaired or revoked), stops with the other workers on
 * quit, and never touches a sale, the sync, a shift or a sign-in. The D-6
 * below-minimum banner and shift block are out of scope (RT-328).
 */
export function registerDeviceHeartbeat(deps: DeviceHeartbeatDeps): void {
  const { db, pairingStore, mainLogger, updateService } = deps;
  const updateChannel = resolveUpdateConfig(deps.env ?? process.env).channel;

  deps.pairedWorkersLatch.register('device heartbeat', (terminal) => {
    // Read once: migrations only run at start, before any worker.
    const schemaHead = readSchemaHead(db);
    const scheduler = createHeartbeatScheduler({
      readToken: deps.readSendableDeviceToken,
      readFacts: () => ({
        appVersion: RELEASE_APP_VERSION,
        updateChannel,
        ...updaterFacts(updateService.getStatus()),
        schemaHead,
        sourceClockAt: new Date(),
      }),
      readSaleQueue: createSaleQueueReader({
        stateRepo: createSaleSyncStateRepo(db),
        tenantId: terminal.tenant_id,
        branchId: terminal.branch_id,
        currentTerminalId: () => pairingStore.getCurrentTerminalId(),
        discountCaptureSupported: SALE_DISCOUNT_CAPTURE_SUPPORTED,
      }),
      client: createHeartbeatClient({ baseUrl: resolveApiBaseUrl(), fetch: deps.backendFetch }),
      logger: mainLogger,
    });
    scheduler.start();
    const unsubscribe = updateService.onStatusChange(() => {
      scheduler.requestBeat();
    });
    deps.workerRegistry.register('device heartbeat', () => {
      unsubscribe();
      scheduler.stop();
    });
    mainLogger.info('device_heartbeat:started');
  });
}
