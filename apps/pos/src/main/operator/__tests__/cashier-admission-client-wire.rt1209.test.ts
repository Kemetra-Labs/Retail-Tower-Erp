/**
 * RT-1209 — characterization of the cashier-admission client's wire behavior: the request each of
 * its four calls makes (method, URL, exact header set, exact body bytes, timeout, no retry) and how
 * each transport fault and response class maps to a result. It passes unchanged before and after the
 * client moved onto the shared Backend-Core transport (`../../http/transport.ts`), except the one
 * test that pins the 2 MB body cap, a deliberate difference.
 *
 * The client reads the answer body only on a 200 of admit / reconcile / listRoster, so a body that
 * cannot be read (a reset stream, a timeout while reading) makes such a 200 `rejected` and never
 * changes any other result: the answer arrived, so it is never `no_connection`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMISSION_REQUEST_TIMEOUT_MS,
  createCashierAdmissionClient,
} from '../cashier-admission-client.js';

const USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789abc';
const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';
const GENERATION = '1759572000.123456';
// Built at run time so no secret-shaped literal lands in the history (gitleaks full-history).
const KEY = ['pos-cashier-adm', '1f0e3c1e-61a4-4c84-a3b1-9d0b2c7c8e11'].join('-');
const TOKEN = ['dev', 'ice-token-for-wire-test'].join('');

const ADMITTED = {
  kind: 'admitted',
  admission_id: ADMISSION_ID,
  offline_grace_seconds: 86_400,
  admission_ttl_seconds: 43_200,
  server_time: '2026-10-04T10:00:00.000Z',
  display_name: 'Mona',
  admission_generation: GENERATION,
} as const;
const ROSTER = {
  cashiers: [{ user_id: USER_ID, operator_id: 'user_2abc', display_name: 'Mona' }],
} as const;

type Init = RequestInit & { headers: Record<string, string> };

function clientWith(
  impl: (url: string, init: Init) => Promise<Response>,
  opts: { timeoutMs?: number; token?: () => Promise<string | null> } = {},
) {
  const fetchMock = vi.fn(impl);
  const client = createCashierAdmissionClient({
    baseUrl: 'https://api.example.test/',
    fetch: fetchMock as unknown as typeof fetch,
    getDeviceToken: opts.token ?? (() => Promise.resolve(TOKEN)),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  return { client, fetchMock };
}

type Client = ReturnType<typeof clientWith>['client'];

/** Every call of the client, by name, so one table drives them all. */
const CALLS = {
  admit: (c: Client) =>
    c.admit({ mode: 'online', user_id: USER_ID, takeover: true, idempotency_key: KEY }),
  reconcile: (c: Client) =>
    c.reconcile({
      mode: 'reconcile_offline',
      user_id: USER_ID,
      offline_admitted_at: '2026-10-04T09:00:00.000Z',
      idempotency_key: KEY,
    }),
  end: (c: Client) => c.end(ADMISSION_ID, GENERATION),
  listRoster: (c: Client) => c.listRoster(),
} as const;
type CallName = keyof typeof CALLS;
const CALL_NAMES = Object.keys(CALLS) as CallName[];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = (status: number): Response => new Response(null, { status });

/** An answer whose body stream fails on the first read (a reset connection mid-answer). */
function brokenBody(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status });
}

afterEach(() => vi.restoreAllMocks());

