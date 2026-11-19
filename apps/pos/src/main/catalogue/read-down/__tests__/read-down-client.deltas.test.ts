import { describe, expect, it } from 'vitest';

import { DELTAS_PATH, createReadDownClient } from '../read-down-client.js';
import { DELTA_MAX_PAGES } from '../read-down-delta-client.js';
import type { SellableCatalogRow } from '../map-sellable-row.js';

/**
 * RT-1487 — `fetchDeltas(since)` on the live read-down client.
 *
 * Contract `catalog/read-down.yaml` `posGetCatalogDeltas`: ordered `upsert` /
 * `remove_from_sellable` ops after an opaque `since` cursor, cursor-paginated via
 * `next_page_token`, each page carrying the advanced `cursor`; a stale cursor is a
 * `409` with `error.code = snapshot_required`. Same transport rules as the
 * snapshot: never throws, a transport fault is `no_connection`, a 401 is
 * `device_unauthorized`, and any malformed page fails the whole fetch (no partial
 * delta is ever applied).
 */

const BASE = 'https://example.invalid';
const TOKEN = 'device-token-xyz';

const ROW: SellableCatalogRow = {
  product_id: 'p1',
  sku: 'SKU-1',
  name: 'Paracetamol 500mg',
  aliases: ['6223000000001'],
  price: { amount: '12.50', currency_code: 'EGP' },
  tax_category: 'standard',
  active: true,
  row_cursor: 'rc-1',
};

interface Captured {
  url: string;
  init: RequestInit;
}

function scripted(responses: Array<Response | 'network'>): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  let i = 0;
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init: init ?? {},
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next === undefined || next === 'network') return Promise.reject(new Error('down'));
    return Promise.resolve(next.clone());
  };
  return { fetchImpl, captured };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function deltaPage(ops: unknown[], cursor: string, next: string | null = null): unknown {
  return { ops, cursor, next_page_token: next };
}

function client(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return createReadDownClient({
    baseUrl: BASE,
    fetch: fetchImpl,
    getDeviceToken: () => Promise.resolve(TOKEN),
  });
}

