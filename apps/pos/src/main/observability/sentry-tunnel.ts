import type { ElectronMainOptions, ErrorEvent } from '@sentry/electron/main';

import {
  IPC_MODE_CLASSIC,
  OFFLINE_MAX_AGE_DAYS,
  OFFLINE_MAX_QUEUE_SIZE,
  type Integration,
  type InitSentryMainLogger,
  type SentryInitFn,
} from './sentry-main.js';
import { scrubSentryEvent, type SentryEventLike } from './scrub.js';
import type { TelemetryConfigHolder } from './telemetry-config.js';
import { CAPTURE_TERMINAL_TAG } from './tunnel-transport.js';

/**
 * RT-1253 — main-process Sentry init in TUNNEL mode: the terminal holds no DSN
 * and sends every envelope to Backend-Core (`posForwardTelemetryEnvelope`), which
 * forwards it to Sentry project `kemetra/pos` with server-minted refs.
 *
 * The SDK is initialised ONCE, early (before the DB and the pairing store
 * exist). Everything that changes afterwards is read at CAPTURE time or SEND time
 * through the closures below: the cached config, the current pairing and the
 * current device token. So the SDK is never re-initialised after the async
 * config fetch (RT-1253 step 0, design consequences).
 *
 *   - No usable DSN exists, so the SDK builds no transport of its own. It gets a
 *     fixed, non-secret placeholder DSN on a reserved host (`*.invalid`) plus the
 *     `tunnel` option, and the custom `transport` below, which never uses the DSN.
 *     The server ignores the DSN in the envelope header.
 *   - `beforeSend` runs BEFORE the transport and the disk queue. It returns null
 *     while the config is inert or never fetched, or while unpaired, so an inert
 *     terminal writes nothing to disk. It runs the same OBS-1 allowlist scrubber
 *     as direct mode, then records the capture-time terminal id (R1) AFTER the
 *     scrub, which would otherwise strip the tag.
 *   - The release is the build stamp's commit cut to SHA12 (R2), never an env var.
 *     The `version` tag is the same value: the tunnel drops both when they differ.
 *   - Same hardening as direct mode: reviewed integrations only, no breadcrumbs,
 *     no tracing, no client reports, Classic IPC, bounded offline queue (30
 *     envelopes, 7 days) at an explicit path, so a purge can target it.
 */

/** A fixed, non-secret placeholder: the reserved `.invalid` TLD never resolves. */
export const TUNNEL_PLACEHOLDER_DSN = 'https://public@pos-tunnel.invalid/1';

const GIT_COMMIT = /^[0-9a-f]{40}$/;
const UNKNOWN = 'unknown';

export type TunnelTransportFactory = NonNullable<ElectronMainOptions['transport']>;

export interface InitSentryTunnelOptions {
  /** R9 DI seam — `Sentry.init` in production. */
  sentryInit: SentryInitFn;
  /** The reviewed integration list. */
  integrations: () => Integration[];
  logger: InitSentryMainLogger;
  /** The absolute tunnel URL (Backend-Core base URL + the contract path). */
  tunnelUrl: string;
  /** `dist/build-identity.json` commit (40 lower-case hex), or null when the build has no stamp. */
  commit: string | null;
  config: Pick<TelemetryConfigHolder, 'current'>;
  /** The terminal id the device is paired as right now (late-bound; null when unpaired). */
  currentTerminalId: () => string | null;
  /** `makeElectronOfflineTransport(base)` in production, where `base` sends through the tunnel. */
  makeTransport: TunnelTransportFactory;
  /** The offline queue directory (under userData). */
  queuePath: string;
}

export type SentryTunnelResult = { readonly kind: 'failed' } | { readonly kind: 'initialized' };

/** The build stamp's commit as SHA12, or `unknown`. */
export function releaseOf(commit: string | null): string {
  return commit !== null && GIT_COMMIT.test(commit) ? commit.slice(0, 12) : UNKNOWN;
}

/** Initialise main-process Sentry in tunnel mode. Never throws; never blocks boot. */
export function initSentryTunnel(opts: InitSentryTunnelOptions): SentryTunnelResult {
  const release = releaseOf(opts.commit);
  try {
    opts.sentryInit({
      dsn: TUNNEL_PLACEHOLDER_DSN,
      tunnel: opts.tunnelUrl,
      release,
      sendDefaultPii: false,
      defaultIntegrations: false,
      integrations: opts.integrations(),
      ipcMode: IPC_MODE_CLASSIC,
      maxBreadcrumbs: 0,
      sendClientReports: false,
      transport: opts.makeTransport,
      transportOptions: {
        maxQueueSize: OFFLINE_MAX_QUEUE_SIZE,
        maxAgeDays: OFFLINE_MAX_AGE_DAYS,
        queuePath: opts.queuePath,
      },
      beforeSend: (event) => stampedEvent(event, release, opts),
    });
  } catch {
    // Deliberately do NOT pass the underlying error to the logger.
    opts.logger.warn({ reason: 'init-threw' }, 'sentry:init-failed');
    return { kind: 'failed' };
  }
  return { kind: 'initialized' };
}

function stampedEvent(
  event: ErrorEvent,
  release: string,
  opts: Pick<InitSentryTunnelOptions, 'config' | 'currentTerminalId'>,
): ErrorEvent | null {
  const config = opts.config.current();
  if (config?.kind !== 'enabled') return null;
  const terminalId = opts.currentTerminalId();
  if (terminalId === null) return null;
  const scrubbed = scrubSentryEvent(event as unknown as SentryEventLike, {
    environment: config.environment,
    release,
  });
  if (scrubbed === null) return null;
  return {
    ...scrubbed,
    tags: { ...scrubbed.tags, [CAPTURE_TERMINAL_TAG]: terminalId },
  } as unknown as ErrorEvent;
}
