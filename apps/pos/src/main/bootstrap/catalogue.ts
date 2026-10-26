import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
// 010 read-down — catalogue bridge + freshness + driver wiring (#349 cleared:
// DP-2 backend contract deployed; T021 client + T039 driver now wired).
import { createCatalogueBridge } from '../catalogue/catalogue-bridge.js';
import { createCatalogueSyncStateRepo } from '../catalogue/catalogue-sync-state-repo.js';
import { createProductRepo } from '../catalogue/product-repo.js';
import { createReadDownClient } from '../catalogue/read-down/read-down-client.js';
import { createReadDownDriver } from '../catalogue/read-down/read-down-driver.js';
import { createReadDownWriter } from '../catalogue/read-down/read-down-writer.js';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { PairedWorkers } from '../app/paired-workers.js';
import type { DatabaseHandle } from '../db/client.js';
import { registerCatalogueHandlers } from '../ipc/catalogue.js';
import type { SessionManager } from '../operator/session-manager.js';
import { withDeviceAuthObservation } from '../pairing/device-auth-detector.js';
import type { DeviceAuthDetector } from '../pairing/device-auth-detector.js';
import type { PairingStore } from '../pairing/store.js';
import type { PairingStatus } from '../../shared/pairing-types.js';
import { resolveApiBaseUrl } from './env.js';

/** What `registerCatalogue` closes over from the composition root (RT-893 extraction 3). */
export interface CatalogueDeps {
  /** The guarded `ipcMain` the `catalogue.*` handlers are registered on. */
  guardedIpcMain: IpcMain;
  /** The open database handle the product repo, sync-state repo and read-down writer use. */
  db: DatabaseHandle;
  /** The pairing store: read once for the boot pairing state (device scope, not the operator). */
  pairingStore: Pick<PairingStore, 'getStatus'>;
  /** The once-latch for paired-only workers: notified at boot, and holds the read-down starter. */
  pairedWorkersLatch: PairedWorkers;
  /** The operator session holder the catalogue bridge's session gate reads. */
  operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  /** Owns the stop callback for the read-down driver, drained before the DB handle closes. */
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  mainLogger: Logger;
  /** The reachability-observed Backend-Core fetch the read-down client is built on. */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** RT-215: counts a read-down 401 toward a confirmed device revocation. */
  deviceAuthDetector: Pick<DeviceAuthDetector, 'observe'>;
  /** The one reader of the device token for sending (null unless paired and not revoked). */
  readSendableDeviceToken: () => Promise<string | null>;
}

/** What the rest of the boot sequence needs from the catalogue wiring. */
export interface CatalogueWiring {
  /** The pairing state read at boot; the finalize listener's skipped-unpaired log reads it too. */
  bootPairing: PairingStatus;
}

/**
 * Registers the `catalogue.*` IPC surface, notifies the paired-workers latch of an already-paired
 * boot, and registers the read-down driver's paired-only starter. It is called at the exact boot
 * position the inline code held in `main/index.ts`: after the cart handlers and before the
 * payments wiring. The boot-pairing notification stays between the repos and the bridge as
 * before, so every paired-only starter registered after this call still runs at its own site.
 */
