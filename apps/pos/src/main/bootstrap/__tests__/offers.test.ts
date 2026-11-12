/**
 * RT-1339 (RT-286 S7) — `registerOffers`: the Pack file sits beside the till database, and
 * the paired-only latch starts (and the worker registry stops) the Offer Pack read-down.
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  worker: { start: vi.fn(), stop: vi.fn(), runTickOnce: vi.fn() },
  client: { marker: 'client' },
  service: { marker: 'service' },
  monotonicMs: vi.fn(() => 0),
  createOfferPackWorker: vi.fn(),
  createOfferPackClient: vi.fn(),
  createOfferPackFileStore: vi.fn((dir: string) => ({ marker: dir })),
  bindOfferPackStore: vi.fn(),
  resolveApiBaseUrl: vi.fn(() => 'https://bc.test'),
}));

vi.mock('../../offers/offer-pack-worker.js', () => ({
  createOfferPackWorker: m.createOfferPackWorker,
  OFFER_PACK_TICK_INTERVAL_MS: 300_000,
}));
vi.mock('../../offers/offer-pack-client.js', () => ({
  createOfferPackClient: m.createOfferPackClient,
}));
vi.mock('../../offers/offer-pack-file-store.js', () => ({
  createOfferPackFileStore: m.createOfferPackFileStore,
}));
vi.mock('../../offers/offer-runtime.js', () => ({
  bindOfferPackStore: m.bindOfferPackStore,
  offerPackService: () => m.service,
  offerMonotonicMs: m.monotonicMs,
}));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: m.resolveApiBaseUrl }));

import { registerOffers } from '../offers.js';

type Starter = (terminal: { tenant_id: string }) => void;

function harness(pragma: () => unknown) {
  const starters = new Map<string, Starter>();
  const stoppers = new Map<string, () => void>();
  const deps = {
    db: { pragma: vi.fn(pragma) },
    pairedWorkersLatch: {
      register: vi.fn((name: string, start: Starter) => starters.set(name, start)),
    },
    workerRegistry: {
      register: vi.fn((name: string, stop: () => void) => stoppers.set(name, stop)),
    },
    mainLogger: { info: vi.fn(), warn: vi.fn() },
    backendFetch: vi.fn(),
    readSendableDeviceToken: vi.fn(() => Promise.resolve(null)),
  };
  registerOffers(deps as unknown as Parameters<typeof registerOffers>[0]);
  return { deps, starters, stoppers };
}

const DB_FILE = path.join(path.sep, 'data', 'till', 'pos.db');

beforeEach(() => {
  vi.clearAllMocks();
  m.createOfferPackWorker.mockReturnValue(m.worker);
  m.createOfferPackClient.mockReturnValue(m.client);
});

describe('registerOffers', () => {
  it('binds the Pack file store in an `offers` folder beside the till database', () => {
    harness(() => [
      { name: 'temp', file: '' },
      { name: 'main', file: DB_FILE },
    ]);
    expect(m.createOfferPackFileStore).toHaveBeenCalledWith(
      path.join(path.dirname(DB_FILE), 'offers'),
    );
    expect(m.bindOfferPackStore).toHaveBeenCalledWith({
      marker: path.join(path.dirname(DB_FILE), 'offers'),
    });
  });

  it.each([
    ['an in-memory database', () => [{ name: 'main', file: '' }]],
    ['no main database', () => [{ name: 'temp', file: DB_FILE }]],
    [
      'a pragma that throws',
      () => {
        throw new Error('closed');
      },
    ],
  ])('binds no file store for %s', (_label, pragma) => {
    harness(pragma);
    expect(m.bindOfferPackStore).not.toHaveBeenCalled();
  });

  it('starts nothing until the till is paired', () => {
    const { starters } = harness(() => []);
    expect([...starters.keys()]).toEqual(['offer pack read-down']);
    expect(m.createOfferPackWorker).not.toHaveBeenCalled();
  });

  it('on pairing, starts the read-down for the tenant and registers its stop', () => {
    const { deps, starters, stoppers } = harness(() => []);
    starters.get('offer pack read-down')?.({ tenant_id: 'tenant-1' });

    expect(m.createOfferPackClient).toHaveBeenCalledWith({
      baseUrl: 'https://bc.test',
      fetch: deps.backendFetch,
    });
    expect(m.createOfferPackWorker).toHaveBeenCalledWith({
      client: m.client,
      service: m.service,
      readDeviceToken: deps.readSendableDeviceToken,
      tenantId: 'tenant-1',
      monotonicMs: m.monotonicMs,
      tickIntervalMs: 300_000,
      logger: deps.mainLogger,
    });
    expect(m.worker.start).toHaveBeenCalledTimes(1);
    expect(deps.mainLogger.info).toHaveBeenCalledWith(
      { tenant_id: 'tenant-1' },
      'offer_pack_read_down:started',
    );

    stoppers.get('offer pack read-down')?.();
    expect(m.worker.stop).toHaveBeenCalledTimes(1);
  });
});
