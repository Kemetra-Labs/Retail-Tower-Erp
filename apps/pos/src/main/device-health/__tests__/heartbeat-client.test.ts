import { describe, expect, it } from 'vitest';

import { DEVICE_HEARTBEAT_PATH, createHeartbeatClient } from '../heartbeat-client.js';
import type { DeviceHeartbeatReport } from '../heartbeat-wire.js';

/**
 * RT-1312 Phase 1 — the heartbeat client on the shared Backend-Core transport
 * (RT-880): one POST with the device bearer, and a closed set of outcomes.
 * It never throws, whatever the answer.
 */

const BASE = 'https://bc.test/';
const BODY: DeviceHeartbeatReport = {
  app_version: null,
  source_clock_at: '2026-11-10T12:00:00.000Z',
};
const ACK = {
  acknowledged_at: '2026-11-10T12:00:01.000Z',
  pos_contract_revision: 2,
  policy: null,
  min_supported_grace_until: null,
  compliance: 'unknown',
};

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function answering(respond: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return Promise.resolve().then(respond);
  };
  return { client: createHeartbeatClient({ baseUrl: BASE, fetch }), sent };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createHeartbeatClient().report', () => {
  it('POSTs the body as JSON with the device bearer to the contract path', async () => {
    const { client, sent } = answering(() => json(200, ACK));
    await client.report('device-token', BODY);
    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only?.url).toBe(`https://bc.test${DEVICE_HEARTBEAT_PATH}`);
    expect(DEVICE_HEARTBEAT_PATH).toBe('/api/pos/v1/terminals/heartbeat');
    expect(only?.init?.method).toBe('POST');
    const headers = only?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer device-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(only?.init?.body as string)).toEqual(BODY);
  });

  it('reads the revision of a 200 HeartbeatAck', async () => {
    const { client } = answering(() => json(200, ACK));
    expect(await client.report('t', BODY)).toEqual({
      kind: 'acked',
      status: 200,
      posContractRevision: 2,
    });
  });

  it('reports a 200 that is not a HeartbeatAck as unreadable', async () => {
    const { client } = answering(() => json(200, { ok: true }));
    expect(await client.report('t', BODY)).toEqual({ kind: 'unreadable', status: 200 });
  });

  it.each([
    [400, 'rejected'],
    [401, 'unauthorized'],
    [500, 'server_error'],
    [503, 'server_error'],
    [429, 'server_error'],
  ])('maps %s to %s', async (status, kind) => {
    const { client } = answering(() => json(status, { error: { code: 'x', message: 'y' } }));
    expect(await client.report('t', BODY)).toEqual({ kind, status });
  });

  it('maps a network fault to unreachable without throwing', async () => {
    const { client } = answering(() => Promise.reject(new TypeError('fetch failed')));
    expect(await client.report('t', BODY)).toEqual({ kind: 'unreachable' });
  });

  it('sends nothing without a token', async () => {
    const { client, sent } = answering(() => json(200, ACK));
    expect(await client.report('', BODY)).toEqual({ kind: 'unreachable' });
    expect(sent).toHaveLength(0);
  });
});
