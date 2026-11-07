import { describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_TERMINAL_TAG,
  captureTerminalIdOf,
  createTunnelRequestExecutor,
  type TunnelExecutorDeps,
} from '../tunnel-transport.js';

/**
 * RT-1253 scope 3 / R1 — the tunnel request executor behind the SDK's offline
 * transport. Rules (RT-1253 step 0, Q2): a status >= 400 is DROPPED by the offline
 * layer, a THROWN error is queued. So "cannot send now" (not wired yet) and a
 * network fault must throw; "never send this" (no token, another terminal, kill
 * switch) must resolve without sending.
 */

function envelope(tags: Record<string, unknown> | undefined): string {
  const header = JSON.stringify({ event_id: 'e1', sent_at: '2026-11-07T10:00:00.000Z' });
  const item = JSON.stringify({ type: 'event' });
  const event = JSON.stringify({ event_id: 'e1', ...(tags === undefined ? {} : { tags }) });
  return `${header}\n${item}\n${event}\n`;
}

const URL_ = 'https://api.example.com/api/pos/v1/telemetry/envelope';

function deps(over: Partial<TunnelExecutorDeps> = {}): TunnelExecutorDeps & {
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  return {
    isBound: () => true,
    isEnabled: () => true,
    tunnelUrl: URL_,
    readToken: () => Promise.resolve('tok-A'),
    currentTerminalId: () => 'term-A',
    fetch,
    timeoutMs: 5000,
    ...over,
  } as TunnelExecutorDeps & { fetch: ReturnType<typeof vi.fn> };
}

describe('captureTerminalIdOf', () => {
  it('reads the capture tag from the first event item', () => {
    expect(captureTerminalIdOf(envelope({ [CAPTURE_TERMINAL_TAG]: 'term-A' }))).toBe('term-A');
  });

  it('reads it from bytes as well', () => {
    const bytes = new TextEncoder().encode(envelope({ [CAPTURE_TERMINAL_TAG]: 'term-A' }));
    expect(captureTerminalIdOf(bytes)).toBe('term-A');
  });

  it.each([
    ['no tags', envelope(undefined)],
    ['a non-string tag', envelope({ [CAPTURE_TERMINAL_TAG]: 7 })],
    ['an empty tag', envelope({ [CAPTURE_TERMINAL_TAG]: '' })],
    ['garbage', 'not an envelope'],
    ['an empty body', ''],
  ])('%s -> null', (_name, body) => {
    expect(captureTerminalIdOf(body)).toBeNull();
  });
});

describe('createTunnelRequestExecutor', () => {
  const sendable = envelope({ [CAPTURE_TERMINAL_TAG]: 'term-A' });

  it('posts the envelope unchanged with the CURRENT device token on every send', async () => {
    let token = 'tok-A';
    const d = deps({ readToken: () => Promise.resolve(token) });
    const run = createTunnelRequestExecutor(d);
    await run({ body: sendable });
    token = 'tok-A2'; // a rotation between two sends
    await run({ body: sendable });

    const calls = d.fetch.mock.calls as [string, RequestInit][];
    const first = calls[0] as [string, RequestInit];
    const second = calls[1] as [string, RequestInit];
    expect(first[0]).toBe(URL_);
    expect(first[1].method).toBe('POST');
    expect(first[1].body).toBe(sendable);
    const headersOf = (init: RequestInit): Headers => new Headers(init.headers);
    expect(headersOf(first[1]).get('authorization')).toBe('Bearer tok-A');
    expect(headersOf(second[1]).get('authorization')).toBe('Bearer tok-A2');
    expect(headersOf(first[1]).get('content-type')).toBe('application/x-sentry-envelope');
    expect(headersOf(first[1]).has('content-encoding')).toBe(false);
  });

  it('answers with the status and the Retry-After of the tunnel (the SDK backs off on 429)', async () => {
    const d = deps();
    d.fetch.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    );
    const answer = await createTunnelRequestExecutor(d)({ body: sendable });
    expect(answer.statusCode).toBe(429);
    expect(answer.headers['retry-after']).toBe('30');
  });

  it('a 401 resolves (the offline layer drops it) and is never thrown', async () => {
    const d = deps();
    d.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    const answer = await createTunnelRequestExecutor(d)({ body: sendable });
    expect(answer.statusCode).toBe(401);
  });

  it('a network fault THROWS so the offline layer queues the envelope', async () => {
    const d = deps();
    d.fetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(createTunnelRequestExecutor(d)({ body: sendable })).rejects.toThrow();
  });

  it('not wired yet THROWS (the queue is kept for the next flush) and sends nothing', async () => {
    const d = deps({ isBound: () => false });
    await expect(createTunnelRequestExecutor(d)({ body: sendable })).rejects.toThrow();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('no sendable token DROPS without sending (unpaired or revoked)', async () => {
    const d = deps({ readToken: () => Promise.resolve(null) });
    const answer = await createTunnelRequestExecutor(d)({ body: sendable });
    expect(answer.statusCode).toBe(204);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('an event captured under terminal A is never sent with terminal B token (R1)', async () => {
    const d = deps({
      currentTerminalId: () => 'term-B',
      readToken: () => Promise.resolve('tok-B'),
    });
    const answer = await createTunnelRequestExecutor(d)({ body: sendable });
    expect(answer.statusCode).toBe(204);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('an envelope with no capture terminal tag is dropped', async () => {
    const d = deps();
    await createTunnelRequestExecutor(d)({ body: envelope({}) });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('the kill switch (config inert or never fetched) drops a queued envelope', async () => {
    const d = deps({ isEnabled: () => false });
    await createTunnelRequestExecutor(d)({ body: sendable });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('a throwing token read throws (queued), it never leaks the error text', async () => {
    const d = deps({ readToken: () => Promise.reject(new Error('secret-token-text')) });
    await expect(createTunnelRequestExecutor(d)({ body: sendable })).rejects.toThrow(
      'telemetry:token-read-failed',
    );
  });
});
