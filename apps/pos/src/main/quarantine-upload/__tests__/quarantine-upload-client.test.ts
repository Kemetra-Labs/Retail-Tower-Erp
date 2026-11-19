/**
 * RT-1312 Phase 3(c) — the Backend-Core `posQuarantineSale` client
 * (`POST /api/pos/v1/quarantined-sales`, `pos-sales/sale-quarantine.yaml`).
 *
 * The contract's answer table, as the till reads it:
 *   200 / 201                          → uploaded (Backend-Core holds the sale)
 *   400 / 409 / 413                    → refused: terminal for this upload
 *   401 / 404 / 408 / 425 / 429 / 5xx  → retry (404: an older Backend-Core
 *                                        without the route; 429: `Retry-After`)
 *   no answer                          → unreachable
 * A status the contract does not name: another 4xx is refused (it is about this
 * sale, retrying cannot fix it); anything else is retried (never lose a sale).
 * The request carries the DEVICE bearer, no `Idempotency-Key` (natural
 * idempotency on the provenance), and the body verbatim.
 */
import { describe, expect, it } from 'vitest';

import {
  createQuarantineUploadClient,
  type QuarantineUploadBody,
} from '../quarantine-upload-client.js';

const TOKEN = 'device-token-sentinel';
const BASE = 'https://backend-core.test';

const BODY: QuarantineUploadBody = {
  sourceSystem: 'pos-pulse',
  externalId: 'pos-pulse:handoff-1',
  idempotencyKey: 'pos-pulse:handoff-1',
  reason: { kind: 'refused', httpStatus: null, errorCode: null },
  tillRecordedAt: '2026-11-19T10:00:00.000Z',
  previousTerminalId: null,
  saleBody: { sourceSystem: 'pos-pulse', externalId: 'pos-pulse:handoff-1', posTotal: '10.00' },
};

interface Seen {
  url: string;
  init: RequestInit;
}

function clientAnswering(
  status: number,
  init: { json?: unknown; headers?: Record<string, string> } = {},
) {
  const seen: Seen[] = [];
  const client = createQuarantineUploadClient({
    baseUrl: BASE,
    nowMs: () => Date.parse('2026-11-19T10:00:00.000Z'),
    fetch: (input, requestInit) => {
      seen.push({
        url: input instanceof Request ? input.url : input.toString(),
        init: requestInit ?? {},
      });
      return Promise.resolve(
        new Response(init.json === undefined ? null : JSON.stringify(init.json), {
          status,
          headers: init.headers ?? {},
        }),
      );
    },
  });
  return { client, seen };
}

describe('quarantine upload client — the request', () => {
  it('posts the body verbatim to the route under the device bearer, with no Idempotency-Key', async () => {
    const { client, seen } = clientAnswering(201);
    await client.upload(TOKEN, BODY);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${BASE}/api/pos/v1/quarantined-sales`);
    expect(seen[0]?.init.method).toBe('POST');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('idempotency-key');
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual(BODY);
  });

  it('sends nothing without a device token', async () => {
    const { client, seen } = clientAnswering(201);
    expect(await client.upload('', BODY)).toEqual({ kind: 'unreachable' });
    expect(seen).toHaveLength(0);
  });
});

describe('quarantine upload client — the answers', () => {
  const receipt = {
    quarantineRef: '0192f5a2-3b4c-7d8e-9f01-000000000001',
    state: 'open',
    receivedAt: '2026-11-19T10:00:01.000Z',
  };

  it.each([200, 201])('%i → uploaded, with the receipt', async (status) => {
    const { client } = clientAnswering(status, { json: receipt });
    expect(await client.upload(TOKEN, BODY)).toEqual({
      kind: 'uploaded',
      status,
      receipt: { quarantineRef: receipt.quarantineRef, state: 'open' },
    });
  });

  it('an unreadable 201 body is still uploaded, with no receipt', async () => {
    const { client } = clientAnswering(201, { json: { nonsense: true } });
    expect(await client.upload(TOKEN, BODY)).toEqual({
      kind: 'uploaded',
      status: 201,
      receipt: null,
    });
  });

  it.each([400, 409, 413])('%i → refused for good', async (status) => {
    const { client } = clientAnswering(status);
    expect(await client.upload(TOKEN, BODY)).toEqual({ kind: 'refused', status });
  });

  it.each([401, 404, 408, 425, 500, 502, 503])('%i → retry', async (status) => {
    const { client } = clientAnswering(status);
    expect(await client.upload(TOKEN, BODY)).toEqual({ kind: 'retry', status });
  });

  it('429 → retry, honouring Retry-After', async () => {
    const { client } = clientAnswering(429, { headers: { 'Retry-After': '120' } });
    expect(await client.upload(TOKEN, BODY)).toEqual({
      kind: 'retry',
      status: 429,
      retryAfterMs: 120_000,
    });
  });

  it('429 without a readable Retry-After → retry with the normal backoff', async () => {
    const { client } = clientAnswering(429, { headers: { 'Retry-After': 'soon' } });
    expect(await client.upload(TOKEN, BODY)).toEqual({ kind: 'retry', status: 429 });
  });

  it('another 4xx the contract does not name is refused', async () => {
    const { client } = clientAnswering(422);
    expect(await client.upload(TOKEN, BODY)).toEqual({ kind: 'refused', status: 422 });
  });

  it('a status outside 2xx / 4xx / 5xx is retried, never lost', async () => {
    const { client } = clientAnswering(302);
    expect(await client.upload(TOKEN, BODY)).toEqual({ kind: 'retry', status: 302 });
  });

  it('no answer → unreachable', async () => {
    const client = createQuarantineUploadClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(new Error('offline')),
    });
    expect(await client.upload(TOKEN, BODY)).toEqual({ kind: 'unreachable' });
  });
});
