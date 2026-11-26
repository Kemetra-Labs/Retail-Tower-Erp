/**
 * RT-1209 — characterization of the shift sync client's wire behavior: the request each send makes
 * (method, URL, exact header set, exact body bytes, timeout, no retry, which fetch feeds the RT-215
 * detector) and how each transport fault and response class maps to a result. It passes unchanged
 * before and after the client moved onto the shared Backend-Core transport (`../../http/transport.ts`).
 *
 * The client reads the answer body only to label a 4xx refusal, so a body that cannot be read (a
 * reset stream, a timeout while reading) never changes the result of a 2xx, 401, 403, 425 / 429 or
 * 5xx, and makes a refusal the generic `rejected`: the answer arrived, so it is never `no_connection`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueuedShiftFact } from '../shift-cashup-repo.js';
import {
  SHIFT_SYNC_REQUEST_TIMEOUT_MS,
  createShiftSyncClient,
  type ShiftSyncResult,
} from '../shift-sync-client.js';

const SHIFT = '0192f5a2-3b4c-7d8e-9f01-0000000000e1';
const TERMINAL = 'term-wire';
const DEVICE = ['dev', 'ice-token-for-wire-test'].join('');
const ENVELOPE = ['env', 'elope-for-wire-test'].join('');
const BODY = '{"shiftId":"0192f5a2-3b4c-7d8e-9f01-0000000000e1","closeKind":"counted"}';

const fact = (over: Partial<QueuedShiftFact> = {}): QueuedShiftFact => ({
  seq: 1,
  factKind: 'close',
  shiftId: SHIFT,
  authPath: 'device',
  idempotencyKey: `pos-pulse-shift-close:${SHIFT}`,
  requestBody: BODY,
  attemptCount: 0,
  ...over,
});

type Init = RequestInit & { headers: Record<string, string> };

function clientWith(impl: (url: string, init: Init) => Promise<Response>, timeoutMs?: number) {
  const fetchMock = vi.fn(impl);
  const observe = vi.fn();
  const client = createShiftSyncClient({
    baseUrl: 'https://api.example.test/',
    fetch: fetchMock as unknown as typeof fetch,
    detector: { observe },
    getDeviceToken: () => Promise.resolve(DEVICE),
    currentTerminalId: () => TERMINAL,
    getEnvelope: () => ENVELOPE,
    nowMs: () => Date.parse('2026-10-05T16:00:00.000Z'),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { client, fetchMock, observe };
}

type Client = ReturnType<typeof clientWith>['client'];

/** Every send of the client, each with a fact it accepts, so one table drives them all. */
const SENDS = {
  openShift: (c: Client) => c.openShift({ terminalId: TERMINAL, fact: fact({ factKind: 'open' }) }),
  recordCashMovement: (c: Client) =>
    c.recordCashMovement({ terminalId: TERMINAL, fact: fact({ factKind: 'movement' }) }),
  closeShift: (c: Client) => c.closeShift({ terminalId: TERMINAL, fact: fact() }),
  sendEnvelope: (c: Client) =>
    c.sendEnvelope?.({
      terminalId: TERMINAL,
      fact: fact({ authPath: 'envelope' }),
    }) as Promise<ShiftSyncResult>,
} as const;
type SendName = keyof typeof SENDS;
const SEND_NAMES = Object.keys(SENDS) as SendName[];

const PATHS: Readonly<Record<SendName, string>> = {
  openShift: '/api/pos/v1/shifts',
  recordCashMovement: `/api/pos/v1/shifts/${SHIFT}/cash-movements`,
  closeShift: `/api/pos/v1/shifts/${SHIFT}/close`,
  sendEnvelope: `/api/pos/v1/shifts/${SHIFT}/close`,
};

const answer = (status: number, body: string | null = null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

/** An answer whose body stream fails on the first read (a reset connection mid-answer). */
function brokenBody(status: number, headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status, headers });
}

const refusal = (code: string) => JSON.stringify({ error: { code, message: 'refused' } });

afterEach(() => vi.restoreAllMocks());

