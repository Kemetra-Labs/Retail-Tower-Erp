import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElectronMainOptions, ErrorEvent } from '@sentry/electron/main';

import { CAPTURE_TERMINAL_TAG } from '../../observability/tunnel-transport.js';
import { registerTelemetry, type SentrySdk, type TelemetryDeps } from '../telemetry.js';

/**
 * RT-1253 — `registerTelemetry`: mode selection (R3), the late binding, the cached
 * config and the queue purge, with a fake SDK (the real one is never loaded).
 */

const ENV_DSN = 'https://abc123@o1.ingest.de.sentry.io/4500000000000001';
const COMMIT = 'c'.repeat(40);
const BASE = 'https://api.example.com';
const TUNNEL = `${BASE}/api/pos/v1/telemetry/envelope`;

let tmp: string | undefined;
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

interface Fixture {
  deps: TelemetryDeps;
  init: ReturnType<typeof vi.fn<(o: ElectronMainOptions) => void>>;
  registered: string[];
  dir: string;
}

function fixture(env: Record<string, string | undefined>, shipped = true): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt1253-boot-'));
  tmp = dir;
  mkdirSync(path.join(dir, 'dist'));
  writeFileSync(path.join(dir, 'dist', 'build-identity.json'), JSON.stringify({ commit: COMMIT }));
  const init = vi.fn<(o: ElectronMainOptions) => void>();
  const registered: string[] = [];
  const marker = (): never => ({ name: 'fake' }) as never;
  const sentry = {
    init,
    createTransport: (_options: unknown, exec: unknown) => ({ exec }),
    makeElectronOfflineTransport: (base: unknown) => base,
    onUncaughtExceptionIntegration: marker,
    onUnhandledRejectionIntegration: marker,
    linkedErrorsIntegration: marker,
    dedupeIntegration: marker,
  } as unknown as SentrySdk;
  return {
    deps: {
      sentry,
      logger: { info: vi.fn(), warn: vi.fn() },
      env,
      shippedApp: shipped,
      app: { getAppPath: () => dir, getPath: () => dir },
      baseUrl: BASE,
      workerRegistry: { register: (name) => registered.push(name) },
    },
    init,
    registered,
    dir,
  };
}

function options(f: Fixture): ElectronMainOptions {
  const o = f.init.mock.calls[0]?.[0];
  if (o === undefined) throw new Error('Sentry.init not called');
  return o;
}

const exception = (): ErrorEvent =>
  ({
    event_id: 'e',
    exception: { values: [{ type: 'Error', value: 'x' }] },
  }) as unknown as ErrorEvent;

type BeforeSend = (e: ErrorEvent) => ErrorEvent | null;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('registerTelemetry — mode (R3)', () => {
  it('production ignores an env DSN: the SDK gets the placeholder DSN and the tunnel only', () => {
    const f = fixture({ SENTRY_DSN: ENV_DSN, POS_PULSE_UPDATE_CHANNEL: 'stable' });
    const wiring = registerTelemetry(f.deps);
    expect(wiring.mode).toEqual({ mode: 'tunnel', build: 'production' });
    expect(options(f).dsn).not.toBe(ENV_DSN);
    expect(options(f).dsn).toContain('.invalid');
    expect(options(f).tunnel).toBe(TUNNEL);
    expect(wiring.isInitialized()).toBe(true);
  });

  it('an unset channel on a shipped build is production (the updater default is stable)', () => {
    const f = fixture({ SENTRY_DSN: ENV_DSN });
    expect(registerTelemetry(f.deps).mode.mode).toBe('tunnel');
    expect(options(f).dsn).not.toBe(ENV_DSN);
  });

  it('lab with an env DSN keeps the direct path: the env DSN, no tunnel', () => {
    const f = fixture({
      SENTRY_DSN: ENV_DSN,
      POS_PULSE_UPDATE_CHANNEL: 'lab',
      POS_PULSE_RELEASE: 'd'.repeat(40),
    });
    const wiring = registerTelemetry(f.deps);
    expect(wiring.mode.mode).toBe('direct');
    expect(options(f).dsn).toBe(ENV_DSN);
    expect(options(f).tunnel).toBeUndefined();
    expect(options(f).release).toBe('d'.repeat(12));
  });

  it('dev without a DSN stays inert: the SDK is never initialised', () => {
    const f = fixture({}, false);
    const wiring = registerTelemetry(f.deps);
    expect(wiring.mode.mode).toBe('inert');
    expect(f.init).not.toHaveBeenCalled();
    expect(wiring.isInitialized()).toBe(false);
  });

  it('the release is the build stamp SHA12 even when POS_PULSE_RELEASE differs (R2)', () => {
    const f = fixture({ POS_PULSE_UPDATE_CHANNEL: 'stable', POS_PULSE_RELEASE: 'd'.repeat(40) });
    const wiring = registerTelemetry(f.deps);
    expect(wiring.buildIdentity?.commit).toBe(COMMIT);
    expect(options(f).release).toBe('c'.repeat(12));
  });
});

