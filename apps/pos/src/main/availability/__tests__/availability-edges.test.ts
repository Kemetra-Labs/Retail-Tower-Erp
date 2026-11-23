import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';

import { handleFor } from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import {
  cloneMigratedDb,
  initMigratedDbTemplate,
} from '../../db/__tests__/__helpers__/migrated-db.js';
import { AVAILABILITY_IPC_CHANNELS } from '../../../shared/availability/channels.js';
import { MAX_BAND_PRODUCT_IDS, registerAvailabilityHandlers } from '../../ipc/availability.js';
import { scopeOfPairing } from '../../bootstrap/availability.js';
import { createAvailabilityClient } from '../availability-client.js';
import {
  ENV_AVAILABILITY_REFRESH_MINUTES,
  ENV_AVAILABILITY_STALE_MINUTES,
  resolveAvailabilityConfig,
} from '../availability-config.js';
import { createAvailabilityRepo } from '../availability-repo.js';

const STORE = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const P1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';

beforeAll(async () => {
  await initMigratedDbTemplate();
});

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeId: STORE,
    asOf: '2026-11-24T10:00:00.000Z',
    items: [{ productId: P1, availableToSell: '-2.5', band: 'out' }],
    nextCursor: null,
    ...over,
  };
}

function clientFor(answer: () => Promise<Response>, token: string | null = 'tok') {
  return createAvailabilityClient({
    baseUrl: 'https://bc.test',
    fetch: answer,
    readToken: () => Promise.resolve(token),
  });
}

