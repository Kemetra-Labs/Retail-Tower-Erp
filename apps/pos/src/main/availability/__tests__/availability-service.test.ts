import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { handleFor } from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import {
  cloneMigratedDb,
  initMigratedDbTemplate,
} from '../../db/__tests__/__helpers__/migrated-db.js';
import { createAvailabilityClient, AVAILABILITY_PATH } from '../availability-client.js';
import type { PageOutcome, WireAvailabilityPage } from '../availability-client.js';
import { resolveAvailabilityConfig } from '../availability-config.js';
import { createAvailabilityRepo } from '../availability-repo.js';
import { createAvailabilityService, type AvailabilityScope } from '../availability-service.js';

/**
 * RT-1578 (RT-1511 S3, spec 013) — the availability cache service on a real migrated database
 * (sql.js, every migration) and a scripted page source.
 */

const STORE = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const OTHER_STORE = '0192f5a2-3b4c-7d8e-9f01-0000000000a2';
const P1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';
const P2 = '0192f5a2-3b4c-7d8e-9f01-000000000002';
const P3 = '0192f5a2-3b4c-7d8e-9f01-000000000003';
const T0 = new Date('2026-11-24T10:00:00.000Z');
const CONFIG = resolveAvailabilityConfig({});

const SCOPE: AvailabilityScope = { tenantId: 'tenant-1', branchId: STORE, pairedAt: 1_000 };

let db: SqlJsDatabase;
let now = T0;
let scope: AvailabilityScope | null = SCOPE;
let pages: PageOutcome[] = [];
const requested: Array<{ branchId: string; cursor: string | null }> = [];

function page(over: Partial<WireAvailabilityPage> = {}): PageOutcome {
  return {
    kind: 'ok',
    page: { storeId: STORE, asOf: T0.toISOString(), items: [], nextCursor: null, ...over },
  };
}

function item(productId: string, band: 'in_stock' | 'low' | 'out', ats = '5') {
  return { productId, band, availableToSell: ats };
}

function build() {
  const repo = createAvailabilityRepo(handleFor(db));
  const service = createAvailabilityService({
    client: {
      fetchPage: (branchId, cursor) => {
        requested.push({ branchId, cursor });
        return Promise.resolve(pages.shift() ?? { kind: 'failed' });
      },
    },
    repo,
    config: CONFIG,
    readScope: () => Promise.resolve(scope),
    now: () => now,
  });
  return { repo, service };
}

beforeAll(async () => {
  await initMigratedDbTemplate();
});

beforeEach(() => {
  db = cloneMigratedDb();
  now = T0;
  scope = SCOPE;
  pages = [];
  requested.length = 0;
});

afterEach(() => {
  db.close();
});

