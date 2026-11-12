/**
 * RT-1339 — a contract-shaped Offer Pack body and a clocked service for the offers tests.
 * Product ids are fixed UUIDs so a test names them (`P1`…`P4`).
 */
import {
  createOfferPackService,
  type OfferPackService,
  type OfferPackStore,
  type StoredOfferPack,
} from '../offer-pack-service.js';

export const P1 = '0b000000-0000-7000-8000-000000000001';
export const P2 = '0b000000-0000-7000-8000-000000000002';
export const P3 = '0b000000-0000-7000-8000-000000000003';
export const P4 = '0b000000-0000-7000-8000-000000000004';
export const OFFER_ID = '0a000000-0000-7000-8000-000000000001';
export const TENANT = 'tenant-1';

/** 2026-11-12T10:00:00.000Z, the server time of the fixture read. */
export const ISSUED_AT = '2026-11-12T10:00:00.000Z';
export const ISSUED_MS = Date.parse(ISSUED_AT);

export interface FixtureOffer {
  offerId?: string;
  offerVersion?: number;
  nameAr?: string;
  buyQuantity?: number;
  getQuantity?: number;
  percentOff?: string;
  maxApplicationsPerSale?: number | null;
  startsAt?: string;
  endsAt?: string | null;
  offlinePolicy?: 'allow_cached' | 'online_only';
  eligibleProductIds?: string[];
}

export function packOffer(over: FixtureOffer = {}): Record<string, unknown> {
  return {
    offerId: over.offerId ?? OFFER_ID,
    offerVersion: over.offerVersion ?? 3,
    nameAr: over.nameAr ?? 'القطعة التانية بخصم 40%',
    nameEn: null,
    type: 'buy_x_get_y_percent',
    parameters: {
      buyQuantity: over.buyQuantity ?? 1,
      getQuantity: over.getQuantity ?? 1,
      percentOff: over.percentOff ?? '40',
      rewardSelection: 'cheapest',
      maxApplicationsPerSale: over.maxApplicationsPerSale ?? null,
      priceBasis: 'resolved_store_price',
    },
    startsAt: over.startsAt ?? '2026-11-01T00:00:00.000Z',
    endsAt: over.endsAt === undefined ? null : over.endsAt,
    offlinePolicy: over.offlinePolicy ?? 'allow_cached',
    eligibleProductIds: over.eligibleProductIds ?? [P1, P2, P3, P4],
  };
}

export function packBody(
  over: {
    offers?: Record<string, unknown>[];
    packRevision?: number;
    issuedAt?: string;
    freshnessWindowHours?: number;
    currencyCode?: string;
  } = {},
): Record<string, unknown> {
  return {
    packRevision: over.packRevision ?? 118,
    issuedAt: over.issuedAt ?? ISSUED_AT,
    freshnessWindowHours: over.freshnessWindowHours ?? 24,
    storeTimezone: 'Africa/Cairo',
    currencyCode: over.currencyCode ?? 'EGP',
    offers: over.offers ?? [packOffer()],
  };
}

export interface MemoryStore extends OfferPackStore {
  saved: StoredOfferPack | null;
}

export function memoryStore(initial: StoredOfferPack | null = null): MemoryStore {
  const store: MemoryStore = {
    saved: initial,
    load: () => store.saved,
    save: (entry) => {
      store.saved = entry;
    },
    clear: () => {
      store.saved = null;
    },
  };
  return store;
}

export interface Clocked {
  service: OfferPackService;
  store: MemoryStore;
  /** Move the monotonic clock (ms). */
  advance: (ms: number) => void;
  mono: () => number;
}

export function clockedService(store: MemoryStore = memoryStore(), wallMs?: () => number): Clocked {
  let mono = 1_000;
  const service = createOfferPackService({
    monotonicMs: () => mono,
    ...(wallMs === undefined ? {} : { wallMs }),
    store,
  });
  return {
    service,
    store,
    advance: (ms) => {
      mono += ms;
    },
    mono: () => mono,
  };
}

/** A service that has just read `body` (200) at the fixture server time. */
export function freshService(body: Record<string, unknown> = packBody()): Clocked {
  const c = clockedService();
  const ok = c.service.applyOk({
    tenantId: TENANT,
    body,
    etag: '"abc"',
    serverTime: ISSUED_AT,
    monoAtStartMs: c.mono(),
  });
  if (!ok) throw new Error('fixture pack was refused');
  return c;
}
