import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTelemetryConfigClient,
  createFileConfigStore,
  createTelemetryConfig,
  parseConfigAnswer,
  TELEMETRY_CONFIG_PATH,
  type ConfigStore,
  type TelemetryConfig,
} from '../telemetry-config.js';

/**
 * RT-1253 scope 2 — the cached telemetry config.
 *   200 -> enabled (cached)   204 -> inert (cached: the kill switch)
 *   unreachable / unusable answer -> keep the cache   never fetched -> inert
 */

const ENABLED = { enabled: true, tunnel: '/api/pos/v1/telemetry/envelope', environment: 'lab' };

function memoryStore(initial: TelemetryConfig | null = null): ConfigStore & {
  saved: TelemetryConfig | null;
} {
  const store = {
    saved: initial,
    read: () => store.saved,
    write: (config: TelemetryConfig) => {
      store.saved = config;
    },
  };
  return store;
}

describe('parseConfigAnswer', () => {
  it('a 200 with the contract body is enabled', () => {
    expect(parseConfigAnswer({ status: 200, json: ENABLED })).toEqual({
      kind: 'enabled',
      environment: 'lab',
    });
  });

  it('a 204 is inert', () => {
    expect(parseConfigAnswer({ status: 204, json: undefined })).toEqual({ kind: 'inert' });
  });

  it.each([
    ['unreachable', null],
    ['a 401', { status: 401, json: { error: { code: 'x', message: 'y' } } }],
    ['a 500', { status: 500, json: undefined }],
    ['a 200 without a body', { status: 200, json: undefined }],
    ['enabled false', { status: 200, json: { ...ENABLED, enabled: false } }],
    ['another tunnel path', { status: 200, json: { ...ENABLED, tunnel: '/elsewhere' } }],
    [
      'an absolute tunnel URL',
      {
        status: 200,
        json: { ...ENABLED, tunnel: 'https://o1.ingest.de.sentry.io/api/1/envelope/' },
      },
    ],
    ['an empty environment', { status: 200, json: { ...ENABLED, environment: '' } }],
    [
      'an environment with odd characters',
      { status: 200, json: { ...ENABLED, environment: 'a b\n' } },
    ],
  ])('%s is unusable (null: keep the cache)', (_name, answer) => {
    expect(parseConfigAnswer(answer)).toBeNull();
  });
});

describe('createTelemetryConfig', () => {
  it('never fetched: current is null and the terminal stays inert', () => {
    const config = createTelemetryConfig({ store: memoryStore(), fetchConfig: vi.fn() });
    expect(config.current()).toBeNull();
  });

  it('starts from the cached value', () => {
    const cached: TelemetryConfig = { kind: 'enabled', environment: 'prod' };
    const config = createTelemetryConfig({ store: memoryStore(cached), fetchConfig: vi.fn() });
    expect(config.current()).toEqual(cached);
  });

  it('a 200 enables and is cached', async () => {
    const store = memoryStore();
    const config = createTelemetryConfig({
      store,
      fetchConfig: () => Promise.resolve({ status: 200, json: ENABLED }),
    });
    await config.refresh();
    expect(config.current()).toEqual({ kind: 'enabled', environment: 'lab' });
    expect(store.saved).toEqual({ kind: 'enabled', environment: 'lab' });
  });

  it('a 204 after a 200 makes the terminal inert and the inert state is cached (kill switch)', async () => {
    const store = memoryStore({ kind: 'enabled', environment: 'lab' });
    const config = createTelemetryConfig({
      store,
      fetchConfig: () => Promise.resolve({ status: 204, json: undefined }),
    });
    await config.refresh();
    expect(config.current()).toEqual({ kind: 'inert' });
    expect(store.saved).toEqual({ kind: 'inert' });
  });

  it('unreachable keeps the cached enabled config', async () => {
    const store = memoryStore({ kind: 'enabled', environment: 'lab' });
    const config = createTelemetryConfig({ store, fetchConfig: () => Promise.resolve(null) });
    await config.refresh();
    expect(config.current()).toEqual({ kind: 'enabled', environment: 'lab' });
  });

  it('unreachable after a cached 204 stays inert (the old 200 does not come back)', async () => {
    const store = memoryStore({ kind: 'inert' });
    const config = createTelemetryConfig({ store, fetchConfig: () => Promise.resolve(null) });
    await config.refresh();
    expect(config.current()).toEqual({ kind: 'inert' });
  });

  it('unreachable and never fetched stays inert', async () => {
    const config = createTelemetryConfig({
      store: memoryStore(),
      fetchConfig: () => Promise.resolve(null),
    });
    await config.refresh();
    expect(config.current()).toBeNull();
  });

  it('a throwing fetch never rejects and keeps the cache', async () => {
    const config = createTelemetryConfig({
      store: memoryStore({ kind: 'enabled', environment: 'lab' }),
      fetchConfig: () => Promise.reject(new Error('boom')),
    });
    await expect(config.refresh()).resolves.toBeUndefined();
    expect(config.current()).toEqual({ kind: 'enabled', environment: 'lab' });
  });

  it('a failing store write never rejects and the fresh value is still used', async () => {
    const store: ConfigStore = {
      read: () => null,
      write: () => {
        throw new Error('disk full');
      },
    };
    const config = createTelemetryConfig({
      store,
      fetchConfig: () => Promise.resolve({ status: 200, json: ENABLED }),
    });
    await expect(config.refresh()).resolves.toBeUndefined();
    expect(config.current()).toEqual({ kind: 'enabled', environment: 'lab' });
  });
});

describe('createTelemetryConfigClient', () => {
  it('sends a GET to the config path with the current device token', async () => {
    const send = vi.fn().mockResolvedValue({ status: 204, json: undefined });
    const client = createTelemetryConfigClient({
      transport: { send },
      readToken: () => Promise.resolve('tok'),
    });
    await expect(client.read()).resolves.toEqual({ status: 204, json: undefined });
    expect(send).toHaveBeenCalledWith({
      method: 'GET',
      path: TELEMETRY_CONFIG_PATH,
      bearer: 'tok',
    });
  });

  it('sends nothing without a sendable device token (unpaired, revoked)', async () => {
    const send = vi.fn();
    const client = createTelemetryConfigClient({
      transport: { send },
      readToken: () => Promise.resolve(null),
    });
    await expect(client.read()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('createFileConfigStore', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('round-trips a config through the file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rt1253-'));
    const store = createFileConfigStore(path.join(dir, 'telemetry-config.json'));
    expect(store.read()).toBeNull();
    store.write({ kind: 'enabled', environment: 'lab' });
    expect(store.read()).toEqual({ kind: 'enabled', environment: 'lab' });
    store.write({ kind: 'inert' });
    expect(store.read()).toEqual({ kind: 'inert' });
  });

  it('treats a corrupt or foreign file as never fetched', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rt1253-'));
    const file = path.join(dir, 'telemetry-config.json');
    writeFileSync(file, '{"kind":"enabled","environment":"a b"}');
    expect(createFileConfigStore(file).read()).toBeNull();
    writeFileSync(file, 'not json');
    expect(createFileConfigStore(file).read()).toBeNull();
  });

  it('creates the directory and stores no secret: only kind and environment', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rt1253-'));
    const file = path.join(dir, 'nested', 'telemetry-config.json');
    createFileConfigStore(file).write({ kind: 'enabled', environment: 'lab' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ kind: 'enabled', environment: 'lab' });
  });
});