describe('refresh — paging and freshness', () => {
  it('pages until nextCursor is null, even after an empty page, and keeps the OLDEST asOf', async () => {
    const { service } = build();
    pages = [
      page({ asOf: '2026-11-24T09:59:50.000Z', items: [item(P1, 'in_stock')], nextCursor: 'c1' }),
      page({ asOf: '2026-11-24T09:59:40.000Z', items: [], nextCursor: 'c2' }),
      page({ asOf: '2026-11-24T09:59:55.000Z', items: [item(P2, 'low')], nextCursor: null }),
    ];
    await expect(service.refresh()).resolves.toBe('refreshed');
    expect(requested.map((r) => r.cursor)).toEqual([null, 'c1', 'c2']);
    expect(requested.every((r) => r.branchId === STORE)).toBe(true);
    await expect(service.freshness()).resolves.toEqual({
      state: 'fresh',
      as_of: '2026-11-24T09:59:40.000Z',
    });
    const { states } = await service.states([P1, P2, P3]);
    expect(states).toEqual({ [P1]: 'in_stock', [P2]: 'low', [P3]: 'unknown' });
  });

  it('keeps the oldest asOf when a later page is older', async () => {
    const { service } = build();
    pages = [
      page({ asOf: '2026-11-24T09:59:50.000Z', nextCursor: 'c1' }),
      page({ asOf: '2026-11-24T09:58:00.000Z', nextCursor: 'c2' }),
      page({ asOf: '2026-11-24T09:59:59.000Z' }),
    ];
    await service.refresh();
    expect((await service.freshness()).as_of).toBe('2026-11-24T09:58:00.000Z');
  });

  it('treats an unparseable page asOf as the oldest, so the cache reads as stale', async () => {
    const { service } = build();
    pages = [
      page({ asOf: 'garbled', nextCursor: 'c1' }),
      page({ asOf: '2026-11-24T09:59:59.000Z' }),
    ];
    await service.refresh();
    expect(await service.freshness()).toEqual({ state: 'stale', as_of: 'garbled' });
  });

  it('a failed page fails the whole refresh and leaves the cache as it was', async () => {
    const { service } = build();
    pages = [page({ items: [item(P1, 'out')] })];
    await service.refresh();
    now = new Date(T0.getTime() + 60_000);
    pages = [page({ items: [item(P1, 'in_stock')], nextCursor: 'c1' }), { kind: 'unreachable' }];
    await expect(service.refresh()).resolves.toBe('unreachable');
    const { states, freshness } = await service.states([P1]);
    expect(states[P1]).toBe('out');
    expect(freshness.as_of).toBe(T0.toISOString());
  });

  it.each(['unauthorized', 'failed'] as const)('reports a %s page', async (kind) => {
    const { service } = build();
    pages = [{ kind }];
    await expect(service.refresh()).resolves.toBe(kind);
    await expect(service.freshness()).resolves.toEqual({ state: 'never', as_of: null });
  });

  it('refuses a page computed for another store', async () => {
    const { service } = build();
    pages = [page({ storeId: OTHER_STORE, items: [item(P1, 'in_stock')] })];
    await expect(service.refresh()).resolves.toBe('failed');
    await expect(service.freshness()).resolves.toEqual({ state: 'never', as_of: null });
  });

  it('fails closed when the server never ends the cursor chain', async () => {
    const { service } = build();
    const endless = page({ nextCursor: 'again' });
    const spy = vi.fn(() => Promise.resolve(endless));
    const fresh = createAvailabilityService({
      client: { fetchPage: spy },
      repo: createAvailabilityRepo(handleFor(db)),
      config: CONFIG,
      readScope: () => Promise.resolve(scope),
      now: () => now,
    });
    await expect(fresh.refresh()).resolves.toBe('failed');
    expect(spy).toHaveBeenCalledTimes(10_000);
    expect(service).toBeDefined();
  });

  it('a later duplicate of a product wins within one snapshot', async () => {
    const { service } = build();
    pages = [
      page({ items: [item(P1, 'in_stock')], nextCursor: 'c1' }),
      page({ items: [item(P1, 'out')] }),
    ];
    await service.refresh();
    expect((await service.states([P1])).states[P1]).toBe('out');
  });

  it('shares one run between concurrent refreshes, and an error is reported as failed', async () => {
    const onError = vi.fn();
    const failing = createAvailabilityService({
      client: {
        fetchPage: () => Promise.reject(new Error('boom')),
      },
      repo: createAvailabilityRepo(handleFor(db)),
      config: CONFIG,
      readScope: () => Promise.resolve(scope),
      now: () => now,
      onError,
    });
    const [a, b] = await Promise.all([failing.refresh(), failing.refresh()]);
    expect([a, b]).toEqual(['failed', 'failed']);
    expect(onError).toHaveBeenCalledTimes(1);
    // the in-flight latch is released: a later refresh runs again
    await failing.refresh();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('an error without an onError sink is still reported as failed', async () => {
    const quiet = createAvailabilityService({
      client: { fetchPage: () => Promise.reject(new Error('boom')) },
      repo: createAvailabilityRepo(handleFor(db)),
      config: CONFIG,
      readScope: () => Promise.resolve(scope),
      now: () => now,
    });
    await expect(quiet.refresh()).resolves.toBe('failed');
  });
});

describe('row states', () => {
  it('never downloaded: every row is unknown', async () => {
    const { service } = build();
    const result = await service.states([P1]);
    expect(result.freshness).toEqual({ state: 'never', as_of: null });
    expect(result.states[P1]).toBe('unknown');
  });

  it('fresh: a product with no record is unknown, never in stock', async () => {
    const { service } = build();
    pages = [page({ items: [item(P1, 'in_stock')] })];
    await service.refresh();
    expect((await service.states([P2])).states[P2]).toBe('unknown');
  });

  it('exactly 60 minutes old is still fresh; more than 60 minutes makes every row uncertain', async () => {
    const { service } = build();
    pages = [page({ items: [item(P1, 'in_stock'), item(P2, 'out')] })];
    await service.refresh();
    now = new Date(T0.getTime() + 60 * 60_000);
    expect((await service.freshness()).state).toBe('fresh');
    now = new Date(T0.getTime() + 60 * 60_000 + 1);
    const stale = await service.states([P1, P2, P3]);
    expect(stale.freshness).toEqual({ state: 'stale', as_of: T0.toISOString() });
    expect(stale.states).toEqual({ [P1]: 'uncertain', [P2]: 'uncertain', [P3]: 'uncertain' });
  });

  it('a failed refresh while the cache is still fresh changes nothing', async () => {
    const { service } = build();
    pages = [page({ items: [item(P1, 'low')] })];
    await service.refresh();
    now = new Date(T0.getTime() + 15 * 60_000);
    pages = [{ kind: 'failed' }];
    await service.refresh();
    const after = await service.states([P1]);
    expect(after.states[P1]).toBe('low');
    expect(after.freshness.state).toBe('fresh');
  });

  it('the answer never carries the Available-to-Sell number', async () => {
    const { service } = build();
    pages = [page({ items: [item(P1, 'in_stock', '123.5000')] })];
    await service.refresh();
    expect(JSON.stringify(await service.states([P1]))).not.toContain('123');
  });

  it('an unparseable cached stamp reads as stale', async () => {
    const { service, repo } = build();
    repo.replaceAll({
      scopeKey: 'tenant-1|' + STORE + '|1000',
      oldestAsOf: 'not-a-date',
      refreshedAt: T0.toISOString(),
      items: [item(P1, 'in_stock')],
    });
    expect((await service.freshness()).state).toBe('stale');
  });
});

describe('scope (spec 013 FR-7)', () => {
  async function filled() {
    const built = build();
    pages = [page({ items: [item(P1, 'in_stock')] })];
    await built.service.refresh();
    return built;
  }

  it('a store change purges the cache and reads as never', async () => {
    const { service, repo } = await filled();
    scope = { ...SCOPE, branchId: OTHER_STORE };
    await expect(service.freshness()).resolves.toEqual({ state: 'never', as_of: null });
    expect(repo.readState()).toBeNull();
    expect(repo.readBands([P1]).size).toBe(0);
  });

  it('a re-pair to the SAME store also purges (the pairing stamp is part of the scope)', async () => {
    const { service, repo } = await filled();
    scope = { ...SCOPE, pairedAt: 2_000 };
    expect((await service.states([P1])).states[P1]).toBe('unknown');
    expect(repo.readState()).toBeNull();
  });

  it('unpaired purges and a refresh is refused', async () => {
    const { service, repo } = await filled();
    scope = null;
    await expect(service.refresh()).resolves.toBe('unpaired');
    expect(repo.readState()).toBeNull();
    await expect(service.freshness()).resolves.toEqual({ state: 'never', as_of: null });
  });

  it('a refresh under a new pairing drops the old pairing rows first, then fills its own', async () => {
    const { service } = await filled();
    scope = { ...SCOPE, branchId: OTHER_STORE };
    pages = [page({ storeId: OTHER_STORE, items: [item(P2, 'out')] })];
    await expect(service.refresh()).resolves.toBe('refreshed');
    const { states } = await service.states([P1, P2]);
    expect(states).toEqual({ [P1]: 'unknown', [P2]: 'out' });
  });

  it('a pairing that changes while pages are being read never receives the rows', async () => {
    const { repo } = build();
    let reads = 0;
    const racing = createAvailabilityService({
      client: { fetchPage: () => Promise.resolve(page({ items: [item(P1, 'in_stock')] })) },
      repo,
      config: CONFIG,
      readScope: () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? SCOPE : { ...SCOPE, pairedAt: 9_999 });
      },
      now: () => now,
    });
    await expect(racing.refresh()).resolves.toBe('failed');
    expect(repo.readState()).toBeNull();
  });

  it('a pairing that ends while pages are being read never receives the rows', async () => {
    const { repo } = build();
    let reads = 0;
    const racing = createAvailabilityService({
      client: { fetchPage: () => Promise.resolve(page({ items: [item(P1, 'in_stock')] })) },
      repo,
      config: CONFIG,
      readScope: () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? SCOPE : null);
      },
      now: () => now,
    });
    await expect(racing.refresh()).resolves.toBe('failed');
    expect(repo.readState()).toBeNull();
  });
});

