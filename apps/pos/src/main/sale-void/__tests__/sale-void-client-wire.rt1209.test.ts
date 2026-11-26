/**
 * RT-1209 — characterization of the sale-void client's wire behavior: the request it makes
 * (method, URL, exact header set, exact body bytes, timeout) and how each response class and
 * transport fault maps to an outcome. It passes unchanged before and after the client moved onto
 * the shared Backend-Core transport (`../http/transport.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SALE_VOID_REQUEST_TIMEOUT_MS, createSaleVoidClient } from '../sale-void-client.js';

const SALE = '0190f5a2-7b3c-7d4e-8f90-0000000000c1';
const EVENT = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
const KEY = 'pos-pulse-void:0190f5a2-7b3c-7d4e-8f90-0000000000f1';
const BODY = '{"sourceSystem":"pos-pulse","externalId":"x"}';
const REQUEST = { saleRef: SALE, bodyJson: BODY, idempotencyKey: KEY };
const TOKEN = ['tok', 'en-for-wire-test'].join('');
const RECORDED = { kind: 'void', eventRef: EVENT, saleRef: SALE };

type Init = RequestInit & { headers: Record<string, string> };

function clientWith(impl: (url: string, init: Init) => Promise<Response>, timeoutMs?: number) {
  const fetchMock = vi.fn(impl);
  const client = createSaleVoidClient({
    baseUrl: 'https://api.example.test/',
    fetch: fetchMock as unknown as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { client, fetchMock };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

afterEach(() => vi.restoreAllMocks());

describe('RT-1209 sale-void wire: the request', () => {
  it.each([
    ['void', 'recordVoid'],
    ['cashier-void', 'recordVoidAsCashier'],
  ] as const)('POST /%s: exact URL, header set, body bytes, one call', async (route, method) => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(json(201, RECORDED)));
    await client[method](REQUEST, TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Init];
    expect(url).toBe(`https://api.example.test/api/pos/v1/sales/${SALE}/${route}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(BODY);
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Idempotency-Key': KEY,
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a 15 s timeout by default and the injected one when given', async () => {
    expect(SALE_VOID_REQUEST_TIMEOUT_MS).toBe(15_000);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await clientWith(() => Promise.resolve(json(201, RECORDED))).client.recordVoid(REQUEST, TOKEN);
    await clientWith(() => Promise.resolve(json(201, RECORDED)), 1234).client.recordVoid(
      REQUEST,
      TOKEN,
    );
    expect(spy.mock.calls.map((c) => c[0])).toEqual([15_000, 1234]);
  });

  it('never retries: a failing exchange is one fetch call', async () => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(json(503, {})));
    await client.recordVoid(REQUEST, TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('RT-1209 sale-void wire: transport faults', () => {
  it('a rejected fetch is unknown (no_connection)', async () => {
    const { client } = clientWith(() => Promise.reject(new Error('ECONNRESET')));
    expect(await client.recordVoid(REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      category: 'no_connection',
    });
  });

  it('a timeout (the signal aborting the fetch) is unknown (no_connection)', async () => {
    const { client } = clientWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      20,
    );
    expect(await client.recordVoid(REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      category: 'no_connection',
    });
  });

  it('a body that fails mid-read is unknown (no_connection)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket closed'));
      },
    });
    const { client } = clientWith(() => Promise.resolve(new Response(stream, { status: 201 })));
    expect(await client.recordVoid(REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      category: 'no_connection',
    });
  });
});

describe('RT-1209 sale-void wire: answers', () => {
  const noBody = (status: number): Response => new Response('', { status });

  it('an empty or non-JSON 2xx body is unknown (unreadable_answer)', async () => {
    for (const res of [noBody(201), new Response('<html>', { status: 200 })]) {
      const { client } = clientWith(() => Promise.resolve(res));
      expect(await client.recordVoid(REQUEST, TOKEN)).toEqual({
        kind: 'unknown',
        category: 'unreadable_answer',
      });
    }
  });

  it.each([
    [400, 'validation_error'],
    [404, 'sale_not_found'],
    [409, 'conflict'],
    [422, 'validation_error'],
  ] as const)('an empty %i body still classifies by status (%s)', async (status, reason) => {
    const { client } = clientWith(() => Promise.resolve(noBody(status)));
    expect(await client.recordVoid(REQUEST, TOKEN)).toEqual({ kind: 'refused', reason });
  });

  it.each([401, 403, 429, 500, 502])('an empty %i body is unknown', async (status) => {
    const { client } = clientWith(() => Promise.resolve(noBody(status)));
    const out = await client.recordVoid(REQUEST, TOKEN);
    expect(out).toEqual({
      kind: 'unknown',
      category: status === 401 ? 'unauthorized' : 'server_error',
    });
  });

  it('the replay header is read case-insensitively and only the value true counts', async () => {
    const yes = clientWith(() =>
      Promise.resolve(json(201, RECORDED, { 'idempotent-replayed': 'true' })),
    );
    expect(await yes.client.recordVoid(REQUEST, TOKEN)).toMatchObject({ replayed: true });
    const no = clientWith(() =>
      Promise.resolve(json(201, RECORDED, { 'Idempotent-Replayed': 'false' })),
    );
    expect(await no.client.recordVoid(REQUEST, TOKEN)).toMatchObject({ replayed: false });
  });

  it('a sale ref in another letter case still names this sale', async () => {
    const { client } = clientWith(() =>
      Promise.resolve(json(201, { ...RECORDED, saleRef: SALE.toUpperCase() })),
    );
    expect(await client.recordVoid(REQUEST, TOKEN)).toEqual({
      kind: 'recorded',
      replayed: false,
      eventRef: EVENT,
    });
  });
});
