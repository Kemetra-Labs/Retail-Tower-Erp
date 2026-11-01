import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrandingWorker, type BrandingWorkerDeps } from '../branding-worker.js';
import { TENANT_A, paired } from './__helpers__/branding-fixture.js';

/** RT-475 — the branding worker's lifecycle and failure paths. */

afterEach(() => {
  vi.useRealTimers();
});

function deps(over: Partial<BrandingWorkerDeps> = {}) {
  const read = vi.fn(() => Promise.resolve({ kind: 'not_modified' as const }));
  const warn = vi.fn();
  const d: BrandingWorkerDeps = {
    client: { read },
    cache: {
      load: () => ({ name: null, logo: null, conditionalEtag: null }),
      replace: vi.fn(),
    },
    pairing: { getStatus: () => Promise.resolve(paired(TENANT_A, 100)) },
    readDeviceToken: () => Promise.resolve('device-token'),
    tenantId: TENANT_A,
    now: () => '2026-11-01T09:00:00.000Z',
    onChanged: vi.fn(),
    tickIntervalMs: 1_000,
    logger: { info: vi.fn(), warn },
    ...over,
  };
  return { d, read, warn };
}

describe('RT-475 — branding worker', () => {
  it('skips without a sendable device token, sending nothing', async () => {
    const { d, read } = deps({ readDeviceToken: () => Promise.resolve(null) });
    await expect(createBrandingWorker(d).runTickOnce()).resolves.toBe('skipped');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('db closed'), 'Error'],
    ['a non-Error', 'db closed', 'unknown'],
  ])('logs a failing tick (%s) by name only and never rejects', async (_label, thrown, name) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error branch is under test
    const { d, warn } = deps({ pairing: { getStatus: () => Promise.reject(thrown) } });
    await expect(createBrandingWorker(d).runTickOnce()).resolves.toBe('skipped');
    expect(warn).toHaveBeenCalledWith({ error: name }, 'branding_read_down:tick_failed');
  });

  it('joins a tick already in flight', async () => {
    const { d, read } = deps();
    const worker = createBrandingWorker(d);
    const [a, b] = [worker.runTickOnce(), worker.runTickOnce()];
    expect(a).toBe(b);
    await a;
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('ticks at start and on the interval, starts once, and stops cleanly', async () => {
    vi.useFakeTimers();
    const { d, read } = deps();
    const worker = createBrandingWorker(d);
    worker.stop(); // never started: a no-op
    worker.start();
    worker.start(); // a second start does not add a second interval
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    worker.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
