/**
 * RT-1490 — the `posCaptureItem` client: one POST to Backend-Core
 * `/api/pos/v1/catalog/unknown-items` with the operator envelope, the row's
 * key as `Idempotency-Key`, and the contract body (barcode only).
 *
 * Status table: 2xx → accepted; 401 / 403 → unauthorized; 404 / 408 / 425 /
 * 429 / 5xx → retry; every other 4xx (400, 409 key conflict, 422) → refused
 * for good; no answer → unreachable. No envelope → no request.
 */
import { describe, expect, it, vi } from 'vitest';

import { createUnknownItemCaptureClient } from '../capture-client.js';

const KEY = '0192f5a2-3b4c-7d8e-9f01-000000000001';

function fetchAnswering(status: number) {
  return vi.fn(() => Promise.resolve(new Response('{}', { status })));
}

function clientWith(fetch: ReturnType<typeof vi.fn>) {
  return createUnknownItemCaptureClient({
    baseUrl: 'https://api.test/',
    fetch: fetch as never,
  });
}

describe('RT-1490 — unknown item capture client', () => {
  it('posts the contract request: path, bearer, idempotency key, barcode-only body', async () => {
    const fetch = fetchAnswering(201);
    await clientWith(fetch).send({ captureId: KEY, barcode: '6221000000099', envelope: 'env-1' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/pos/v1/catalog/unknown-items');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Idempotency-Key': KEY,
      Authorization: 'Bearer env-1',
    });
    // No source_system (null for barcode), no sale_context (held back in v1),
    // no tenant / store / device (the principal supplies them).
    expect(JSON.parse(init.body as string)).toEqual({
      identifier_type: 'barcode',
      identifier_value: '6221000000099',
    });
  });

  it('sends nothing without an envelope', async () => {
    const fetch = fetchAnswering(201);
    const outcome = await clientWith(fetch).send({ captureId: KEY, barcode: '1', envelope: '' });
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unreachable' });
  });

  it.each([
    [200, 'accepted'],
    [201, 'accepted'],
    [400, 'refused'],
    [409, 'refused'],
    [422, 'refused'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'retry'],
    [408, 'retry'],
    [425, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
  ])('maps %i to %s', async (status, kind) => {
    const outcome = await clientWith(fetchAnswering(status)).send({
      captureId: KEY,
      barcode: '1',
      envelope: 'env-1',
    });
    expect(outcome).toEqual({ kind, status });
  });

  it('reports a network fault as unreachable and never throws', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const outcome = await clientWith(fetch).send({ captureId: KEY, barcode: '1', envelope: 'e' });
    expect(outcome).toEqual({ kind: 'unreachable' });
  });
});
