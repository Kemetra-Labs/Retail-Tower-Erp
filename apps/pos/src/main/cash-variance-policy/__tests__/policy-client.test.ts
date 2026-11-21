/**
 * RT-388 — the device read client (`posGetCashVariancePolicy`): the request it
 * sends and the closed outcome of every answer.
 */
import { describe, expect, it } from 'vitest';

import { createPolicyClient, POLICY_PATH } from '../policy-client.js';

const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const ETAG = '"7b3c5f"';
const OK_BODY = {
  policySource: 'tenant',
  policyRevisionId: REVISION,
  policyValue: { mode: 'limit', limitAmount: '100.00', currencyCode: 'EGP' },
  serverTime: '2026-11-21T10:00:00.000Z',
};

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

function clientAnswering(answer: () => Response | Promise<Response>): {
  client: ReturnType<typeof createPolicyClient>;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const client = createPolicyClient({
    baseUrl: 'https://api.test/',
    fetch: (input, init) => {
      seen.push({
        url: input instanceof Request ? input.url : input.toString(),
        method: init?.method,
        headers: { ...(init?.headers as Record<string, string>) },
      });
      return Promise.resolve(answer());
    },
  });
  return { client, seen };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('createPolicyClient.read', () => {
  it('sends a device-bearer GET to the store policy path, without If-None-Match first', async () => {
    const { client, seen } = clientAnswering(() => json(200, OK_BODY, { ETag: ETAG }));
    await client.read('device-token', null);
    expect(POLICY_PATH).toBe('/api/pos/v1/store/cash-variance-policy');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://api.test${POLICY_PATH}`);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers['Authorization']).toBe('Bearer device-token');
    expect(seen[0]?.headers['If-None-Match']).toBeUndefined();
  });

  it('sends the last ETag as If-None-Match', async () => {
    const { client, seen } = clientAnswering(() => new Response(null, { status: 304 }));
    await client.read('device-token', ETAG);
    expect(seen[0]?.headers['If-None-Match']).toBe(ETAG);
  });

  it('answers ok with the policy and the ETag', async () => {
    const { client } = clientAnswering(() => json(200, OK_BODY, { ETag: ETAG }));
    const outcome = await client.read('device-token', null);
    expect(outcome).toEqual({
      kind: 'ok',
      policy: {
        policy: {
          source: 'tenant',
          revisionId: REVISION,
          mode: 'limit',
          limitAmount: '100.00',
          currencyCode: 'EGP',
        },
        serverTime: OK_BODY.serverTime,
      },
      etag: ETAG,
    });
  });

  it('answers ok with a null ETag when the answer carries none (the policy is still good)', async () => {
    const { client } = clientAnswering(() => json(200, OK_BODY));
    expect(await client.read('device-token', null)).toMatchObject({ kind: 'ok', etag: null });
  });

  it('answers not_modified to a conditional 304', async () => {
    const { client } = clientAnswering(() => new Response(null, { status: 304 }));
    expect(await client.read('device-token', ETAG)).toEqual({ kind: 'not_modified' });
  });

  it('never trusts a 304 to an unconditional read', async () => {
    const { client } = clientAnswering(() => new Response(null, { status: 304 }));
    expect(await client.read('device-token', null)).toEqual({ kind: 'unreadable' });
  });

  it('answers unreadable for a 200 that is off-contract or not JSON', async () => {
    const off = clientAnswering(() => json(200, { ...OK_BODY, policySource: 'fallback' }));
    expect(await off.client.read('device-token', null)).toEqual({ kind: 'unreadable' });
    const notJson = clientAnswering(() => new Response('<html>', { status: 200 }));
    expect(await notJson.client.read('device-token', null)).toEqual({ kind: 'unreadable' });
  });

  it('answers unauthorized for a 401', async () => {
    const { client } = clientAnswering(() => json(401, { error: { code: 'unauthorized' } }));
    expect(await client.read('device-token', null)).toEqual({ kind: 'unauthorized' });
  });

  it.each([400, 404, 500, 503])('answers server_error for a %i', async (status) => {
    const { client } = clientAnswering(() => json(status, {}));
    expect(await client.read('device-token', null)).toEqual({ kind: 'server_error' });
  });

  it('answers unreachable on a network fault', async () => {
    const { client } = clientAnswering(() => {
      throw new TypeError('fetch failed');
    });
    expect(await client.read('device-token', null)).toEqual({ kind: 'unreachable' });
  });

  it('sends nothing without a device token', async () => {
    const { client, seen } = clientAnswering(() => json(200, OK_BODY));
    expect(await client.read('', null)).toEqual({ kind: 'unreachable' });
    expect(seen).toHaveLength(0);
  });
});
