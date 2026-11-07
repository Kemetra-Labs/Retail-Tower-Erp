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
const captureException = vi.fn();
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

interface FixtureOptions {
  /** Write `dist/build-identity.json` (default true). */
  stamp?: boolean;
  /** `Sentry.init` throws (a malformed setup). */
  initThrows?: boolean;
  /** A config cached by an earlier run. */
  cachedConfig?: { kind: 'enabled'; environment: string };
}

function fixture(
  env: Record<string, string | undefined>,
  shipped = true,
  extra: FixtureOptions = {},
): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt1253-boot-'));
  tmp = dir;
  mkdirSync(path.join(dir, 'dist'));
  if (extra.stamp !== false) {
    writeFileSync(
      path.join(dir, 'dist', 'build-identity.json'),
      JSON.stringify({ commit: COMMIT }),
    );
  }
  if (extra.cachedConfig !== undefined) {
    mkdirSync(path.join(dir, 'telemetry'));
    writeFileSync(path.join(dir, 'telemetry', 'config.json'), JSON.stringify(extra.cachedConfig));
  }
  captureException.mockClear();
  const init = vi.fn<(o: ElectronMainOptions) => void>(() => {
    if (extra.initThrows === true) throw new Error('boom');
  });
  const registered: string[] = [];
  const marker = (): never => ({ name: 'fake' }) as never;
  const sentry = {
    init,
    createTransport: (_options: unknown, exec: unknown) => ({ exec }),
    captureException,
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

describe('registerTelemetry — the rest of the tunnel lifecycle', () => {
  const stable = { POS_PULSE_UPDATE_CHANNEL: 'stable' };
  const enabled = { kind: 'enabled', environment: 'lab' } as const;
  const configBody = JSON.stringify({
    enabled: true,
    tunnel: '/api/pos/v1/telemetry/envelope',
    environment: 'lab',
  });
  const envelope = `{}\n{"type":"event"}\n{"tags":{"${CAPTURE_TERMINAL_TAG}":"term-A"}}\n`;

  const json = (status: number, body?: string): Response =>
    new Response(body ?? null, { status, headers: { 'content-type': 'application/json' } });

  const urlOf = (input: RequestInfo | URL): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  function executorOf(f: Fixture): (r: { body: string }) => Promise<{ statusCode: number }> {
    const transport = options(f).transport as unknown as (o: unknown) => { exec: never };
    return transport({}).exec;
  }

  it('a bound, enabled terminal forwards an envelope through the tunnel with the device token', async () => {
    const f = fixture(stable, true, { cachedConfig: enabled });
    const wiring = registerTelemetry(f.deps);
    const seen: { url: string; auth: string | null }[] = [];
    const fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: urlOf(url), auth: new Headers(init?.headers).get('authorization') });
      return Promise.resolve(
        urlOf(url).endsWith('/config')
          ? json(200, configBody)
          : new Response(null, { status: 204 }),
      );
    });
    wiring.bind({
      fetch,
      readToken: () => Promise.resolve('tok'),
      currentTerminalId: () => 'term-A',
    });
    const answer = await executorOf(f)({ body: envelope });
    expect(answer.statusCode).toBe(204);
    expect(seen).toContainEqual({ url: TUNNEL, auth: 'Bearer tok' });
    wiring.stop();
  });

  it('before bind an enabled terminal records nothing: no terminal is paired yet', () => {
    const f = fixture(stable, true, { cachedConfig: enabled });
    registerTelemetry(f.deps);
    const beforeSend = options(f).beforeSend as unknown as BeforeSend;
    expect(beforeSend(exception())).toBeNull();
  });

  it('the direct and inert handles ignore bind, purge and stop', () => {
    const direct = registerTelemetry(
      fixture({ SENTRY_DSN: ENV_DSN, POS_PULSE_UPDATE_CHANNEL: 'lab' }).deps,
    );
    const inert = registerTelemetry(fixture({}, false).deps);
    for (const wiring of [direct, inert]) {
      expect(() => {
        wiring.bind({
          fetch: () => Promise.resolve(new Response(null, { status: 204 })),
          readToken: () => Promise.resolve('tok'),
          currentTerminalId: () => 'term-A',
        });
        wiring.purgeQueue();
        wiring.stop();
      }).not.toThrow();
    }
  });

  it('bind is idempotent: a second call neither registers twice nor starts a second refresh', async () => {
    const f = fixture(stable, true, { cachedConfig: enabled });
    const wiring = registerTelemetry(f.deps);
    const fetch = vi.fn(() => Promise.resolve(json(200, configBody)));
    const binding = {
      fetch,
      readToken: () => Promise.resolve('tok'),
      currentTerminalId: () => 'term-A',
    };
    wiring.bind(binding);
    wiring.bind({ ...binding, currentTerminalId: () => 'term-B' });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    expect(f.registered).toEqual(['telemetry config refresh']);
    wiring.stop();
  });

  it('a build without a stamp reports release unknown and has no buildIdentity', () => {
    const f = fixture(stable, true, { stamp: false });
    const wiring = registerTelemetry(f.deps);
    expect(wiring.buildIdentity).toBeNull();
    expect(options(f).release).toBe('unknown');
  });

  it('a throwing init is survived: not initialised and the config is never fetched', () => {
    const f = fixture(stable, true, { initThrows: true });
    const wiring = registerTelemetry(f.deps);
    const fetch = vi.fn();
    wiring.bind({
      fetch,
      readToken: () => Promise.resolve('tok'),
      currentTerminalId: () => 'term-A',
    });
    expect(wiring.isInitialized()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('refresh timing', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const bindWith = (
      wiring: ReturnType<typeof registerTelemetry>,
      fetch: () => Promise<Response>,
    ) => {
      wiring.bind({
        fetch,
        readToken: () => Promise.resolve('tok'),
        currentTerminalId: () => 'term-A',
      });
    };

    it('retries every 5 minutes while the config was never fetched', async () => {
      vi.useFakeTimers();
      const wiring = registerTelemetry(fixture(stable).deps);
      const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
      bindWith(wiring, fetch);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(fetch).toHaveBeenCalledTimes(2);
      wiring.stop();
    });

    it('refreshes slowly (6 hours) once a config is cached', async () => {
      vi.useFakeTimers();
      const wiring = registerTelemetry(fixture(stable, true, { cachedConfig: enabled }).deps);
      const fetch = vi.fn(() => Promise.resolve(json(200, configBody)));
      bindWith(wiring, fetch);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(fetch).toHaveBeenCalledTimes(2);
      wiring.stop();
    });

    it('stop() while a refresh is in flight schedules nothing afterwards', async () => {
      vi.useFakeTimers();
      const wiring = registerTelemetry(fixture(stable, true, { cachedConfig: enabled }).deps);
      let release: (r: Response) => void = () => undefined;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      bindWith(wiring, fetch);
      await vi.advanceTimersByTimeAsync(0);
      wiring.stop();
      release(json(200, configBody));
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('registerTelemetry — lab self-test (RT-1253 AC8)', () => {
  const cached = { kind: 'enabled', environment: 'staging' } as const;
  const lab = { POS_PULSE_UPDATE_CHANNEL: 'lab', POS_PULSE_TELEMETRY_SELFTEST: '1' };
  const configBody = JSON.stringify({
    enabled: true,
    tunnel: '/api/pos/v1/telemetry/envelope',
    environment: 'staging',
  });

  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

  /** Binds with a fetch that answers `answer`; resolves once the first config fetch has settled. */
  async function bindAndSettle(
    wiring: ReturnType<typeof registerTelemetry>,
    terminal: string | null,
    answer: () => Response = () => new Response(configBody, { status: 200 }),
  ): Promise<void> {
    const fetch = vi.fn(() => Promise.resolve(answer()));
    wiring.bind({
      fetch,
      readToken: () => Promise.resolve('tok'),
      currentTerminalId: () => terminal,
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    await pause();
  }

  it('a paired lab terminal with an enabled config reports exactly one controlled error', async () => {
    const wiring = registerTelemetry(fixture(lab, true, { cachedConfig: cached }).deps);
    await bindAndSettle(wiring, 'term-A');
    expect(captureException).toHaveBeenCalledTimes(1);
    const error = captureException.mock.calls[0]?.[0] as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('RT-1253 lab telemetry self-test');
    wiring.stop();
  });

  it.each([
    ['the flag is unset', { POS_PULSE_UPDATE_CHANNEL: 'lab' }],
    [
      'the flag is not 1',
      { POS_PULSE_UPDATE_CHANNEL: 'lab', POS_PULSE_TELEMETRY_SELFTEST: 'true' },
    ],
    [
      'the build is production',
      { POS_PULSE_UPDATE_CHANNEL: 'stable', POS_PULSE_TELEMETRY_SELFTEST: '1' },
    ],
    [
      'the channel is unknown (unclassified)',
      { POS_PULSE_UPDATE_CHANNEL: 'x', POS_PULSE_TELEMETRY_SELFTEST: '1' },
    ],
  ])('never fires when %s', async (_name, env) => {
    const wiring = registerTelemetry(fixture(env, true, { cachedConfig: cached }).deps);
    await bindAndSettle(wiring, 'term-A');
    expect(captureException).not.toHaveBeenCalled();
    wiring.stop();
  });

  it('waits while the terminal is unpaired', async () => {
    const wiring = registerTelemetry(fixture(lab, true, { cachedConfig: cached }).deps);
    await bindAndSettle(wiring, null);
    expect(captureException).not.toHaveBeenCalled();
    wiring.stop();
  });

  it('waits while the config is inert (kill switch)', async () => {
    const wiring = registerTelemetry(fixture(lab, true, {}).deps);
    await bindAndSettle(wiring, 'term-A', () => new Response(null, { status: 204 }));
    expect(captureException).not.toHaveBeenCalled();
    wiring.stop();
  });
});
