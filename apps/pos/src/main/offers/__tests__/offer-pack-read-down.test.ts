/**
 * RT-1339 (RT-286 S7) — the Offer Pack read-down: the client (ETag / 304 / X-Server-Time over the
 * shared transport), the worker that feeds the Pack service, and the Pack file kept between runs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfferPackClient, OFFER_PACK_PATH } from '../offer-pack-client.js';
import { createOfferPackFileStore, NO_OFFER_PACK_STORE } from '../offer-pack-file-store.js';
import { createOfferPackWorker } from '../offer-pack-worker.js';
import {
  ISSUED_AT,
  ISSUED_MS,
  TENANT,
  clockedService,
  memoryStore,
  packBody,
} from './pack-fixture.js';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function responder(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<FetchFn>(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
    ),
  );
}

const clientOf = (fetch: FetchFn) => createOfferPackClient({ baseUrl: 'https://bc.test', fetch });

describe('offer pack client', () => {
  it('reads GET /api/pos/v1/store/offer-pack with the device bearer and returns ETag and X-Server-Time', async () => {
    const fetch = responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT });
    const out = await clientOf(fetch).read('dev-token', null);
    expect(out).toMatchObject({ kind: 'ok', etag: '"abc"', serverTime: ISSUED_AT });
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://bc.test${OFFER_PACK_PATH}`);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer dev-token' });
    expect(init.headers).not.toHaveProperty('If-None-Match');
  });

  it('sends If-None-Match, and a 304 is not_modified with the server time', async () => {
    const fetch = responder(304, undefined, { ETag: '"abc"', 'X-Server-Time': ISSUED_AT });
    const out = await clientOf(fetch).read('t', '"abc"');
    expect(out).toEqual({ kind: 'not_modified', serverTime: ISSUED_AT });
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'If-None-Match': '"abc"',
    });
  });

  it('never trusts a 304 to an unconditional read', async () => {
    expect(await clientOf(responder(304, undefined)).read('t', null)).toEqual({
      kind: 'unavailable',
    });
  });

  it.each([
    [404, { kind: 'not_found' }],
    [400, { kind: 'unavailable' }],
    [500, { kind: 'unavailable' }],
    [401, { kind: 'unauthorized' }],
  ])('maps %s (an older server answers 404: no Pack, no offer)', async (status, expected) => {
    expect(await clientOf(responder(status, { error: {} })).read('t', null)).toEqual(expected);
  });

  it('a 200 with no readable body is unavailable; no token and a network fault are unreachable', async () => {
    expect(await clientOf(responder(200, undefined)).read('t', null)).toEqual({
      kind: 'unavailable',
    });
    expect(await clientOf(responder(200, {})).read('', null)).toEqual({ kind: 'unreachable' });
    const down = vi.fn<FetchFn>(() => Promise.reject(new Error('offline')));
    expect(await clientOf(down).read('t', null)).toEqual({ kind: 'unreachable' });
  });
});

function workerOf(fetch: FetchFn, c = clockedService(), token: string | null = 'dev-token') {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const worker = createOfferPackWorker({
    client: clientOf(fetch),
    service: c.service,
    readDeviceToken: () => Promise.resolve(token),
    tenantId: TENANT,
    monotonicMs: c.mono,
    tickIntervalMs: 60_000,
    logger,
  });
  return { worker, c, logger };
}

describe('offer pack worker', () => {
  it('a 200 fills the Pack and anchors trusted time at the request start', async () => {
    const { worker, c } = workerOf(
      responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT }),
    );
    expect(await worker.runTickOnce()).toBe('applied');
    c.advance(1_000);
    const view = c.service.view();
    expect(view.kind === 'fresh' && view.nowMs).toBe(ISSUED_MS + 1_000);
    expect(c.store.saved?.etag).toBe('"abc"');
  });

  it('the next read is conditional; a 304 refreshes the anchor and keeps the Pack', async () => {
    const first = workerOf(
      responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT }),
    );
    await first.worker.runTickOnce();
    const later = new Date(ISSUED_MS + 3_600_000).toISOString();
    const fetch = responder(304, undefined, { ETag: '"abc"', 'X-Server-Time': later });
    const second = workerOf(fetch, first.c);
    first.c.advance(3_600_000);
    expect(await second.worker.runTickOnce()).toBe('applied');
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'If-None-Match': '"abc"',
    });
    const view = first.c.service.view();
    expect(view.kind === 'fresh' && view.nowMs).toBe(ISSUED_MS + 3_600_000);
  });

  it('an unreachable server leaves the Pack to age; nothing is applied from a failed read', async () => {
    const down = vi.fn<FetchFn>(() => Promise.reject(new Error('offline')));
    const { worker, c } = workerOf(down);
    expect(await worker.runTickOnce()).toBe('unreachable');
    expect(c.service.view()).toEqual({ kind: 'none' });
  });

  it('a 404 drops the held and stored Pack: the server has no Pack for this till', async () => {
    const first = workerOf(
      responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT }),
    );
    await first.worker.runTickOnce();
    expect(first.c.service.view().kind).toBe('fresh');
    const gone = workerOf(responder(404, { error: {} }), first.c);
    expect(await gone.worker.runTickOnce()).toBe('not_found');
    expect(first.c.service.view()).toEqual({ kind: 'none' });
    expect(first.c.store.saved).toBeNull();
  });

  it('no sendable device token (revoked) drops the held Pack without a request', async () => {
    const first = workerOf(
      responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT }),
    );
    await first.worker.runTickOnce();
    const fetch = responder(200, packBody());
    const revoked = workerOf(fetch, first.c, null);
    expect(await revoked.worker.runTickOnce()).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
    expect(first.c.service.view()).toEqual({ kind: 'none' });
  });

  it('a Pack off-contract is rejected and never held', async () => {
    const { worker, c } = workerOf(
      responder(200, { packRevision: 1 }, { ETag: '"x"', 'X-Server-Time': ISSUED_AT }),
    );
    expect(await worker.runTickOnce()).toBe('rejected');
    expect(c.service.view()).toEqual({ kind: 'none' });
  });

  it('does not request without a device token', async () => {
    const fetch = responder(200, packBody());
    const { worker } = workerOf(fetch, clockedService(), null);
    expect(await worker.runTickOnce()).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is single-flight: a tick during a read joins it', async () => {
    const fetch = responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT });
    const { worker } = workerOf(fetch);
    const [a, b] = await Promise.all([worker.runTickOnce(), worker.runTickOnce()]);
    expect([a, b]).toEqual(['applied', 'applied']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('start() restores the stored Pack (unproven) before its first read', async () => {
    const first = workerOf(
      responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT }),
    );
    await first.worker.runTickOnce();
    const offline = vi.fn<FetchFn>(() => Promise.reject(new Error('offline')));
    const second = workerOf(offline, clockedService(memoryStore(first.c.store.saved)));
    second.worker.start();
    await second.worker.runTickOnce();
    second.worker.stop();
    expect(second.c.service.view().kind).toBe('unproven');
  });
});

describe('offer pack file store', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'rt1339-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('round-trips the Pack body and ETag', () => {
    const store = createOfferPackFileStore(path.join(tmp(), 'offers'));
    expect(store.load()).toBeNull();
    store.save({ tenantId: TENANT, etag: '"abc"', body: packBody() });
    expect(store.load()).toEqual({ tenantId: TENANT, etag: '"abc"', body: packBody() });
  });

  it('survives a corrupt or foreign file as "no Pack", and clear removes it', () => {
    const dir = tmp();
    const store = createOfferPackFileStore(dir);
    writeFileSync(path.join(dir, 'offer-pack.json'), '{not json', 'utf8');
    expect(store.load()).toBeNull();
    writeFileSync(path.join(dir, 'offer-pack.json'), JSON.stringify({ format: 2 }), 'utf8');
    expect(store.load()).toBeNull();
    store.save({ tenantId: TENANT, etag: '"a"', body: {} });
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('an unwritable folder is swallowed: the run keeps the in-memory Pack', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file');
    writeFileSync(blocker, 'x', 'utf8');
    const store = createOfferPackFileStore(path.join(blocker, 'offers'));
    expect(() => {
      store.save({ tenantId: TENANT, etag: '"a"', body: {} });
    }).not.toThrow();
  });

  it('stores no device token and no time anchor', () => {
    const dir = tmp();
    createOfferPackFileStore(dir).save({ tenantId: TENANT, etag: '"a"', body: packBody() });
    const raw = readFileSync(path.join(dir, 'offer-pack.json'), 'utf8');
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'body',
      'etag',
      'format',
      'tenantId',
    ]);
    expect(raw.toLowerCase()).not.toContain('token');
  });

  it('the no-op store keeps nothing', () => {
    NO_OFFER_PACK_STORE.save({ tenantId: TENANT, etag: '"a"', body: {} });
    NO_OFFER_PACK_STORE.clear();
    expect(NO_OFFER_PACK_STORE.load()).toBeNull();
  });
});

describe('offer pack worker edges', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 304 without a readable X-Server-Time is rejected and keeps the held Pack', async () => {
    const first = workerOf(
      responder(200, packBody(), { ETag: '"abc"', 'X-Server-Time': ISSUED_AT }),
    );
    await first.worker.runTickOnce();
    const second = workerOf(responder(304, undefined, { ETag: '"abc"' }), first.c);
    expect(await second.worker.runTickOnce()).toBe('rejected');
    expect(first.c.service.view().kind).toBe('fresh');
  });

  it.each([
    ['an Error', new TypeError('boom'), 'TypeError'],
    ['a non-Error', 'boom', 'unknown'],
  ])(
    'a tick that throws %s is logged and skipped, never rejected',
    async (_label, thrown, name) => {
      const c = clockedService();
      const logger = { info: vi.fn(), warn: vi.fn() };
      const worker = createOfferPackWorker({
        client: clientOf(responder(200, packBody())),
        service: c.service,
        // A non-Error reason is the case under test: the worker must survive one.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        readDeviceToken: () => Promise.reject(thrown),
        tenantId: TENANT,
        monotonicMs: c.mono,
        tickIntervalMs: 60_000,
        logger,
      });
      expect(await worker.runTickOnce()).toBe('skipped');
      expect(logger.warn).toHaveBeenCalledWith({ error: name }, 'offer_pack_read_down:tick_failed');
    },
  );

  it('start() is idempotent, ticks on the interval, and stop() ends it', async () => {
    vi.useFakeTimers();
    const fetch = responder(200, packBody());
    const c = clockedService();
    const readDeviceToken = vi.fn(() => Promise.resolve<string | null>(null));
    const worker = createOfferPackWorker({
      client: clientOf(fetch),
      service: c.service,
      readDeviceToken,
      tenantId: TENANT,
      monotonicMs: c.mono,
      tickIntervalMs: 60_000,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    worker.stop();
    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readDeviceToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readDeviceToken).toHaveBeenCalledTimes(2);
    worker.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readDeviceToken).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
