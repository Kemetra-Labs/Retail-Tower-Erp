/**
 * RT-1498 close slice — the Backend-Core return status read client
 * (`readReturnStatusByProvenance`, RT-1548: `GET /api/pos/v1/sales/{saleRef}/returns/by-provenance/status`).
 *
 * A verdict is ONLY a 200 whose body is `recorded` or `not_recorded`. Everything else is not one:
 *   • 404 is "unavailable" (the returns gate or the status read's own rollout gate is off, or the sale is
 *     out of scope): never `not_recorded`, so a close stays unavailable;
 *   • a 5xx, a 429, a network fault, a timeout, a 401/403 or an unreadable body is "no verdict".
 * The operator envelope is the bearer (the same `operatorAuthorization` as `readSale`); no envelope, no
 * request. Never throws.
 */
import { describe, expect, it } from 'vitest';

import { createReturnsStatusClient } from '../returns-status-client.js';
import { RETURN_SOURCE_SYSTEM } from '../returns-quote.js';
import {
  RETURN_REF,
  SALE_REF,
  ENVELOPE,
  omit,
  saleReturnFor,
} from './__helpers__/returns-fixture.js';

const EXTERNAL_ID = 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-aaaaaaaaaaaa';
const LINE = '0190f5a2-7b3c-7d4e-8f90-00000000000a';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientAnswering(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const client = createReturnsStatusClient({
    baseUrl: 'https://backend.example.invalid/',
    fetch: async (input, init) => {
      seen.push({
        url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
        method: init?.method ?? 'GET',
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });
      return await answer();
    },
  });
  return { client, seen };
}

const READ = { saleRef: SALE_REF, sourceSystem: RETURN_SOURCE_SYSTEM, externalId: EXTERNAL_ID };

function recordedBody(creditLinked = false) {
  const saleReturn = saleReturnFor({
    externalId: EXTERNAL_ID,
    lines: [{ lineRef: LINE, quantity: '1' }],
    refundTenders: [{ method: 'cash', amount: '35.0000' }],
  });
  return { status: 'recorded', creditLinked, saleReturn: { ...saleReturn, returnRef: RETURN_REF } };
}

describe('the request', () => {
  it('is a GET of the sale-scoped status route with the provenance as the query and the envelope as bearer', async () => {
    const { client, seen } = clientAnswering(() => json(200, { status: 'not_recorded' }));
    await client.readStatus(READ, ENVELOPE);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(
      `https://backend.example.invalid/api/pos/v1/sales/${SALE_REF}/returns/by-provenance/status`,
    );
    expect(url.searchParams.get('sourceSystem')).toBe(RETURN_SOURCE_SYSTEM);
    expect(url.searchParams.get('externalId')).toBe(EXTERNAL_ID);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers['Authorization']).toBe(`Bearer ${ENVELOPE}`);
  });

  it('sends nothing without an envelope', async () => {
    for (const envelope of [null, '']) {
      const { client, seen } = clientAnswering(() => json(200, { status: 'not_recorded' }));
      await expect(client.readStatus(READ, envelope)).resolves.toEqual({
        kind: 'no_verdict',
        cause: 'unauthorized',
      });
      expect(seen).toHaveLength(0);
    }
  });

  it('sends nothing for a sale ref that is not a UUID, and says unavailable', async () => {
    const { client, seen } = clientAnswering(() => json(200, { status: 'not_recorded' }));
    await expect(client.readStatus({ ...READ, saleRef: '../../x' }, ENVELOPE)).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(seen).toHaveLength(0);
  });

  it('encodes the provenance in the query, never in the path', async () => {
    const { client, seen } = clientAnswering(() => json(200, { status: 'not_recorded' }));
    await client.readStatus({ ...READ, externalId: 'a b&c=d' }, ENVELOPE);
    expect(new URL(seen[0]?.url ?? '').searchParams.get('externalId')).toBe('a b&c=d');
    expect(seen[0]?.url).toContain('externalId=a+b%26c%3Dd');
  });
});