describe('RT-1209 shift sync wire: the request', () => {
  it.each(SEND_NAMES)('%s: POST, exact URL, header set and body bytes', async (name) => {
    const { client, fetchMock } = clientWith(() => Promise.resolve(answer(500)));
    await SENDS[name](client);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Init];
    expect(url).toBe(`https://api.example.test${PATHS[name]}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(BODY);
    const bearer = name === 'sendEnvelope' ? ENVELOPE : DEVICE;
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'Idempotency-Key': `pos-pulse-shift-close:${SHIFT}`,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a 15 s timeout by default and the injected one when given', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await SENDS.closeShift(clientWith(() => Promise.resolve(answer(201))).client);
    expect(timeout).toHaveBeenLastCalledWith(SHIFT_SYNC_REQUEST_TIMEOUT_MS);
    await SENDS.closeShift(clientWith(() => Promise.resolve(answer(201)), 2_500).client);
    expect(timeout).toHaveBeenLastCalledWith(2_500);
  });

  it.each([
    ['a 500', () => Promise.resolve(answer(500))],
    ['a 429', () => Promise.resolve(answer(429, null, { 'Retry-After': '3' }))],
    ['a network fault', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ] as const)('never retries by itself (%s)', async (_name, impl) => {
    for (const name of SEND_NAMES) {
      const { client, fetchMock } = clientWith(impl);
      await SENDS[name](client);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe('RT-1209 shift sync wire: faults before an answer', () => {
  it.each([
    ['a network fault', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['an abort', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
  ] as const)('%s → no_connection, on every send', async (_name, impl) => {
    for (const name of SEND_NAMES) {
      const { client, observe } = clientWith(impl);
      await expect(SENDS[name](client)).resolves.toEqual({ kind: 'no_connection' });
      expect(observe).not.toHaveBeenCalled();
    }
  });
});

describe('RT-1209 shift sync wire: an answer whose body cannot be read', () => {
  it.each([
    ['201', () => brokenBody(201), { kind: 'ok' }],
    ['200 replay', () => brokenBody(200, { 'Idempotent-Replayed': 'true' }), { kind: 'ok' }],
    ['500', () => brokenBody(500), { kind: 'transient' }],
    [
      '429 + Retry-After',
      () => brokenBody(429, { 'Retry-After': '4' }),
      { kind: 'transient', retryAfterMs: 4_000 },
    ],
    ['401', () => brokenBody(401), { kind: 'device_unauthorized' }],
    ['403', () => brokenBody(403), { kind: 'rejected', reason: 'cashier_claim_refused' }],
    ['409', () => brokenBody(409), { kind: 'rejected', reason: 'rejected' }],
    ['422', () => brokenBody(422), { kind: 'rejected', reason: 'rejected' }],
  ] as const)('device %s → %j, never no_connection', async (_name, make, expected) => {
    const { client, observe } = clientWith(() => Promise.resolve(make()));
    await expect(SENDS.closeShift(client)).resolves.toEqual(expected);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['201', () => brokenBody(201), { kind: 'ok' }],
    ['401', () => brokenBody(401), { kind: 'envelope_unauthorized' }],
    ['403', () => brokenBody(403), { kind: 'rejected', reason: 'rejected' }],
    ['404', () => brokenBody(404), { kind: 'rejected', reason: 'rejected' }],
  ] as const)('envelope %s → %j', async (_name, make, expected) => {
    const { client, observe } = clientWith(() => Promise.resolve(make()));
    await expect(SENDS.sendEnvelope(client)).resolves.toEqual(expected);
    expect(observe).not.toHaveBeenCalled();
  });
});

describe('RT-1209 shift sync wire: response classes', () => {
  it.each([
    [201, null, {}, { kind: 'ok' }],
    [200, '{"shiftId":"x"}', {}, { kind: 'ok' }],
    [204, null, {}, { kind: 'transient' }],
    [302, null, {}, { kind: 'transient' }],
    [425, null, { 'Retry-After': '2' }, { kind: 'transient', retryAfterMs: 2_000 }],
    [429, null, {}, { kind: 'transient' }],
    [503, null, { 'Retry-After': '60' }, { kind: 'transient' }],
    [401, refusal('unauthorized'), {}, { kind: 'device_unauthorized' }],
    [403, refusal('shift_closed'), {}, { kind: 'rejected', reason: 'cashier_claim_refused' }],
    [409, refusal('shift_force_closed'), {}, { kind: 'rejected', reason: 'shift_force_closed' }],
    [422, refusal('currency_mismatch'), {}, { kind: 'rejected', reason: 'currency_mismatch' }],
    [404, refusal('shift_closed'), {}, { kind: 'rejected', reason: 'rejected' }],
    [400, '<html>', {}, { kind: 'rejected', reason: 'rejected' }],
  ] as const)('device %i %s → %j', async (status, body, headers, expected) => {
    const { client, observe } = clientWith(() =>
      Promise.resolve(answer(status, body, headers as Record<string, string>)),
    );
    await expect(SENDS.closeShift(client)).resolves.toEqual(expected);
    expect(observe).toHaveBeenCalledExactlyOnceWith('sale_sync', status);
  });

  it('never puts a credential or server text in a result', async () => {
    for (const name of SEND_NAMES) {
      const { client } = clientWith(() =>
        Promise.resolve(answer(409, refusal(`leak ${DEVICE} ${ENVELOPE}`))),
      );
      const text = JSON.stringify(await SENDS[name](client));
      expect(text).not.toContain(DEVICE);
      expect(text).not.toContain(ENVELOPE);
      expect(text).not.toContain('leak');
    }
  });
});