describe('RT-1487 — read-down client fetchDeltas', () => {
  it('GETs the deltas route with since + device bearer and returns ops and the advanced cursor', async () => {
    const { fetchImpl, captured } = scripted([
      json(
        deltaPage(
          [
            { op: 'upsert', product_id: 'p1', row: ROW, row_cursor: 'rc-1' },
            { op: 'remove_from_sellable', product_id: 'p2', row_cursor: 'rc-2' },
          ],
          'cur-2',
        ),
      ),
    ]);

    const result = await client(fetchImpl).fetchDeltas('cur-1');

    expect(result).toEqual({
      kind: 'ok',
      cursor: 'cur-2',
      ops: [
        { op: 'upsert', productId: 'p1', row: ROW },
        { op: 'remove_from_sellable', productId: 'p2' },
      ],
    });
    expect(captured).toHaveLength(1);
    const url = new URL(captured[0]?.url ?? '');
    expect(url.pathname).toBe(DELTAS_PATH);
    expect(url.searchParams.get('since')).toBe('cur-1');
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('continues each next page from the previous page cursor and keeps the last cursor', async () => {
    // Backend-Core's deltas route pages by `since` only: each page's `cursor` is
    // the last emitted change, so the next page is `since = page.cursor`.
    const { fetchImpl, captured } = scripted([
      json(
        deltaPage([{ op: 'upsert', product_id: 'p1', row: ROW, row_cursor: 'a' }], 'cur-a', 'pg-2'),
      ),
      json(deltaPage([{ op: 'remove_from_sellable', product_id: 'p1', row_cursor: 'b' }], 'cur-b')),
    ]);

    const result = await client(fetchImpl).fetchDeltas('cur-0');

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.cursor).toBe('cur-b');
    expect(result.ops.map((o) => o.op)).toEqual(['upsert', 'remove_from_sellable']);
    const first = new URL(captured[0]?.url ?? '');
    const second = new URL(captured[1]?.url ?? '');
    expect(first.searchParams.get('since')).toBe('cur-0');
    expect(second.searchParams.get('since')).toBe('cur-a');
    expect(second.searchParams.has('page_token')).toBe(false);
  });

  it('a server that ignores pagination cannot loop: a page that does not advance fails', async () => {
    // The same page with the same cursor and a non-null next_page_token, forever.
    const { fetchImpl, captured } = scripted([
      json(
        deltaPage(
          [{ op: 'remove_from_sellable', product_id: 'p1', row_cursor: 'x' }],
          'cur-1',
          'more',
        ),
      ),
    ]);

    expect(await client(fetchImpl).fetchDeltas('cur-1')).toEqual({ kind: 'failed' });
    expect(captured).toHaveLength(1);
  });

  it('an empty delta returns ok with no ops and the server cursor', async () => {
    const { fetchImpl } = scripted([json(deltaPage([], 'cur-1'))]);
    expect(await client(fetchImpl).fetchDeltas('cur-1')).toEqual({
      kind: 'ok',
      cursor: 'cur-1',
      ops: [],
    });
  });

  it('a 409 snapshot_required maps to snapshot_required', async () => {
    const { fetchImpl } = scripted([
      json({ error: { code: 'snapshot_required', message: 'x' } }, 409),
    ]);
    expect(await client(fetchImpl).fetchDeltas('old')).toEqual({ kind: 'snapshot_required' });
  });

  it('a 409 snapshot_required on a later page also maps to snapshot_required', async () => {
    const { fetchImpl } = scripted([
      json(deltaPage([], 'cur-a', 'pg-2')),
      json({ error: { code: 'snapshot_required', message: 'x' } }, 409),
    ]);
    expect(await client(fetchImpl).fetchDeltas('old')).toEqual({ kind: 'snapshot_required' });
  });

  it.each([
    ['a 401', [json({}, 401)], 'device_unauthorized'],
    ['a transport fault', ['network' as const], 'no_connection'],
    ['a 500', [json({}, 500)], 'failed'],
    ['a 409 with another code', [json({ error: { code: 'validation_error' } }, 409)], 'failed'],
    ['a missing cursor', [json({ ops: [], next_page_token: null })], 'failed'],
    ['ops not an array', [json({ ops: {}, cursor: 'c', next_page_token: null })], 'failed'],
    [
      'an unknown op',
      [json(deltaPage([{ op: 'delete', product_id: 'p1', row_cursor: 'x' }], 'c'))],
      'failed',
    ],
    [
      'an upsert without a valid row',
      [json(deltaPage([{ op: 'upsert', product_id: 'p1', row_cursor: 'x' }], 'c'))],
      'failed',
    ],
    [
      'an upsert whose row is for another product',
      [json(deltaPage([{ op: 'upsert', product_id: 'p9', row: ROW, row_cursor: 'x' }], 'c'))],
      'failed',
    ],
    ['a malformed later page', [json(deltaPage([], 'c', 'pg-2')), json({ nope: true })], 'failed'],
  ])('%s fails the whole delta fetch', async (_label, responses, kind) => {
    const { fetchImpl } = scripted(responses);
    expect(await client(fetchImpl).fetchDeltas('cur-1')).toEqual({ kind });
  });

  it('does not call the backend without a device token', async () => {
    const { fetchImpl, captured } = scripted([json(deltaPage([], 'c'))]);
    const c = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(null),
    });
    expect(await c.fetchDeltas('cur-1')).toEqual({ kind: 'failed' });
    expect(captured).toHaveLength(0);
  });

  it('too many delta pages re-baselines with a snapshot instead of walking on', async () => {
    let n = 0;
    const captured: string[] = [];
    const fetchImpl = (input: RequestInfo | URL): Promise<Response> => {
      captured.push(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      );
      n += 1;
      return Promise.resolve(json(deltaPage([], `cur-${String(n)}`, 'more')));
    };

    const result = await client(fetchImpl).fetchDeltas('cur-0');

    expect(result).toEqual({ kind: 'snapshot_required' });
    expect(captured).toHaveLength(DELTA_MAX_PAGES);
  });
});
