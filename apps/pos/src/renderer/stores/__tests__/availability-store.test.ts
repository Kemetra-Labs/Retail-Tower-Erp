import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  AvailabilityBandsResponse,
  AvailabilityBridgeAPI,
  AvailabilityStatusResponse,
} from '../../../shared/availability/types';
import { useAvailabilityStore } from '../availability-store';

/**
 * RT-1578 (RT-1511 S3, spec 013) — the renderer availability store under a pairing change. A reply that was
 * asked for before the store changed (or the terminal re-paired) must never be shown for the new pairing, and
 * the badges on screen are asked again at once.
 */

const AS_OF = '2026-11-24T10:00:00.000Z';

type Api = { [K in keyof AvailabilityBridgeAPI]: Mock<AvailabilityBridgeAPI[K]> };
let api: Api;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function okBands(ids: readonly string[]): AvailabilityBandsResponse {
  return {
    kind: 'ok',
    state: 'fresh',
    as_of: AS_OF,
    states: Object.fromEntries(ids.map((id) => [id, 'in_stock' as const])),
  };
}

beforeEach(() => {
  api = {
    status: vi.fn(() => Promise.resolve({ kind: 'ok', state: 'fresh', as_of: AS_OF })),
    bands: vi.fn((req: { product_ids: readonly string[] }) =>
      Promise.resolve(okBands(req.product_ids)),
    ),
    refresh: vi.fn(() => Promise.resolve({ kind: 'done', outcome: 'refreshed' })),
  };
  (window as unknown as { api: unknown }).api = { availability: api };
  useAvailabilityStore.getState().reset();
});

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

describe('a reply from before a reset', () => {
  it('a bands reply that arrives after a reset is dropped', async () => {
    const late = deferred<AvailabilityBandsResponse>();
    api.bands.mockImplementationOnce(() => late.promise);
    useAvailabilityStore.getState().track('p-1');
    await flush();
    useAvailabilityStore.getState().reset();
    late.resolve(okBands(['p-1']));
    await flush();
    expect(useAvailabilityStore.getState().states).toEqual({});
    expect(useAvailabilityStore.getState().freshness).toBeNull();
  });

  it('a status reply that arrives after a reset is dropped', async () => {
    const late = deferred<AvailabilityStatusResponse>();
    api.status.mockImplementationOnce(() => late.promise);
    void useAvailabilityStore.getState().reload();
    await flush();
    useAvailabilityStore.getState().reset();
    late.resolve({ kind: 'ok', state: 'fresh', as_of: AS_OF });
    await flush();
    expect(useAvailabilityStore.getState().freshness).toBeNull();
  });

  it('an earlier refresh finishing never clears the refreshing flag of a later one', async () => {
    const first = deferred<{ kind: 'done'; outcome: 'refreshed' }>();
    const second = deferred<{ kind: 'done'; outcome: 'refreshed' }>();
    api.refresh.mockImplementationOnce(() => first.promise);
    api.refresh.mockImplementationOnce(() => second.promise);
    void useAvailabilityStore.getState().refresh();
    await flush();
    useAvailabilityStore.getState().reset();
    void useAvailabilityStore.getState().refresh();
    await flush();
    expect(useAvailabilityStore.getState().refreshing).toBe(true);
    first.resolve({ kind: 'done', outcome: 'refreshed' });
    await flush();
    expect(useAvailabilityStore.getState().refreshing).toBe(true);
    second.resolve({ kind: 'done', outcome: 'refreshed' });
    await flush();
    expect(useAvailabilityStore.getState().refreshing).toBe(false);
  });

  it('a reply within the current generation still updates the store', async () => {
    useAvailabilityStore.getState().track('p-1');
    await flush();
    expect(useAvailabilityStore.getState().states).toEqual({ 'p-1': 'in_stock' });
    expect(useAvailabilityStore.getState().freshness).toEqual({ state: 'fresh', as_of: AS_OF });
  });
});

describe('invalidate (a store change or a re-pair)', () => {
  it('clears the old store state at once and asks again for every tracked product', async () => {
    const { track, invalidate } = useAvailabilityStore.getState();
    track('p-1');
    track('p-2');
    await flush();
    expect(Object.keys(useAvailabilityStore.getState().states)).toHaveLength(2);
    // The new pairing cannot answer: the old store's bands must not stay on screen.
    api.bands.mockImplementation(() => Promise.resolve({ kind: 'refused', reason: 'no_session' }));
    api.bands.mockClear();
    invalidate();
    expect(useAvailabilityStore.getState().states).toEqual({});
    expect(useAvailabilityStore.getState().freshness).toBeNull();
    await flush();
    expect(api.bands).toHaveBeenCalledTimes(1);
    expect(api.bands).toHaveBeenCalledWith({ product_ids: ['p-1', 'p-2'] });
    expect(useAvailabilityStore.getState().states).toEqual({});
  });

  it('shows the new store answer for the tracked products once main gives it', async () => {
    const { track, invalidate } = useAvailabilityStore.getState();
    track('p-1');
    await flush();
    api.bands.mockImplementation((req: { product_ids: readonly string[] }) =>
      Promise.resolve({
        kind: 'ok',
        state: 'fresh',
        as_of: AS_OF,
        states: Object.fromEntries(req.product_ids.map((id) => [id, 'out' as const])),
      }),
    );
    invalidate();
    await flush();
    expect(useAvailabilityStore.getState().states).toEqual({ 'p-1': 'out' });
  });

  it('drops a reply asked for before the invalidation', async () => {
    const late = deferred<AvailabilityBandsResponse>();
    api.bands.mockImplementationOnce(() => late.promise);
    useAvailabilityStore.getState().track('p-1');
    await flush();
    api.bands.mockImplementation(() => Promise.resolve({ kind: 'refused', reason: 'no_session' }));
    useAvailabilityStore.getState().invalidate();
    late.resolve(okBands(['p-1']));
    await flush();
    expect(useAvailabilityStore.getState().states).toEqual({});
  });
});
