/**
 * RT-1339 (RT-286 S7) — the process's one Offer Pack holder: inert until a Pack is read,
 * persists through the bound store, and never lets an evaluation fault reach the cart.
 */
import { describe, expect, it, vi } from 'vitest';
import { NO_PROMOTIONS, type PlanLine } from '../../../shared/offers/types.js';

const fault = vi.hoisted(() => ({ on: false }));
vi.mock('../promotion-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../promotion-plan.js')>();
  return {
    planPromotions: (...args: Parameters<typeof actual.planPromotions>) => {
      if (fault.on) throw new Error('evaluation fault');
      return actual.planPromotions(...args);
    },
  };
});

import { NO_OFFER_PACK_STORE } from '../offer-pack-file-store.js';
import {
  bindOfferPackStore,
  bindOfferRevocationCheck,
  offerMonotonicMs,
  offerPackService,
  planCartPromotions,
} from '../offer-runtime.js';
import { ISSUED_AT, P1, P2, TENANT, memoryStore, packBody } from './pack-fixture.js';

const LINES: PlanLine[] = [
  {
    line_id: 'l1',
    item_ref: P1,
    quantity: 1,
    unit_price_minor: 30_000,
    has_manual_discount: false,
  },
  {
    line_id: 'l2',
    item_ref: P2,
    quantity: 1,
    unit_price_minor: 20_000,
    has_manual_discount: false,
  },
];

function applyFixturePack(): boolean {
  return offerPackService().applyOk({
    tenantId: TENANT,
    body: packBody(),
    etag: '"abc"',
    serverTime: ISSUED_AT,
    monoAtStartMs: offerMonotonicMs(),
  });
}

describe('offer runtime', () => {
  it('reads a monotonic clock', () => {
    const a = offerMonotonicMs();
    expect(offerMonotonicMs()).toBeGreaterThanOrEqual(a);
  });

  it('holds nothing before a store is bound: every cart plans no offer', () => {
    offerPackService().restore(TENANT);
    expect(offerPackService().view()).toEqual({ kind: 'none' });
    expect(planCartPromotions(LINES)).toEqual(NO_PROMOTIONS);
    expect(applyFixturePack()).toBe(true);
  });

  it('saves a read Pack through the bound store and plans the cart from it', () => {
    const store = memoryStore();
    bindOfferPackStore(store);
    expect(applyFixturePack()).toBe(true);
    expect(store.saved?.etag).toBe('"abc"');
    expect(planCartPromotions(LINES).promotion_total_minor).toBe(8_000);
  });

  it('a stored Pack of another tenant is cleared on restore', () => {
    const store = memoryStore({ tenantId: 'other-tenant', etag: '"x"', body: packBody() });
    bindOfferPackStore(store);
    offerPackService().restore(TENANT);
    expect(store.saved).toBeNull();
    expect(offerPackService().view()).toEqual({ kind: 'none' });
  });

  it('plans no offer while the device is revoked, at once and without waiting for a worker tick', () => {
    let revoked = false;
    bindOfferRevocationCheck(() => revoked);
    bindOfferPackStore(memoryStore());
    try {
      applyFixturePack();
      expect(planCartPromotions(LINES).promotion_total_minor).toBe(8_000);
      // Revocation confirmed mid-sale: the held Pack (and an answer still in flight) plans nothing.
      revoked = true;
      expect(planCartPromotions(LINES)).toEqual(NO_PROMOTIONS);
      expect(applyFixturePack()).toBe(true);
      expect(planCartPromotions(LINES)).toEqual(NO_PROMOTIONS);
      // "Check again" cleared it: the same pairing continues, and its Pack is still good.
      revoked = false;
      expect(planCartPromotions(LINES).promotion_total_minor).toBe(8_000);
      // A check that throws is treated as revoked: no offer, never a thrown cart.
      bindOfferRevocationCheck(() => {
        throw new Error('store closed');
      });
      expect(planCartPromotions(LINES)).toEqual(NO_PROMOTIONS);
    } finally {
      bindOfferRevocationCheck(() => false);
      bindOfferPackStore(NO_OFFER_PACK_STORE);
    }
  });

  it('an evaluation fault is "no offer", never a thrown cart', () => {
    bindOfferPackStore(memoryStore());
    applyFixturePack();
    fault.on = true;
    try {
      expect(planCartPromotions(LINES)).toEqual(NO_PROMOTIONS);
    } finally {
      fault.on = false;
      bindOfferPackStore(NO_OFFER_PACK_STORE);
    }
  });
});
