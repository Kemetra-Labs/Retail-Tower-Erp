import { describe, expect, it, vi } from 'vitest';

import { createBackendTransport } from '../../http/transport.js';
import { ROTATE_PATH, createRotationClient } from '../rotation-client.js';

const BASE = 'https://backend.example';
const OLD = 'old-' + 'x'.repeat(20);
const NEW = 'new-' + 'y'.repeat(20);
const KEY = 'rt373-key-0000000000000001';

function clientAnswering(respond: () => Response | Promise<Response>) {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => respond(),
  );
  const transport = createBackendTransport({
    baseUrl: BASE,
    fetch,
    timeoutMs: 1000,
    maxBodyBytes: 4096,
  });
  return { fetch, client: createRotationClient({ transport }) };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('RT-373 posRotateTerminalToken client', () => {
  it('POSTs the rotate route with the held token as bearer and a fresh Idempotency-Key, no body', async () => {
    const { fetch, client } = clientAnswering(() =>
      json(200, { device_token: NEW, expires_at: '2027-03-01T00:00:00.000Z' }),
    );
    await client.rotate(OLD, KEY);
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error('no call');
    const [url, init] = call;
    expect(url).toBe(`${BASE}${ROTATE_PATH}`);
    expect(ROTATE_PATH).toBe('/api/pos/v1/terminals/rotate');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${OLD}`);
    expect(headers['Idempotency-Key']).toBe(KEY);
  });

  it('200 → rotated, with the new token and expiry', async () => {
    const { client } = clientAnswering(() =>
      json(200, { device_token: NEW, expires_at: '2027-03-01T00:00:00.000Z' }),
    );
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({
      kind: 'rotated',
      token: NEW,
      expiresAt: '2027-03-01T00:00:00.000Z',
    });
  });

  it('a 200 without a usable token is a lost response (retry with the held token)', async () => {
    const { client } = clientAnswering(() => json(200, { expires_at: 'x' }));
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({ kind: 'retryable' });
  });

  it('a 200 with an unreadable expiry keeps the token and learns no expiry', async () => {
    const { client } = clientAnswering(() => json(200, { device_token: NEW, expires_at: 'later' }));
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({
      kind: 'rotated',
      token: NEW,
      expiresAt: null,
    });
  });

  it('401 → unauthorized (re-pair, RT-138 L6)', async () => {
    const { client } = clientAnswering(() => json(401, { error: { code: 'unauthorized' } }));
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({ kind: 'unauthorized' });
  });

  it('429 → rate limited for Retry-After seconds', async () => {
    const { client } = clientAnswering(() => json(429, {}, { 'Retry-After': '120' }));
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({
      kind: 'rate_limited',
      retryAfterMs: 120_000,
    });
  });

  it('429 without a usable Retry-After waits a default', async () => {
    const { client } = clientAnswering(() => json(429, {}));
    const result = await client.rotate(OLD, KEY);
    expect(result).toMatchObject({ kind: 'rate_limited' });
  });

  it.each([500, 502, 503, 425])('%i → retryable', async (status) => {
    const { client } = clientAnswering(() => json(status, {}));
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({ kind: 'retryable' });
  });

  it('a transport fault → retryable', async () => {
    const { client } = clientAnswering(() => {
      throw new TypeError('network');
    });
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({ kind: 'retryable' });
  });

  it.each([400, 409, 404])('%i → rejected (never retried with the same key)', async (status) => {
    const { client } = clientAnswering(() => json(status, {}));
    await expect(client.rotate(OLD, KEY)).resolves.toEqual({ kind: 'rejected', status });
  });
});