export async function registerCatalogue(deps: CatalogueDeps): Promise<CatalogueWiring> {
  const {
    guardedIpcMain,
    db,
    pairingStore,
    pairedWorkersLatch,
    operatorSessionManager,
    workerRegistry,
    mainLogger,
    backendFetch,
    deviceAuthDetector,
    readSendableDeviceToken,
  } = deps;

  // 009 + 010 — wire the `catalogue.*` IPC surface. Registered unconditionally
  // (same as cart): the handlers are session-gated and refuse with no session,
  // and an unmounted renderer (productSearch flag off) never invokes them, so
  // there is nothing to gate. 009 shipped the bridge factory + preload but
  // never registered the channels with ipcMain, so the whole surface was inert
  // until now; this makes 009's read handlers + 010's `freshness` reachable.
  // 010 T021/T039 (#349 cleared) — the live read-down HTTP client + driver are
  // now wired when the terminal is paired. The driver carries the device-principal
  // scope (tenant/branch) from `pairingStore` (Constitution VIII — NOT the operator
  // session), authenticates with the device token (`Authorization: Bearer`), and
  // runs a background snapshot pull on an interval. When paired, `refresh` admits
  // a real tick; when unpaired, the driver is omitted and `refresh` still refuses
  // (never a fake "started"). The freshness reads below are independent of all this.
  const catalogueRepo = createProductRepo(db);
  const catalogueSyncStateRepo = createCatalogueSyncStateRepo(db);

  const catalogueApiBaseUrl = resolveApiBaseUrl();
  // Pairing state at boot. A terminal already paired notifies the latch NOW, so
  // every paired-only starter registered below runs immediately in its original
  // position (RT-202: unchanged paired-boot behaviour). An unpaired terminal
  // leaves them held until the in-process pairing completes.
  const bootPairing = await pairingStore.getStatus();
  if (bootPairing.kind === 'paired') {
    pairedWorkersLatch.notifyPaired({
      tenant_id: bootPairing.tenant_id,
      branch_id: bootPairing.branch_id,
      terminal_id: bootPairing.terminal_id,
    });
  }
  // Created by the paired-only starter below (boot or in-process pairing); the
  // catalogue bridge resolves it lazily so `refresh` works after in-process
  // pairing and still refuses while there is no driver.
  let readDownDriver: ReturnType<typeof createReadDownDriver> | undefined;

  const catalogueBridge = createCatalogueBridge({
    // Adapt the operator session to the catalogue projection: the gate needs
    // `operator_session_id`, which the record carries as `id`.
    getCurrentSession: () => {
      const sess = operatorSessionManager.getCurrent();
      if (sess === null) return null;
      return {
        role: sess.role,
        operator_id: sess.operator_id,
        operator_session_id: sess.id,
        tenant_id: sess.tenant_id,
        branch_id: sess.branch_id,
      };
    },
    productRepo: catalogueRepo,
    // 010 freshness source: the per-tenant sync-state row + a tenant-scoped
    // live-product count (is_empty). Both reads are tenant-scoped (P17) and
    // secret-free. NOT #349-blocked — neither touches the HTTP client.
    freshness: {
      readSyncState: (tenantId) => catalogueSyncStateRepo.read(tenantId),
      countProducts: (tenantId) => catalogueRepo.countByTenant(tenantId),
      // 010 diagnostics — tenant-scoped barcode-alias count for catalogue:counts.
      countBarcodes: (tenantId) => catalogueRepo.countBarcodesByTenant(tenantId),
    },
    // 010 T039 — the live read-down driver (paired terminals only), resolved at
    // call time (RT-202): `undefined` while unpaired, so `refresh` still refuses
    // cleanly. The bridge only ever calls `runTickOnce` (admit); start/stop are
    // owned here at the root.
    getReadDownDriver: () => readDownDriver,
  });
  registerCatalogueHandlers(guardedIpcMain, { bridge: catalogueBridge });

  // Start the background snapshot pull (paired terminals only). `start()` also
  // admits one immediate initial tick (RT-41) so a freshly paired/restarted
  // terminal does not wait a full interval for its catalogue. The driver's
  // setInterval is stopped on quit via `closeDbHandle()` so it never outlives
  // the process or runs against a closed DB handle.
  pairedWorkersLatch.register('read-down driver', (terminal) => {
    const readDownClient = createReadDownClient({
      baseUrl: catalogueApiBaseUrl,
      // RT-215: observed by the device-401 detector (a read-down 401 counts).
      fetch: withDeviceAuthObservation(backendFetch, deviceAuthDetector, {
        source: 'read_down',
        baseUrl: catalogueApiBaseUrl,
      }),
      // Device token (the paired-terminal credential) read in-process; never
      // logged, never bridged. Sole credential for the non-session-gated driver.
      // RT-215: null once the device is revoked, so it is never sent again.
      getDeviceToken: readSendableDeviceToken,
    });
    const driver = createReadDownDriver({
      client: readDownClient,
      writer: createReadDownWriter({ db: db, syncStateRepo: catalogueSyncStateRepo }),
      tenantId: terminal.tenant_id,
      branchId: terminal.branch_id,
      now: () => new Date().toISOString(),
      // Background pull cadence: hourly. Bounded [1s, 24h] by the driver.
      tickIntervalMs: 60 * 60 * 1_000,
    });
    readDownDriver = driver;
    driver.start();
    workerRegistry.register('read-down driver', () => {
      driver.stop();
    });
    mainLogger.info({ tenant_id: terminal.tenant_id }, 'read_down_driver:started');
  });
  if (bootPairing.kind !== 'paired') {
    // Boot-time fact only: the starter above runs when the pairing completes.
    mainLogger.info('read_down_driver:skipped_unpaired');
  }

  return { bootPairing };
}