describe('RT-1209 cashier-admission wire: the request', () => {
  it.each([
    [
      'admit',
      '/api/pos/v1/cashier-admissions',
      `{"mode":"online","user_id":"${USER_ID}","takeover":true,"idempotency_key":"${KEY}"}`,
    ],
    [
      'reconcile',
      '/api/pos/v1/cashier-admissions',
      `{"mode":"reconcile_offline","user_id":"${USER_ID}","offline_admitted_at":"2026-10-04T09:00:00.000Z","idempotency_key":"${KEY}"}`,
    ],
    [
      'end',
      `/api/pos/v1/cashier-admissions/${ADMISSION_ID}/end`,
      `{"admission_generation":"${GENERATION}"}`,
    ],
  ] as const)('%s: POST, exact URL, header set and body bytes', async (name, path, body) => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(empty(500)));
    await CALLS[name](client);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Init];
    expect(url).toBe(`https://api.example.test${path}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(body);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('listRoster: GET the roster, only the Authorization header, no body', async () => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(empty(500)));
    await client.listRoster();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Init];
    expect(url).toBe('https://api.example.test/api/pos/v1/cashier-admissions/roster');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a 15 s timeout by default and the injected one when given', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await CALLS.admit(clientWith(() => Promise.resolve(empty(500))).client);
    expect(timeout).toHaveBeenLastCalledWith(ADMISSION_REQUEST_TIMEOUT_MS);
    expect(ADMISSION_REQUEST_TIMEOUT_MS).toBe(15_000);
    await CALLS.admit(clientWith(() => Promise.resolve(empty(500)), { timeoutMs: 2_500 }).client);
    expect(timeout).toHaveBeenLastCalledWith(2_500);
  });

  it.each([
    ['a 500', () => Promise.resolve(empty(500))],
    ['a 429', () => Promise.resolve(empty(429))],
    ['a network fault', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ] as const)('never retries by itself (%s)', async (_name, impl) => {
    for (const name of CALL_NAMES) {
      const { client, fetchMock } = clientWith(impl);
      await CALLS[name](client);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe('RT-1209 cashier-admission wire: nothing sent, or no answer', () => {
  it.each([
    ['null', () => Promise.resolve(null)],
    ['empty', () => Promise.resolve('')],
    ['a failing read', () => Promise.reject(new Error('dpapi'))],
  ] as const)('a device token that is %s → no_token, no request', async (_name, token) => {
    for (const name of CALL_NAMES) {
      const { client, fetchMock } = clientWith(() => Promise.resolve(empty(200)), { token });
      await expect(CALLS[name](client)).resolves.toEqual({ kind: 'no_token' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['a network fault', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['an abort', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
  ] as const)('%s → no_connection, on every call', async (_name, impl) => {
    for (const name of CALL_NAMES) {
      const { client } = clientWith(impl);
      await expect(CALLS[name](client)).resolves.toEqual({ kind: 'no_connection' });
    }
  });
});

describe('RT-1209 cashier-admission wire: an answer whose body cannot be read', () => {
  it.each([
    ['admit', 200, 'rejected'],
    ['reconcile', 200, 'rejected'],
    ['listRoster', 200, 'rejected'],
    ['end', 200, 'ended'],
    ['end', 204, 'ended'],
    ['admit', 401, 'device_unauthorized'],
    ['admit', 403, 'refused'],
    ['reconcile', 409, 'idempotency_conflict'],
    ['admit', 429, 'rate_limited'],
    ['admit', 500, 'unavailable'],
    ['end', 401, 'device_unauthorized'],
    ['end', 404, 'rejected'],
    ['end', 503, 'unavailable'],
    ['listRoster', 401, 'device_unauthorized'],
    ['listRoster', 403, 'rejected'],
  ] as const)('%s %i → %s, never no_connection', async (name, status, kind) => {
    const { client } = clientWith(() => Promise.resolve(brokenBody(status)));
    await expect(CALLS[name](client)).resolves.toEqual({ kind });
  });

  it.each([
    ['admit', 200, { kind: 'rejected' }],
    ['admit', 401, { kind: 'device_unauthorized' }],
    ['end', 503, { kind: 'unavailable' }],
    ['end', 200, { kind: 'ended' }],
  ] as const)(
    '%s %i whose body stalls past the timeout → %j, bounded by the timeout',
    async (name, status, expected) => {
      const { client } = clientWith(
        (_url, init) => {
          // The body never ends; the request signal errors it, as a real fetch does on abort.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener('abort', () => {
                controller.error(init.signal?.reason);
              });
            },
          });
          return Promise.resolve(new Response(body, { status }));
        },
        { timeoutMs: 30 },
      );
      await expect(CALLS[name](client)).resolves.toEqual(expected);
    },
  );
});

describe('RT-1209 cashier-admission wire: response classes', () => {
  it.each([
    ['admit', () => json(200, ADMITTED), ADMITTED],
    ['reconcile', () => json(200, ADMITTED), ADMITTED],
    ['admit', () => json(200, { kind: 'active_elsewhere' }), { kind: 'active_elsewhere' }],
    ['admit', () => json(200, { kind: 'admitted' }), { kind: 'rejected' }],
    ['admit', () => new Response('<html>', { status: 200 }), { kind: 'rejected' }],
    ['admit', () => empty(200), { kind: 'rejected' }],
    ['admit', () => json(201, ADMITTED), { kind: 'rejected' }],
    ['admit', () => empty(302), { kind: 'rejected' }],
    ['admit', () => empty(400), { kind: 'rejected' }],
    ['admit', () => empty(418), { kind: 'rejected' }],
    ['admit', () => empty(502), { kind: 'unavailable' }],
    ['listRoster', () => json(200, ROSTER), { kind: 'roster', cashiers: ROSTER.cashiers }],
    ['listRoster', () => json(200, { cashiers: [{}] }), { kind: 'rejected' }],
    ['listRoster', () => empty(429), { kind: 'rejected' }],
    ['listRoster', () => empty(500), { kind: 'unavailable' }],
    ['end', () => empty(202), { kind: 'ended' }],
    ['end', () => empty(302), { kind: 'rejected' }],
    ['end', () => empty(409), { kind: 'rejected' }],
  ] as const)('%s → %j', async (name, make, expected) => {
    const { client } = clientWith(() => Promise.resolve(make()));
    await expect(CALLS[name](client)).resolves.toEqual(expected);
  });

  it('never puts the device token in a result', async () => {
    for (const name of CALL_NAMES) {
      const { client } = clientWith(() => Promise.resolve(json(200, ADMITTED)));
      expect(JSON.stringify(await CALLS[name](client))).not.toContain(TOKEN);
    }
  });

  it('RT-1209 cap: a 200 body over 2 MB is not read → rejected', async () => {
    const huge = { ...ADMITTED, display_name: 'x'.repeat(2_000_001) };
    const { client } = clientWith(() => Promise.resolve(json(200, huge)));
    await expect(CALLS.admit(client)).resolves.toEqual({ kind: 'rejected' });
  });
});
