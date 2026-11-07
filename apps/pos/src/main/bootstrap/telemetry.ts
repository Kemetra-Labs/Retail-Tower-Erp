import { rmSync } from 'node:fs';
import path from 'node:path';
import type * as SentryNs from '@sentry/electron/main';

import { createBackendTransport, type FetchLike } from '../http/transport.js';
import { loadBuildIdentity, type BuildIdentity } from '../observability/build-identity.js';
import { initSentryMain, mainIntegrations } from '../observability/sentry-main.js';
import { initSentryTunnel } from '../observability/sentry-tunnel.js';
import {
  createTelemetryConfigClient,
  createFileConfigStore,
  createTelemetryConfig,
} from '../observability/telemetry-config.js';
import { resolveTelemetryMode, type TelemetryMode } from '../observability/telemetry-mode.js';
import {
  createTunnelRequestExecutor,
  TELEMETRY_TUNNEL_PATH,
} from '../observability/tunnel-transport.js';
import { resolveUpdateConfig } from '../update/update-config.js';

/**
 * RT-1253 — main-process error reporting (Sentry) wiring, in one place.
 *
 * `registerTelemetry` runs early in boot, right after the main logger (the position
 * the inline `initSentryMain` call held). It picks the mode (R3), initialises the
 * SDK ONCE, and returns a handle. The pairing store, the device token reader and
 * the shared fetch do not exist yet at that point, so the tunnel transport reads
 * them through the late binding that `bind` fills in. Until `bind` runs the
 * transport THROWS, which keeps the offline queue (RT-1253 step 0, Q2).
 *
 *   tunnel   production, unclassified, and lab without an env DSN (RT-1253 R3)
 *   direct   lab and dev with an env `SENTRY_DSN`: exactly the pre-RT-1253 path
 *   inert    dev without an env DSN
 *
 * Telemetry uses the shared base fetch (request id, build identity) BEFORE the
 * terminal-status observer, so a telemetry 401 never counts toward a device
 * revocation, and a telemetry failure never reaches a sale.
 */

/** Seconds are for humans; the numbers are milliseconds. */
const CONFIG_TIMEOUT_MS = 10_000;
const CONFIG_MAX_BODY_BYTES = 4 * 1024;
const TUNNEL_TIMEOUT_MS = 10_000;
/** While the config was never fetched (unpaired, or Backend-Core down), retry this often. */
export const CONFIG_RETRY_MS = 5 * 60 * 1000;
/** Once fetched, refresh slowly: the kill switch takes effect within this long. */
export const CONFIG_REFRESH_MS = 6 * 60 * 60 * 1000;

/** The SDK surface used here; production passes the `@sentry/electron/main` namespace. */
export type SentrySdk = Pick<
  typeof SentryNs,
  | 'init'
  | 'createTransport'
  | 'makeElectronOfflineTransport'
  | 'onUncaughtExceptionIntegration'
  | 'onUnhandledRejectionIntegration'
  | 'linkedErrorsIntegration'
  | 'dedupeIntegration'
>;

export interface TelemetryLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface TelemetryDeps {
  readonly sentry: SentrySdk;
  readonly logger: TelemetryLogger;
  readonly env: Record<string, string | undefined>;
  /** `isShippedApp(...)` (RT-165). */
  readonly shippedApp: boolean;
  /** Electron `app`: `getAppPath()` holds `dist/build-identity.json`, `getPath('userData')` the queue. */
  readonly app: Pick<Electron.App, 'getAppPath' | 'getPath'>;
  /** The Backend-Core origin, `resolveApiBaseUrl()`. */
  readonly baseUrl: string;
  /** The config refresh timer is stopped with the other workers. */
  readonly workerRegistry: { register(name: string, stop: () => void): void };
}

/** What only exists after the DB and the pairing store are open. */
export interface TelemetryLateBinding {
  /** The shared base fetch BEFORE the terminal-status observer. */
  readonly fetch: FetchLike;
  /** `readSendableDeviceToken`. */
  readonly readToken: () => Promise<string | null>;
  /** `pairingStore.getCurrentTerminalId`. */
  readonly currentTerminalId: () => string | null;
}

export interface TelemetryWiring {
  readonly mode: TelemetryMode;
  /** This build's identity (the shared build-identity header wrapper reads it too). */
  readonly buildIdentity: BuildIdentity | null;
  /** True when Sentry initialised (the renderer error bridge asks). */
  isInitialized(): boolean;
  /** Fill the late binding and start the config refresh (tunnel mode only). */
  bind(late: TelemetryLateBinding): void;
  /** R1: delete the queued envelopes (tunnel mode only). Never throws. */
  purgeQueue(): void;
  /** Stop the refresh timer. */
  stop(): void;
}

