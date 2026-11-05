/**
 * Forwards a rebuilt envelope to the Console Sentry project (RT-632, OBS-3).
 *
 * The destination comes only from `CONSOLE_SENTRY_DSN`, so the tunnel is never
 * an open relay. Default-inert: with the DSN unset, blank or malformed,
 * `enabled` is false and nothing is sent. Forwarding is fire-and-forget with
 * a timeout and a bound on concurrent requests (the excess is dropped), so
 * Sentry being slow or down never holds a request or a socket of other API
 * traffic. Logs carry an upstream status or a fixed line only: never the
 * envelope, the DSN or the upstream URL (it contains the project id and host).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { resolveSentryConfig, type Logger } from "@data-pulse-2/shared";

import { ROOT_LOGGER } from "../common/logging.interceptor";

export const CONSOLE_TELEMETRY_FETCH = "CONSOLE_TELEMETRY_FETCH";

/** The slice of `fetch` the forwarder uses; injected so tests replace the network. */
export type TelemetryFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: Buffer;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

/** Concurrent forwards; a Console error burst beyond this is dropped. */
export const MAX_IN_FLIGHT_FORWARDS = 4;
export const FORWARD_TIMEOUT_MS = 5000;

const SENTRY_CLIENT = "backend-core-console-tunnel/1.0";

export interface ForwardTarget {
  readonly url: string;
  readonly auth: string;
  /** The server's Sentry environment, served by the config read and stamped on events. */
  readonly environment: string;
}

/** `ConsoleTelemetryConfig.environment` is at most 64 characters. */
const MAX_ENVIRONMENT_LENGTH = 64;

type WarnLogger = Pick<Logger, "warn">;

/** Envelope endpoint and auth header from a DSN `scheme://key@host[/prefix]/project`. */
function targetFromDsn(dsn: string, environment: string): ForwardTarget {
  const url = new URL(dsn);
  // `resolveSentryConfig` already checked the last segment is a numeric id.
  const segments = url.pathname.split("/");
  const projectId = segments.pop() ?? "";
  const prefix = segments.join("/");
  const key = decodeURIComponent(url.username);
  return {
    url: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    auth: `Sentry sentry_version=7, sentry_key=${key}, sentry_client=${SENTRY_CLIENT}`,
    environment: environment.slice(0, MAX_ENVIRONMENT_LENGTH),
  };
}

/** `null` (inert) unless `CONSOLE_SENTRY_DSN` is a usable DSN. Never logs the value. */
export function resolveForwardTarget(env: NodeJS.ProcessEnv, logger?: WarnLogger): ForwardTarget | null {
  return resolveTargetFromDsn(env["CONSOLE_SENTRY_DSN"], env, logger, "CONSOLE_SENTRY_DSN", "console telemetry");
}

/**
 * `null` (inert) unless `rawDsn` (the value of `dsnVar`) is a usable DSN.
 * Shared with the POS tunnel (RT-1252). Never logs the value.
 */
export function resolveTargetFromDsn(
  rawDsn: string | undefined,
  env: NodeJS.ProcessEnv,
  logger: WarnLogger | undefined,
  dsnVar: string,
  label: string,
): ForwardTarget | null {
  const raw = rawDsn?.trim();
  if (!raw) return null;
  // The API's own Sentry environment (SENTRY_ENVIRONMENT, else
  // DEPLOYMENT_ENVIRONMENT, else "unknown"), with the tunnel's DSN.
  const config = resolveSentryConfig({
    SENTRY_DSN: raw,
    SENTRY_ENVIRONMENT: env["SENTRY_ENVIRONMENT"],
    DEPLOYMENT_ENVIRONMENT: env["DEPLOYMENT_ENVIRONMENT"],
  });
  if (config === null) {
    logger?.warn(`${label} disabled: ${dsnVar} is not a valid DSN`);
    return null;
  }
  return targetFromDsn(config.dsn, config.environment);
}

/**
 * Fire-and-forget envelope forward to one server-configured Sentry project.
 * Shared by the Console tunnel and, since RT-1252, the POS device tunnel.
 */
export class SentryEnvelopeForwarder {
  private inFlight = 0;

  constructor(
    private readonly target: ForwardTarget | null,
    private readonly fetchFn: TelemetryFetch,
    private readonly logger: Logger | undefined,
    private readonly label: string,
  ) {}

  /** The environment to serve and stamp, or `null` when the tunnel is inert. */
  get environment(): string | null {
    return this.target?.environment ?? null;
  }

  /** Starts the forward and returns at once. Never throws. */
  forward(envelope: Buffer): void {
    const target = this.target;
    if (target === null || this.inFlight >= MAX_IN_FLIGHT_FORWARDS) return;
    this.inFlight += 1;
    void this.send(target, envelope).finally(() => {
      this.inFlight -= 1;
    });
  }

  private async send(target: ForwardTarget, envelope: Buffer): Promise<void> {
    try {
      const response = await this.fetchFn(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": target.auth },
        body: envelope,
        redirect: "error",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status >= 300) {
        this.logger?.warn({ status: response.status }, `${this.label}: upstream rejected envelope`);
      }
    } catch {
      this.logger?.warn(`${this.label}: forward failed`);
    }
  }
}

/** The Console tunnel's forwarder (RT-632): `CONSOLE_SENTRY_DSN` only. */
@Injectable()
export class ConsoleTelemetryForwarder extends SentryEnvelopeForwarder {
  constructor(
    @Inject(CONSOLE_TELEMETRY_FETCH) fetchFn: TelemetryFetch,
    @Optional() @Inject(ROOT_LOGGER) logger?: Logger,
  ) {
    super(resolveForwardTarget(process.env, logger), fetchFn, logger, "console telemetry");
  }
}
