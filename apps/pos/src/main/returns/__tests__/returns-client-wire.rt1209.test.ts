/**
 * RT-1209 — characterization of the returns client's wire behavior: the request each of its three
 * calls makes (method, URL, exact header set, exact body bytes, timeout, no retry) and how each
 * transport fault and response class maps to an outcome. It passes unchanged before and after the
 * client moved onto the shared Backend-Core transport (`../http/transport.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_REQUEST_TIMEOUT_MS, createReturnsClient } from '../returns-client.js';

const SALE = '0190f5a2-7b3c-7d4e-8f90-0000000000c1';
const RETURN = '0190f5a2-7b3c-7d4e-8f90-0000000000d1';
const KEY = 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-0000000000f1';
const BODY = '{"sourceSystem":"pos-pulse","externalId":"x"}';
const TOKEN = ['tok', 'en-for-wire-test'].join('');
const RETURN_REQUEST = { saleRef: SALE, bodyJson: BODY, idempotencyKey: KEY, resend: false };
const EXEC_REQUEST = { saleRef: SALE, returnRef: RETURN, bodyJson: BODY, idempotencyKey: KEY };

type Init = RequestInit & { headers: Record<string, string> };

function clientWith(impl: (url: string, init: Init) => Promise<Response>, timeoutMs?: number) {
  const fetchMock = vi.fn(impl);
  const client = createReturnsClient({
    baseUrl: 'https://api.example.test/',
    fetch: fetchMock as unknown as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { client, fetchMock };
}

/** Every call of the client, by name, each with its own request, so one table drives them all. */
const CALLS = {
  readSale: (c: ReturnType<typeof clientWith>['client'], token: string | null) =>
    c.readSale(SALE, token),
  recordReturn: (c: ReturnType<typeof clientWith>['client'], token: string | null) =>
    c.recordReturn(RETURN_REQUEST, token),
  recordRefundExecution: (c: ReturnType<typeof clientWith>['client'], token: string | null) =>
    c.recordRefundExecution(EXEC_REQUEST, token),
} as const;
type CallName = keyof typeof CALLS;
const CALL_NAMES = Object.keys(CALLS) as CallName[];

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

afterEach(() => vi.restoreAllMocks());

describe('RT-1209 returns wire: the request', () => {
  it('readSale: GET /sales/{ref}, only the Authorization header, no body', async () => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(json(500, {})));
    await client.readSale(SALE, TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Init];
    expect(url).toBe(`https://api.example.test/api/pos/v1/sales/${SALE}`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['recordReturn', `/api/pos/v1/sales/${SALE}/returns`],
    ['recordRefundExecution', `/api/pos/v1/sales/${SALE}/returns/${RETURN}/executions`],
  ] as const)('%s: POST, exact URL, header set and body bytes', async (name, path) => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(json(500, {})));
    await CALLS[name](client, TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Init];
    expect(url).toBe(`https://api.example.test${path}`);
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
    expect(RETURNS_REQUEST_TIMEOUT_MS).toBe(15_000);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await clientWith(() => Promise.resolve(json(500, {}))).client.readSale(SALE, TOKEN);
    await clientWith(() => Promise.resolve(json(500, {})), 1234).client.readSale(SALE, TOKEN);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([15_000, 1234]);
  });

  it.each(CALL_NAMES)('%s never retries: a failing exchange is one fetch call', async (name) => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(json(503, {})));
    await CALLS[name](client, TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(CALL_NAMES)('%s with no or an empty envelope sends nothing', async (name) => {
    for (const token of [null, ''] as const) {
      const { client, fetchMock } = clientWith(() => Promise.resolve(json(201, {})));
      const out = await CALLS[name](client, token);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(out).toEqual(
        name === 'readSale' ? { kind: 'unavailable' } : { kind: 'unknown', cause: 'no_credential' },
      );
    }
  });

  it('a ref that is not a UUID sends nothing', async () => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(json(201, {})));
    expect(await client.readSale('not-a-uuid', TOKEN)).toEqual({
      kind: 'refused',
      reason: 'returns_unavailable',
    });
    expect(await client.recordReturn({ ...RETURN_REQUEST, saleRef: 'x' }, TOKEN)).toEqual({
      kind: 'refused',
      reason: 'returns_unavailable',
    });
    expect(await client.recordRefundExecution({ ...EXEC_REQUEST, returnRef: 'x' }, TOKEN)).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('RT-1209 returns wire: transport faults', () => {
  it.each(CALL_NAMES)('%s: a rejected fetch is a network fault', async (name) => {
    const { client } = clientWith(() => Promise.reject(new Error('ECONNRESET')));
    const out = await CALLS[name](client, TOKEN);
    expect(out).toEqual(
      name === 'readSale' ? { kind: 'unavailable' } : { kind: 'unknown', cause: 'network' },
    );
  });

  it.each(['TimeoutError', 'AbortError'])('a fetch rejecting with %s is a timeout', async (n) => {
    const { client } = clientWith(() => Promise.reject(new DOMException('x', n)));
    expect(await client.recordReturn(RETURN_REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      cause: 'timeout',
    });
  });

  it('the signal aborting the fetch (a real timeout) is a timeout', async () => {
    const { client } = clientWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
      20,
    );
    expect(await client.recordRefundExecution(EXEC_REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      cause: 'timeout',
    });
  });

  it('the timeout firing while the body is read is a timeout', async () => {
    const { client } = clientWith(
      (_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init.signal?.addEventListener('abort', () => {
                  controller.error(init.signal?.reason);
                });
              },
            }),
            { status: 201 },
          ),
        ),
      20,
    );
    expect(await client.recordReturn(RETURN_REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      cause: 'timeout',
    });
  });

  it('a body that fails mid-read (no timeout) is a network fault', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket closed'));
      },
    });
    const { client } = clientWith(() => Promise.resolve(new Response(stream, { status: 201 })));
    expect(await client.recordReturn(RETURN_REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      cause: 'network',
    });
  });

  it('concurrent calls keep their own fault cause', async () => {
    let n = 0;
    const { client } = clientWith(() =>
      n++ === 0
        ? Promise.reject(new DOMException('x', 'TimeoutError'))
        : Promise.reject(new TypeError('down')),
    );
    const [a, b] = await Promise.all([
      client.recordReturn(RETURN_REQUEST, TOKEN),
      client.recordReturn(RETURN_REQUEST, TOKEN),
    ]);
    expect([a, b]).toEqual([
      { kind: 'unknown', cause: 'timeout' },
      { kind: 'unknown', cause: 'network' },
    ]);
  });
});

