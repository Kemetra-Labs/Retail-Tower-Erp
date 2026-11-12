import path from 'node:path';
import type { DatabaseHandle } from '../db/client.js';
import { createOfferPackClient } from '../offers/offer-pack-client.js';
import { createOfferPackFileStore } from '../offers/offer-pack-file-store.js';
import { createOfferPackWorker, OFFER_PACK_TICK_INTERVAL_MS } from '../offers/offer-pack-worker.js';
import {
  bindOfferPackStore,
  bindOfferRevocationCheck,
  offerMonotonicMs,
  offerPackService,
} from '../offers/offer-runtime.js';
import type { DeviceRevocationStore } from '../pairing/store.js';
import type { BrandingDeps } from './branding.js';
import { resolveApiBaseUrl } from './env.js';

/** What `registerOffers` closes over: the branding read-down's deps, which it shares (RT-893). */
type OffersDeps = Pick<
  BrandingDeps,
  | 'db'
  | 'pairedWorkersLatch'
  | 'workerRegistry'
  | 'mainLogger'
  | 'backendFetch'
  | 'readSendableDeviceToken'
> & {
  /** The pairing store's synchronous revocation flag (RT-215 review F3). */
  readonly pairingStore: Pick<DeviceRevocationStore, 'isDeviceRevoked'>;
};

/** The folder of the till database (the Pack file sits beside it), or null when it cannot be told. */
function dataFolderOf(db: DatabaseHandle): string | null {
  try {
    const rows = db.pragma('database_list') as ReadonlyArray<{ name?: unknown; file?: unknown }>;
    const main = rows.find((r) => r.name === 'main');
    return typeof main?.file === 'string' && main.file !== '' ? path.dirname(main.file) : null;
  } catch {
    return null;
  }
}

/**
 * RT-1339 — the store's Offer Pack read-down (spec 048 §7): the paired-only worker
 * that fills the process's one Pack holder (`offers/offer-runtime.ts`), which the
 * cart reads. Called from `registerCatalogue` with the same deps, because the Pack
 * is the store's offers catalogue and `index.ts` may not grow (RT-893).
 *
 * Default-inert: a server without `posGetOfferPack` answers 404, the worker reads
 * "unavailable", no Pack is held, and no offer applies.
 */
export function registerOffers(deps: OffersDeps): void {
  const folder = dataFolderOf(deps.db);
  if (folder !== null) bindOfferPackStore(createOfferPackFileStore(path.join(folder, 'offers')));
  // A revoked till applies no offer from the moment the revocation is confirmed.
  bindOfferRevocationCheck(() => deps.pairingStore.isDeviceRevoked());
  const baseUrl = resolveApiBaseUrl();
  deps.pairedWorkersLatch.register('offer pack read-down', (terminal) => {
    const worker = createOfferPackWorker({
      client: createOfferPackClient({ baseUrl, fetch: deps.backendFetch }),
      service: offerPackService(),
      readDeviceToken: deps.readSendableDeviceToken,
      tenantId: terminal.tenant_id,
      monotonicMs: offerMonotonicMs,
      tickIntervalMs: OFFER_PACK_TICK_INTERVAL_MS,
      logger: deps.mainLogger,
    });
    worker.start();
    deps.workerRegistry.register('offer pack read-down', () => {
      worker.stop();
    });
    deps.mainLogger.info({ tenant_id: terminal.tenant_id }, 'offer_pack_read_down:started');
  });
}