export function registerTelemetry(deps: TelemetryDeps): TelemetryWiring {
  const { sentry, logger, env } = deps;
  const buildIdentity = loadBuildIdentity(
    path.join(deps.app.getAppPath(), 'dist', 'build-identity.json'),
  );
  logger.info({ build_identity_known: buildIdentity !== null }, 'build_identity:loaded');

  const mode = resolveTelemetryMode({
    shipped: deps.shippedApp,
    channel: resolveUpdateConfig(env).channel,
    env,
  });
  logger.info({ mode: mode.mode, build: mode.build }, 'telemetry:mode');

  if (mode.mode === 'direct') {
    const result = initSentryMain({
      sentryInit: sentry.init,
      integrations: () => mainIntegrations(sentry),
      logger,
      env,
    });
    return inertHandle(mode, buildIdentity, result.kind === 'initialized');
  }
  if (mode.mode === 'inert') return inertHandle(mode, buildIdentity, false);
  return registerTunnel(deps, mode, buildIdentity);
}

function inertHandle(
  mode: TelemetryMode,
  buildIdentity: BuildIdentity | null,
  initialized: boolean,
): TelemetryWiring {
  return {
    mode,
    buildIdentity,
    isInitialized: () => initialized,
    bind: () => undefined,
    purgeQueue: () => undefined,
    stop: () => undefined,
  };
}

interface LateState {
  bound: boolean;
  binding: TelemetryLateBinding | null;
}

function registerTunnel(
  deps: TelemetryDeps,
  mode: TelemetryMode,
  buildIdentity: BuildIdentity | null,
): TelemetryWiring {
  const { sentry, logger } = deps;
  const root = deps.baseUrl.replace(/\/$/, '');
  const tunnelUrl = `${root}${TELEMETRY_TUNNEL_PATH}`;
  const telemetryDir = path.join(deps.app.getPath('userData'), 'telemetry');
  const queuePath = path.join(telemetryDir, 'queue');
  const late: LateState = { bound: false, binding: null };

  const config = createTelemetryConfig({
    store: createFileConfigStore(path.join(telemetryDir, 'config.json')),
    fetchConfig: () => {
      const binding = late.binding;
      if (binding === null) return Promise.resolve(null);
      return createTelemetryConfigClient({
        transport: createBackendTransport({
          baseUrl: deps.baseUrl,
          fetch: binding.fetch,
          timeoutMs: CONFIG_TIMEOUT_MS,
          maxBodyBytes: CONFIG_MAX_BODY_BYTES,
        }),
        readToken: binding.readToken,
      }).read();
    },
  });

  const executor = createTunnelRequestExecutor({
    isBound: () => late.bound,
    isEnabled: () => config.current()?.kind === 'enabled',
    tunnelUrl,
    readToken: () => late.binding?.readToken() ?? Promise.resolve(null),
    currentTerminalId: () => late.binding?.currentTerminalId() ?? null,
    fetch: (input, init) =>
      late.binding?.fetch(input, init) ?? Promise.reject(new Error('unbound')),
    timeoutMs: TUNNEL_TIMEOUT_MS,
  });
  const makeTransport = sentry.makeElectronOfflineTransport((options) =>
    sentry.createTransport(options, executor),
  );

  const result = initSentryTunnel({
    sentryInit: sentry.init,
    integrations: () => mainIntegrations(sentry),
    logger,
    tunnelUrl,
    commit: buildIdentity?.commit ?? null,
    config,
    currentTerminalId: () => late.binding?.currentTerminalId() ?? null,
    makeTransport,
    queuePath,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    const wait = config.current() === null ? CONFIG_RETRY_MS : CONFIG_REFRESH_MS;
    timer = setTimeout(() => {
      void tick();
    }, wait);
    timer.unref();
  };
  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
  const tick = async (): Promise<void> => {
    await config.refresh();
    schedule();
  };

  return {
    mode,
    buildIdentity,
    isInitialized: () => result.kind === 'initialized',
    bind(binding) {
      late.binding = binding;
      late.bound = true;
      deps.workerRegistry.register('telemetry config refresh', stop);
      if (result.kind === 'initialized') void tick();
    },
    purgeQueue() {
      try {
        rmSync(queuePath, { recursive: true, force: true });
      } catch {
        // Best effort: the send-time capture-terminal guard still drops a stale envelope.
      }
    },
    stop,
  };
}