describe('RT-1209 returns wire: answers', () => {
  const noBody = (status: number): Response => new Response('', { status });

  it('an empty or non-JSON 2xx body is unreadable', async () => {
    for (const res of [noBody(201), new Response('<html>', { status: 200 })]) {
      const { client } = clientWith(() => Promise.resolve(res));
      expect(await client.recordReturn(RETURN_REQUEST, TOKEN)).toEqual({
        kind: 'unknown',
        cause: 'unreadable_body',
      });
    }
    const { client } = clientWith(() => Promise.resolve(noBody(200)));
    expect(await client.readSale(SALE, TOKEN)).toEqual({ kind: 'unavailable' });
    const exec = clientWith(() => Promise.resolve(noBody(201)));
    expect(await exec.client.recordRefundExecution(EXEC_REQUEST, TOKEN)).toEqual({
      kind: 'unknown',
      cause: 'unreadable_body',
    });
  });

  it.each([
    [400, 'validation_error'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'returns_unavailable'],
    [409, 'conflict'],
    [422, 'return_tender_mismatch'],
  ] as const)('an empty %i body still classifies by status (%s)', async (status, reason) => {
    const { client } = clientWith(() => Promise.resolve(noBody(status)));
    expect(await client.recordReturn(RETURN_REQUEST, TOKEN)).toEqual({ kind: 'refused', reason });
    const read = clientWith(() => Promise.resolve(noBody(status)));
    expect(await read.client.readSale(SALE, TOKEN)).toEqual({ kind: 'refused', reason });
  });

  it.each([
    [429, 'rate_limited'],
    [500, 'server_5xx'],
    [502, 'server_5xx'],
    [302, 'unexpected_status'],
  ] as const)('an empty %i body to a return is unknown (%s)', async (status, cause) => {
    const { client } = clientWith(() => Promise.resolve(noBody(status)));
    expect(await client.recordReturn(RETURN_REQUEST, TOKEN)).toEqual({ kind: 'unknown', cause });
  });

  it('a resend turns the pre-replay statuses into unknown, the credit refusal stays terminal', async () => {
    for (const [status, cause] of [
      [401, 'pre_replay_401'],
      [403, 'pre_replay_403'],
      [404, 'pre_replay_404'],
    ] as const) {
      const { client } = clientWith(() => Promise.resolve(noBody(status)));
      expect(await client.recordReturn({ ...RETURN_REQUEST, resend: true }, TOKEN)).toEqual({
        kind: 'unknown',
        cause,
      });
    }
    const credit = clientWith(() =>
      Promise.resolve(json(403, { error: { code: 'credit_sale_reversal_restricted' } })),
    );
    expect(await credit.client.recordReturn({ ...RETURN_REQUEST, resend: true }, TOKEN)).toEqual({
      kind: 'refused',
      reason: 'credit_sale_reversal_restricted',
    });
  });

  it.each([
    [409, 'conflict'],
    [422, 'exceeds_allocation'],
  ] as const)('an execution %i is a refusal (%s); 400 and 404 stay unknown', async (s, reason) => {
    const { client } = clientWith(() => Promise.resolve(noBody(s)));
    expect(await client.recordRefundExecution(EXEC_REQUEST, TOKEN)).toEqual({
      kind: 'refused',
      reason,
    });
    for (const [status, cause] of [
      [400, 'unexpected_status'],
      [404, 'pre_replay_404'],
    ] as const) {
      const other = clientWith(() => Promise.resolve(noBody(status)));
      expect(await other.client.recordRefundExecution(EXEC_REQUEST, TOKEN)).toEqual({
        kind: 'unknown',
        cause,
      });
    }
  });
});
