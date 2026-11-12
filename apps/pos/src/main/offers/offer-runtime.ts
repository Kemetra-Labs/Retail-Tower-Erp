/**
 * RT-1339 (RT-286 S7) — the process's one Offer Pack holder.
 *
 * The cart handlers (`registerCart`) read the Pack through `planCartPromotions`,
 * and the paired-only worker (`registerOffers`) fills it. They are wired at
 * different points of boot and share no deps object, so both reach the one
 * service here. The store is bound when the worker is registered (it needs the
 * data folder); until then the service holds nothing and every cart plans no
 * offer.
 *
 * Default-inert: with no Pack read, the plan is empty and a sale is exactly
 * what it was before offers existed.
 */
import {
  createOfferPackService,
  type OfferPackService,
  type OfferPackStore,
} from './offer-pack-service.js';
import { NO_OFFER_PACK_STORE } from './offer-pack-file-store.js';
import { planPromotions } from './promotion-plan.js';
import { DEFAULT_CURRENCY_CODE } from '../sales-sync/create-sale-sync-client.js';
import { NO_PROMOTIONS, type PlanLine, type PromotionPreview } from '../../shared/offers/types.js';

let boundStore: OfferPackStore = NO_OFFER_PACK_STORE;

/** The monotonic clock of the process: never the wall clock, never adjusted by the OS. */
const monotonicMs = (): number => performance.now();

const service: OfferPackService = createOfferPackService({
  monotonicMs,
  store: {
    load: () => boundStore.load(),
    save: (entry) => {
      boundStore.save(entry);
    },
    clear: () => {
      boundStore.clear();
    },
  },
});

export function offerPackService(): OfferPackService {
  return service;
}

export function offerMonotonicMs(): number {
  return monotonicMs();
}

export function bindOfferPackStore(store: OfferPackStore): void {
  boundStore = store;
}

/** The offers that apply to a cart's live lines now, or none. Never throws: an evaluation fault is "no offer". */
export function planCartPromotions(lines: readonly PlanLine[]): PromotionPreview {
  try {
    return planPromotions(lines, service.view(), DEFAULT_CURRENCY_CODE);
  } catch {
    return NO_PROMOTIONS;
  }
}