describe('registerTelemetry — tunnel mode', () => {
  const stable = { POS_PULSE_UPDATE_CHANNEL: 'stable' };

  function executorOf(f: Fixture): (r: { body: string }) => Promise<{ statusCode: number }> {
    const transport = options(f).transport as unknown as (o: unknown) => { exec: never };
    return transport({}).exec;
  }

  it('before bind the transport THROWS, so the offline queue is kept', async () => {
    const f = fixture(stable);
    registerTelemetry(f.deps);
    await expect(executorOf(f)({ body: 'x' })).rejects.toThrow('telemetry:not-ready');
  });

  it('bind starts the config fetch: a 200 is cached on disk and then events are accepted', async () => {
    const f = fixture(stable);
    const wiring = registerTelemetry(f.deps);
    const body = { enabled: true, tunnel: '/api/pos/v1/telemetry/envelope', environment: 'lab' };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const beforeSend = options(f).beforeSend as unknown as BeforeSend;
    expect(beforeSend(exception())).toBeNull(); // never fetched: inert, nothing to disk

    wiring.bind({
      fetch,
      readToken: () => Promise.resolve('tok'),
      currentTerminalId: () => 'term-A',
    });
    await vi.waitFor(() => {
      expect(existsSync(path.join(f.dir, 'telemetry', 'config.json'))).toBe(true);
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/pos/v1/telemetry/config`);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(readFileSync(path.join(f.dir, 'telemetry', 'config.json'), 'utf8'))).toEqual({
      kind: 'enabled',
      environment: 'lab',
    });
    expect(beforeSend(exception())?.tags?.[CAPTURE_TERMINAL_TAG]).toBe('term-A');
    expect(f.registered).toEqual(['telemetry config refresh']);
    wiring.stop();
  });

  it('a 204 makes the terminal inert and the cache says so (kill switch)', async () => {
    const f = fixture(stable);
    const wiring = registerTelemetry(f.deps);
    wiring.bind({
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      readToken: () => Promise.resolve('tok'),
      currentTerminalId: () => 'term-A',
    });
    await vi.waitFor(() => {
      expect(existsSync(path.join(f.dir, 'telemetry', 'config.json'))).toBe(true);
    });
    const beforeSend = options(f).beforeSend as unknown as BeforeSend;
    expect(beforeSend(exception())).toBeNull();
    wiring.stop();
  });

  it('with the tunnel unreachable bind never throws and nothing blocks (R5)', async () => {
    const f = fixture(stable);
    const wiring = registerTelemetry(f.deps);
    expect(() => {
      wiring.bind({
        fetch: () => Promise.reject(new TypeError('fetch failed')),
        readToken: () => Promise.resolve('tok'),
        currentTerminalId: () => 'term-A',
      });
    }).not.toThrow();
    await settle();
    wiring.stop();
  });

  it('purgeQueue deletes the queue directory and never throws', () => {
    const f = fixture(stable);
    const wiring = registerTelemetry(f.deps);
    const queue = path.join(f.dir, 'telemetry', 'queue');
    mkdirSync(queue, { recursive: true });
    writeFileSync(path.join(queue, 'queue-v2.json'), '[]');
    wiring.purgeQueue();
    expect(existsSync(queue)).toBe(false);
    expect(() => {
      wiring.purgeQueue();
    }).not.toThrow();
  });
});