const json = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('availability client', () => {
  it('reads a contract-valid page (a negative ATS is kept as given)', async () => {
    const outcome = await clientFor(() => json(validBody())).fetchPage(STORE, null);
    expect(outcome).toMatchObject({ kind: 'ok', page: { storeId: STORE, nextCursor: null } });
  });

  it.each([
    ['a non-object body', 'oops'],
    ['a missing storeId', validBody({ storeId: undefined })],
    ['a non-string asOf', validBody({ asOf: 5 })],
    ['an unparseable asOf', validBody({ asOf: 'garbled' })],
    ['items that are not an array', validBody({ items: {} })],
    ['an empty nextCursor', validBody({ nextCursor: '' })],
    ['a numeric nextCursor', validBody({ nextCursor: 7 })],
    [
      'a non-uuid productId',
      validBody({ items: [{ productId: 'x', availableToSell: '1', band: 'low' }] }),
    ],
    [
      'a numeric availableToSell',
      validBody({ items: [{ productId: P1, availableToSell: 1, band: 'low' }] }),
    ],
    [
      'a malformed decimal',
      validBody({ items: [{ productId: P1, availableToSell: '1e3', band: 'low' }] }),
    ],
    [
      'an unknown band',
      validBody({ items: [{ productId: P1, availableToSell: '1', band: 'green' }] }),
    ],
    ['a null item', validBody({ items: [null] })],
  ])('fails on %s', async (_name, body) => {
    await expect(clientFor(() => json(body)).fetchPage(STORE, null)).resolves.toEqual({
      kind: 'failed',
    });
  });

  it('maps 401 to unauthorized and any other status to failed', async () => {
    await expect(clientFor(() => json({}, 401)).fetchPage(STORE, null)).resolves.toEqual({
      kind: 'unauthorized',
    });
    await expect(clientFor(() => json({}, 404)).fetchPage(STORE, null)).resolves.toEqual({
      kind: 'failed',
    });
    await expect(clientFor(() => json({}, 500)).fetchPage(STORE, null)).resolves.toEqual({
      kind: 'failed',
    });
  });

  it('maps a transport fault and a missing credential to unreachable without a request', async () => {
    await expect(
      clientFor(() => Promise.reject(new Error('down'))).fetchPage(STORE, null),
    ).resolves.toEqual({ kind: 'unreachable' });
    const fetchSpy = vi.fn(() => json(validBody()));
    await expect(clientFor(fetchSpy, null).fetchPage(STORE, null)).resolves.toEqual({
      kind: 'unreachable',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a throwing token reader is no credential', async () => {
    const client = createAvailabilityClient({
      baseUrl: 'https://bc.test',
      fetch: () => json(validBody()),
      readToken: () => Promise.reject(new Error('sealed')),
    });
    await expect(client.fetchPage(STORE, null)).resolves.toEqual({ kind: 'unreachable' });
  });
});

describe('availability config', () => {
  it('defaults to a 15 minute refresh and a 60 minute staleness window', () => {
    expect(resolveAvailabilityConfig({})).toEqual({
      refreshIntervalMs: 15 * 60_000,
      staleAfterMs: 60 * 60_000,
    });
  });

  it('reads both values from the environment', () => {
    expect(
      resolveAvailabilityConfig({
        [ENV_AVAILABILITY_REFRESH_MINUTES]: '5',
        [ENV_AVAILABILITY_STALE_MINUTES]: ' 30 ',
      }),
    ).toEqual({ refreshIntervalMs: 5 * 60_000, staleAfterMs: 30 * 60_000 });
  });

  it.each(['0', '-1', 'abc', '1.5', '', '999999', '10081'])(
    'falls back to the default for %j',
    (raw) => {
      expect(resolveAvailabilityConfig({ [ENV_AVAILABILITY_REFRESH_MINUTES]: raw })).toMatchObject({
        refreshIntervalMs: 15 * 60_000,
      });
    },
  );
});

describe('availability repo', () => {
  it('replaceAll swaps the whole snapshot and purge empties it', () => {
    const db = cloneMigratedDb();
    const repo = createAvailabilityRepo(handleFor(db));
    expect(repo.readState()).toBeNull();
    repo.replaceAll({
      scopeKey: 'a|b|1',
      oldestAsOf: '2026-11-24T10:00:00.000Z',
      refreshedAt: '2026-11-24T10:00:01.000Z',
      items: [{ productId: P1, band: 'low', availableToSell: '1' }],
    });
    expect(repo.readState()).toEqual({
      scope_key: 'a|b|1',
      oldest_as_of: '2026-11-24T10:00:00.000Z',
    });
    expect(repo.readBands([P1]).get(P1)).toBe('low');
    repo.replaceAll({
      scopeKey: 'a|b|2',
      oldestAsOf: '2026-11-24T11:00:00.000Z',
      refreshedAt: '2026-11-24T11:00:01.000Z',
      items: [],
    });
    expect(repo.readBands([P1]).size).toBe(0);
    repo.purge();
    expect(repo.readState()).toBeNull();
    db.close();
  });

  it('a failing write rolls the whole swap back', () => {
    const db = cloneMigratedDb();
    const repo = createAvailabilityRepo(handleFor(db));
    repo.replaceAll({
      scopeKey: 'a|b|1',
      oldestAsOf: '2026-11-24T10:00:00.000Z',
      refreshedAt: 'x',
      items: [{ productId: P1, band: 'low', availableToSell: '1' }],
    });
    expect(() => {
      repo.replaceAll({
        scopeKey: 'a|b|2',
        oldestAsOf: '2026-11-24T11:00:00.000Z',
        refreshedAt: 'x',
        items: [{ productId: P1, band: 'bogus' as 'low', availableToSell: '1' }],
      });
    }).toThrow();
    expect(repo.readState()?.scope_key).toBe('a|b|1');
    expect(repo.readBands([P1]).get(P1)).toBe('low');
    db.close();
  });
});

describe('scopeOfPairing', () => {
  it('is null unless paired, and carries the pairing stamp', () => {
    expect(scopeOfPairing({ kind: 'unpaired' })).toBeNull();
    expect(
      scopeOfPairing({
        kind: 'paired',
        tenant_id: 't',
        branch_id: 'b',
        terminal_id: 'x',
        terminal_label: 'l',
        paired_at: 42,
      }),
    ).toEqual({ tenantId: 't', branchId: 'b', pairedAt: 42 });
  });
});

describe('availability IPC handlers', () => {
  function register(hasSession: boolean) {
    const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: (channel: string, fn: (event: unknown, request?: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn);
      },
    } as unknown as IpcMain;
    const service = {
      freshness: vi.fn(() => Promise.resolve({ state: 'never' as const, as_of: null })),
      states: vi.fn((ids: readonly string[]) =>
        Promise.resolve({
          freshness: { state: 'never' as const, as_of: null },
          states: Object.fromEntries(ids.map((id) => [id, 'unknown' as const])),
        }),
      ),
      refresh: vi.fn(() => Promise.resolve('refreshed' as const)),
    };
    registerAvailabilityHandlers(ipcMain, { service, hasSession: () => hasSession });
    return { handlers, service };
  }

  it('registers exactly the three read-only channels', () => {
    const { handlers } = register(true);
    expect([...handlers.keys()].sort()).toEqual(Object.values(AVAILABILITY_IPC_CHANNELS).sort());
  });

  it('refuses every channel without a session, and never reaches the service', async () => {
    const { handlers, service } = register(false);
    for (const channel of Object.values(AVAILABILITY_IPC_CHANNELS)) {
      await expect(handlers.get(channel)?.({}, { product_ids: [P1] })).resolves.toEqual({
        kind: 'refused',
        reason: 'no_session',
      });
    }
    expect(service.freshness).not.toHaveBeenCalled();
    expect(service.states).not.toHaveBeenCalled();
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it('answers status, bands and refresh from the service', async () => {
    const { handlers } = register(true);
    await expect(handlers.get(AVAILABILITY_IPC_CHANNELS.STATUS)?.({})).resolves.toEqual({
      kind: 'ok',
      state: 'never',
      as_of: null,
    });
    await expect(
      handlers.get(AVAILABILITY_IPC_CHANNELS.BANDS)?.({}, { product_ids: [P1] }),
    ).resolves.toEqual({ kind: 'ok', state: 'never', as_of: null, states: { [P1]: 'unknown' } });
    await expect(handlers.get(AVAILABILITY_IPC_CHANNELS.REFRESH)?.({})).resolves.toEqual({
      kind: 'done',
      outcome: 'refreshed',
    });
  });

  it.each([
    ['no payload', undefined],
    ['null', null],
    ['no product_ids', {}],
    ['a non-array', { product_ids: P1 }],
    ['a non-uuid id', { product_ids: ['nope'] }],
    ['a non-string id', { product_ids: [5] }],
    ['too many ids', { product_ids: Array.from({ length: MAX_BAND_PRODUCT_IDS + 1 }, () => P1) }],
  ])('refuses a malformed bands request (%s) generically', async (_name, request) => {
    const { handlers, service } = register(true);
    await expect(handlers.get(AVAILABILITY_IPC_CHANNELS.BANDS)?.({}, request)).resolves.toEqual({
      kind: 'refused',
      reason: 'invalid_request',
    });
    expect(service.states).not.toHaveBeenCalled();
  });
});
