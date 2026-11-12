import { describe, expect, it, vi } from 'vitest';

import { createBackendTransport, type BackendTransportDeps } from '../transport.js';

function transportOf(fetch: BackendTransportDeps['fetch']) {
  return createBackendTransport({
    baseUrl: 'https://bc.test/',
    fetch,
    timeoutMs: 15_000,
    maxBodyBytes: 100,
  });
}

describe('RT-1339 backend transport — response headers', () => {
  it('hands back only the listed headers, by lower-case name', async () => {
    const fetch = vi.fn<BackendTransportDeps['fetch']>(() =>
      Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: { ETag: '"abc"', 'X-Server-Time': 'T', 'X-Other': 'no' },
        }),
      ),
    );
    const answer = await transportOf(fetch).send({
      method: 'GET',
      path: '/api/x',
      bearer: 't',
      readHeaders: ['etag', 'x-server-time', 'x-absent'],
    });
    expect(answer).toEqual({
      status: 200,
      json: {},
      headers: { etag: '"abc"', 'x-server-time': 'T' },
    });
  });

  it('reads the headers of a 304, which has no body', async () => {
    const fetch = vi.fn<BackendTransportDeps['fetch']>(() =>
      Promise.resolve(new Response(null, { status: 304, headers: { 'X-Server-Time': 'T' } })),
    );
    const answer = await transportOf(fetch).send({
      method: 'GET',
      path: '/api/x',
      bearer: 't',
      readHeaders: ['x-server-time'],
    });
    expect(answer).toEqual({ status: 304, json: undefined, headers: { 'x-server-time': 'T' } });
  });

  it('without readHeaders the answer is exactly what it was before (no headers key)', async () => {
    const fetch = vi.fn<BackendTransportDeps['fetch']>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const answer = await transportOf(fetch).send({ method: 'GET', path: '/api/x', bearer: 't' });
    expect(answer).toEqual({ status: 200, json: {} });
  });
});