describe('scheduling', () => {
  it('starts with an immediate refresh and repeats on the configured interval until stopped', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn(() => Promise.resolve(page({ items: [item(P1, 'in_stock')] })));
      const service = createAvailabilityService({
        client: { fetchPage: spy },
        repo: createAvailabilityRepo(handleFor(db)),
        config: { refreshIntervalMs: 5_000, staleAfterMs: 60_000 },
        readScope: () => Promise.resolve(scope),
        now: () => now,
      });
      const stop = service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(spy).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('no reservation or stock call, ever', () => {
  it('a full multi-page refresh sends only GETs to the one snapshot path, with the device bearer', async () => {
    const calls: Array<{ url: string; method: string; auth: string | null }> = [];
    const bodies = [
      { storeId: STORE, asOf: T0.toISOString(), items: [item(P1, 'low')], nextCursor: 'c1' },
      { storeId: STORE, asOf: T0.toISOString(), items: [item(P2, 'out')], nextCursor: null },
    ];
    const fetchSpy = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: new Request(input).url,
        method: init?.method ?? 'GET',
        auth: headers.get('authorization'),
      });
      const body = bodies.shift();
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const service = createAvailabilityService({
      client: createAvailabilityClient({
        baseUrl: 'https://bc.test/',
        fetch: fetchSpy,
        readToken: () => Promise.resolve('device-token'),
      }),
      repo: createAvailabilityRepo(handleFor(db)),
      config: CONFIG,
      readScope: () => Promise.resolve(scope),
      now: () => now,
    });
    await expect(service.refresh()).resolves.toBe('refreshed');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const url = new URL(call.url);
      expect(call.method).toBe('GET');
      expect(url.origin + url.pathname).toBe(`https://bc.test${AVAILABILITY_PATH}`);
      expect(url.searchParams.get('branch_id')).toBe(STORE);
      expect(call.auth).toBe('Bearer device-token');
    }
    expect(new URL(calls[1]?.url ?? '').searchParams.get('cursor')).toBe('c1');
  });
});
