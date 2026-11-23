import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceTokenRotationStore, RotationCredential } from '../../pairing/store.js';
import type { PairingBinding } from '../../pairing/token-binding.js';
import {
  ROTATION_START_DELAY_MS,
  ROTATION_TICK_MS,
  registerDeviceTokenRotation,
} from '../device-token-rotation.js';

const BASE = 'https://backend.example';
const OLD = 'old-' + 'a'.repeat(24);
const NEW = 'new-' + 'b'.repeat(24);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2027-02-20T00:00:00.000Z');

function store(
  expiresAt: string | null,
): DeviceTokenRotationStore & { held: () => string; reads: () => number } {
  let cred: RotationCredential = {
    token: OLD,
    binding: { tenant_id: 't', branch_id: 'b', terminal_id: 'x', paired_at: 1 },
    expiresAt,
  };
  let readCount = 0;
  return {
    readRotationCredential: () => {
      readCount += 1;
      return Promise.resolve({ ...cred });
    },
    replaceRotatedToken: vi.fn((binding: PairingBinding, token: string, expires: string | null) => {
      cred = { token, binding, expiresAt: expires };
      return Promise.resolve('replaced' as const);
    }),
    held: () => cred.token,
    reads: () => readCount,
  };
}

function rotateAnswer(): Response {
  return new Response(
    JSON.stringify({ device_token: NEW, expires_at: '2027-05-30T00:00:00.000Z' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function harness(expiresAt: string | null) {
  const s = store(expiresAt);
  const stoppers = new Map<string, () => void>();
  const fetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    if (urlOf(input).endsWith('/api/pos/v1/terminals/rotate')) {
      return Promise.resolve(rotateAnswer());
    }
    return Promise.resolve(hinted());
  });
  function hinted(): Response {
    return new Response('{}', {
      status: 200,
      headers: {
        'X-Device-Token-Rotate-After': new Date(NOW - DAY).toISOString(),
        'X-Device-Token-Rotate-Stage': 'notice',
      },
    });
  }
  const wiring = registerDeviceTokenRotation({
    baseUrl: BASE,
    fetch,
    store: s,
    workerRegistry: {
      register: (name, stop) => {
        stoppers.set(name, stop);
      },
    },
  });
  return { s, fetch, wiring, stoppers };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function rotateCalls(fetch: { mock: { calls: Array<[RequestInfo | URL]> } }): number {
  return fetch.mock.calls.filter(([input]) => urlOf(input).endsWith('/api/pos/v1/terminals/rotate'))
    .length;
}

describe('RT-373 device token rotation wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first tick shortly after start rotates a due credential; then hourly', async () => {
    const h = harness(new Date(NOW + 10 * DAY).toISOString());
    expect(rotateCalls(h.fetch)).toBe(0);
    await vi.advanceTimersByTimeAsync(ROTATION_START_DELAY_MS);
    expect(rotateCalls(h.fetch)).toBe(1);
    expect(h.s.held()).toBe(NEW);
    expect(ROTATION_TICK_MS).toBe(60 * 60 * 1000);
  });

  it('a fresh credential is not rotated by the ticks', async () => {
    const h = harness(new Date(NOW + 60 * DAY).toISOString());
    await vi.advanceTimersByTimeAsync(ROTATION_START_DELAY_MS + 2 * ROTATION_TICK_MS);
    expect(rotateCalls(h.fetch)).toBe(0);
  });

  it('the returned fetch reads the RT-639 hint and rotates on a due one; the response is untouched', async () => {
    const h = harness(new Date(NOW + 60 * DAY).toISOString());
    const res = await h.wiring.fetch(`${BASE}/api/pos/v1/cashier-admissions/roster`);
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(rotateCalls(h.fetch)).toBe(1);
    });
  });

  it('registers a stop that ends the ticks', async () => {
    const h = harness(new Date(NOW + 10 * DAY).toISOString());
    h.stoppers.get('device token rotation')?.();
    await vi.advanceTimersByTimeAsync(ROTATION_START_DELAY_MS + ROTATION_TICK_MS);
    expect(rotateCalls(h.fetch)).toBe(0);
  });

  it('recoveryFirst is exposed for the RT-215 confirmation probe', async () => {
    const h = harness(new Date(NOW + 60 * DAY).toISOString());
    const probe = vi.fn(() => Promise.resolve('ok' as const));
    await expect(h.wiring.recoveryFirst(probe)()).resolves.toBe('ok');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a stop after the first tick ends the hourly ticks', async () => {
    const h = harness(new Date(NOW + 60 * DAY).toISOString());
    await vi.advanceTimersByTimeAsync(ROTATION_START_DELAY_MS);
    h.stoppers.get('device token rotation')?.();
    const reads = h.s.reads();
    await vi.advanceTimersByTimeAsync(3 * ROTATION_TICK_MS);
    expect(h.s.reads()).toBe(reads);
  });

  it('a lost rotation answer is retried after the first overlap wait', async () => {
    const h = harness(new Date(NOW + 10 * DAY).toISOString());
    h.fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await vi.advanceTimersByTimeAsync(ROTATION_START_DELAY_MS);
    expect(rotateCalls(h.fetch)).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rotateCalls(h.fetch)).toBe(2);
    expect(h.s.held()).toBe(NEW);
  });

  it('a hint reader that throws never breaks the call', async () => {
    const h = harness(new Date(NOW + 60 * DAY).toISOString());
    const bad = { status: 200, headers: null } as unknown as Response;
    h.fetch.mockResolvedValueOnce(bad);
    await expect(h.wiring.fetch(`${BASE}/x`)).resolves.toBe(bad);
  });
});
