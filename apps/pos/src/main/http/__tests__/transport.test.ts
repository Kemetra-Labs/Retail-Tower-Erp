import { describe, expect, it, vi } from 'vitest';

import { withRequestId } from '../../observability/request-id.js';
import { createBackendTransport, statusOutcome, type BackendTransportDeps } from '../transport.js';

const BASE = 'https://bc.test/';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  return vi.fn<BackendTransportDeps['fetch']>(() =>
    Promise.resolve(new Response(body, { status, headers })),
  );
}

function transportOf(
  fetch: BackendTransportDeps['fetch'],
  extra: Partial<BackendTransportDeps> = {},
) {
  return createBackendTransport({
    baseUrl: BASE,
    fetch,
    timeoutMs: 15_000,
    maxBodyBytes: 100,
    ...extra,
  });
}

function initOf(fetch: ReturnType<typeof respond>): RequestInit {
  return fetch.mock.calls[0]?.[1] as RequestInit;
}

describe('RT-880 backend transport — request', () => {
  it('joins the base URL (trailing slash dropped) and the path, query included', async () => {
    const fetch = respond(200, '{}');
    await transportOf(fetch).send({ method: 'GET', path: '/api/x?a=1', bearer: 't' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://bc.test/api/x?a=1');
  });

  it('sends the bearer token after the caller headers, and the body as given', async () => {
    const fetch = respond(201, '{}');
    await transportOf(fetch).send({
      method: 'POST',
      path: '/api/x',
      bearer: 'tok',
      headers: { 'Content-Type': 'application/json', Authorization: 'spoofed' },
      body: '{"a":1}',
    });
    const init = initOf(fetch);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok',
    });
  });

  it('omits the body key on a request without one', async () => {
    const fetch = respond(200, '{}');
    await transportOf(fetch).send({ method: 'GET', path: '/api/x', bearer: 't' });
    expect(initOf(fetch)).not.toHaveProperty('body');
    expect(initOf(fetch).headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('makes no request without a bearer token', async () => {
    const fetch = respond(200, '{}');
    expect(await transportOf(fetch).send({ method: 'GET', path: '/api/x', bearer: '' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('arms the per-call timeout signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = respond(200, '{}');
    await transportOf(fetch, { timeoutMs: 1234 }).send({ method: 'GET', path: '/x', bearer: 't' });
    expect(timeout).toHaveBeenCalledWith(1234);
    expect(initOf(fetch).signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it('answers null when the timeout fires', async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const answer = await transportOf(fetch, { timeoutMs: 5 }).send({
      method: 'GET',
      path: '/x',
      bearer: 't',
    });
    expect(answer).toBeNull();
  });
});

describe('RT-880 backend transport — request-id', () => {
  it('does not mint X-Request-Id itself (the shared base fetch does, once)', async () => {
    const fetch = respond(200, '{}');
    await transportOf(fetch).send({ method: 'GET', path: '/x', bearer: 't' });
    expect(initOf(fetch).headers).not.toHaveProperty('X-Request-Id');
  });

  it('carries the X-Request-Id of a withRequestId-wrapped fetch', async () => {
    const raw = respond(200, '{}');
    const logger = { info: vi.fn(), debug: vi.fn() };
    const fetch = withRequestId(raw, { logger });
    await transportOf(fetch).send({ method: 'GET', path: '/x', bearer: 't' });
    const headers = initOf(raw).headers as Headers;
    expect(headers.get('X-Request-Id')).toMatch(UUID_V4);
    expect(headers.get('Authorization')).toBe('Bearer t');
  });
});

describe('RT-880 backend transport — answer', () => {
  it('returns the status and the parsed JSON body', async () => {
    const answer = await transportOf(respond(404, '{"code":"x"}')).send({
      method: 'GET',
      path: '/x',
      bearer: 't',
    });
    expect(answer).toEqual({ status: 404, json: { code: 'x' } });
  });

  it('returns json undefined for an empty or non-JSON body', async () => {
    const empty = await transportOf(respond(500, '')).send({
      method: 'GET',
      path: '/x',
      bearer: 't',
    });
    expect(empty).toEqual({ status: 500, json: undefined });
    const html = await transportOf(respond(502, '<html>')).send({
      method: 'GET',
      path: '/x',
      bearer: 't',
    });
    expect(html).toEqual({ status: 502, json: undefined });
  });

  it('returns json undefined for a null body (no stream)', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const answer = await transportOf(fetch).send({ method: 'GET', path: '/x', bearer: 't' });
    expect(answer).toEqual({ status: 204, json: undefined });
  });

  it('skips a body whose Content-Length is over the cap', async () => {
    const fetch = respond(200, '{}', { 'content-length': '101' });
    const answer = await transportOf(fetch).send({ method: 'GET', path: '/x', bearer: 't' });
    expect(answer).toEqual({ status: 200, json: undefined });
  });

  it('stops reading a streamed body past the cap, counting bytes not characters', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // 30 Arabic letters: 30 characters, 60 bytes.
        controller.enqueue(new TextEncoder().encode('م'.repeat(30)));
        if (pulled > 10) controller.close();
      },
    });
    const fetch = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));
    const answer = await transportOf(fetch).send({ method: 'GET', path: '/x', bearer: 't' });
    expect(answer).toEqual({ status: 200, json: undefined });
    expect(pulled).toBeLessThanOrEqual(3);
  });

  it('reads a body at the cap exactly', async () => {
    const body = `"${'a'.repeat(98)}"`;
    const answer = await transportOf(respond(200, body)).send({
      method: 'GET',
      path: '/x',
      bearer: 't',
    });
    expect(answer).toEqual({ status: 200, json: 'a'.repeat(98) });
  });

  it('answers null on a network failure, never throwing', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    expect(await transportOf(fetch).send({ method: 'GET', path: '/x', bearer: 't' })).toBeNull();
  });

  it('answers null when the body stream fails mid-read', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('reset'));
      },
    });
    const fetch = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));
    expect(await transportOf(fetch).send({ method: 'GET', path: '/x', bearer: 't' })).toBeNull();
  });
});

describe('RT-880 statusOutcome', () => {
  const TABLE = { 400: 'invalid', 401: 'unauthorized' } as const;

  it('maps a listed status and falls back for any other', () => {
    expect(statusOutcome(401, TABLE, 'server_error')).toBe('unauthorized');
    expect(statusOutcome(429, TABLE, 'server_error')).toBe('server_error');
  });
});