describe('the verdicts', () => {
  it('200 not_recorded is the affirmative verdict', async () => {
    const { client } = clientAnswering(() => json(200, { status: 'not_recorded' }));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({ kind: 'not_recorded' });
  });

  it('200 recorded carries the return and the creditLinked flag', async () => {
    const { client } = clientAnswering(() => json(200, recordedBody(false)));
    const out = await client.readStatus(READ, ENVELOPE);
    expect(out).toMatchObject({
      kind: 'recorded',
      creditLinked: false,
      saleReturn: { externalId: EXTERNAL_ID, saleRef: SALE_REF, returnRef: RETURN_REF },
    });
  });

  it('200 recorded creditLinked is read as true', async () => {
    const { client } = clientAnswering(() => json(200, recordedBody(true)));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toMatchObject({
      kind: 'recorded',
      creditLinked: true,
    });
  });

  it('reads the zero-refund credit shape (an empty refundTenders)', async () => {
    const body = recordedBody(true);
    const zero = { ...body, saleReturn: { ...body.saleReturn, refundTenders: [] } };
    const { client } = clientAnswering(() => json(200, zero));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toMatchObject({
      kind: 'recorded',
      creditLinked: true,
    });
  });

  it('ignores additive keys it does not read', async () => {
    const { client } = clientAnswering(() => json(200, { status: 'not_recorded', extra: 1 }));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({ kind: 'not_recorded' });
  });
});

describe('what is not a verdict', () => {
  it('a 404 is unavailable, never not_recorded', async () => {
    const { client } = clientAnswering(() => json(404, { error: { code: 'not_found' } }));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('a 404 with a body that claims not_recorded is still unavailable', async () => {
    const { client } = clientAnswering(() => json(404, { status: 'not_recorded' }));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({ kind: 'unavailable' });
  });

  it.each([500, 502, 503, 504])('a %i is no verdict (server)', async (status) => {
    const { client } = clientAnswering(() => json(status, { error: { code: 'x' } }));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({
      kind: 'no_verdict',
      cause: 'server',
    });
  });

  it('a 429 and a 400 are no verdict (server)', async () => {
    for (const status of [429, 400, 302]) {
      const { client } = clientAnswering(() => json(status, {}));
      await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({
        kind: 'no_verdict',
        cause: 'server',
      });
    }
  });

  it.each([401, 403])('a %i is no verdict (unauthorized)', async (status) => {
    const { client } = clientAnswering(() => json(status, { error: { code: 'unauthorized' } }));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({
      kind: 'no_verdict',
      cause: 'unauthorized',
    });
  });

  it('a network fault and a timeout are no verdict (offline)', async () => {
    const network = clientAnswering(() => Promise.reject(new TypeError('ECONNREFUSED')));
    await expect(network.client.readStatus(READ, ENVELOPE)).resolves.toEqual({
      kind: 'no_verdict',
      cause: 'offline',
    });
    const timeout = clientAnswering(() => Promise.reject(new DOMException('t', 'TimeoutError')));
    await expect(timeout.client.readStatus(READ, ENVELOPE)).resolves.toEqual({
      kind: 'no_verdict',
      cause: 'offline',
    });
  });

  it.each([
    ['an unknown status value', { status: 'unknown_yet' }],
    ['a recorded body with no creditLinked flag', omit(recordedBody(), 'creditLinked')],
    [
      'a recorded body whose creditLinked is not a boolean',
      { ...recordedBody(), creditLinked: 'no' },
    ],
    [
      'a recorded body with no readable return',
      { status: 'recorded', creditLinked: false, saleReturn: {} },
    ],
    ['a body that is not an object', 'not_recorded'],
    ['an empty object', {}],
    ['a null body', null],
  ])('a 200 with %s is no verdict (unreadable)', async (_name, body) => {
    const { client } = clientAnswering(() => json(200, body));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({
      kind: 'no_verdict',
      cause: 'unreadable',
    });
  });

  it('a 200 whose body is not JSON is no verdict (unreadable)', async () => {
    const { client } = clientAnswering(() => new Response('<html>', { status: 200 }));
    await expect(client.readStatus(READ, ENVELOPE)).resolves.toEqual({
      kind: 'no_verdict',
      cause: 'unreadable',
    });
  });
});
