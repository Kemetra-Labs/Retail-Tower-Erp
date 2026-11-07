import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BackendAnswer, BackendTransport } from '../http/transport.js';

import { TELEMETRY_TUNNEL_PATH } from './tunnel-transport.js';

/**
 * RT-1253 scope 2 — the telemetry config of a paired terminal.
 *
 * `GET /api/pos/v1/telemetry/config` (`posGetTelemetryConfig`, device bearer):
 *   200  {enabled: true, tunnel, environment}  -> enabled, cached
 *   204                                         -> inert, cached (the fleet kill switch)
 *   anything else, or unreachable               -> the cache is kept
 *   never fetched                               -> inert
 *
 * A 204 is cached as well as a 200: otherwise a fetch failure after a 204 would
 * bring an older 200 back and the kill switch would stop working. The answer
 * never carries a DSN. The only value kept from a 200 is the environment label;
 * the tunnel path is a contract constant and is not read from the answer.
 */

/** The contract path of `posGetTelemetryConfig`, relative to the Backend-Core base URL. */
export const TELEMETRY_CONFIG_PATH = '/api/pos/v1/telemetry/config';

const ENVIRONMENT_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

export type TelemetryConfig =
  | { readonly kind: 'enabled'; readonly environment: string }
  | { readonly kind: 'inert' };

export type ConfigAnswer = Pick<BackendAnswer, 'status' | 'json'> | null;

/** The config an answer states, or null when it is unusable (the cache is kept). */
export function parseConfigAnswer(answer: ConfigAnswer): TelemetryConfig | null {
  if (answer === null) return null;
  if (answer.status === 204) return { kind: 'inert' };
  if (answer.status !== 200) return null;
  return enabledConfigOf(answer.json);
}

/** The contract 200 body: enabled, the contract tunnel path, and a plain environment label. */
function enabledConfigOf(body: unknown): TelemetryConfig | null {
  if (typeof body !== 'object' || body === null) return null;
  const fields = body as Record<string, unknown>;
  const environment = fields['environment'];
  if (fields['enabled'] !== true || fields['tunnel'] !== TELEMETRY_TUNNEL_PATH) return null;
  if (typeof environment !== 'string' || !ENVIRONMENT_LABEL.test(environment)) return null;
  return { kind: 'enabled', environment };
}

export interface ConfigStore {
  read(): TelemetryConfig | null;
  write(config: TelemetryConfig): void;
}

/** A config file under userData; a missing, corrupt or foreign file reads as never fetched. */
export function createFileConfigStore(file: string): ConfigStore {
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (raw['kind'] === 'inert') return { kind: 'inert' };
        if (raw['kind'] !== 'enabled') return null;
        const environment = raw['environment'];
        return typeof environment === 'string' && ENVIRONMENT_LABEL.test(environment)
          ? { kind: 'enabled', environment }
          : null;
      } catch {
        return null;
      }
    },
    write(config) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(config), 'utf8');
    },
  };
}

export interface TelemetryConfigDeps {
  readonly store: ConfigStore;
  /** One config request; null when unreachable or when there is no sendable token. */
  readonly fetchConfig: () => Promise<ConfigAnswer>;
}

export interface TelemetryConfigHolder {
  /** The cached config, or null when it was never fetched (the terminal stays inert). */
  current(): TelemetryConfig | null;
  /** Fetch and cache. Never rejects. */
  refresh(): Promise<void>;
}

export function createTelemetryConfig(deps: TelemetryConfigDeps): TelemetryConfigHolder {
  let current: TelemetryConfig | null = readCached(deps.store);
  return {
    current: () => current,
    async refresh() {
      let fresh: TelemetryConfig | null = null;
      try {
        fresh = parseConfigAnswer(await deps.fetchConfig());
      } catch {
        return;
      }
      if (fresh === null) return;
      current = fresh;
      try {
        deps.store.write(fresh);
      } catch {
        // The fresh value still applies for this run; the next run falls back to the older cache.
      }
    },
  };
}

function readCached(store: ConfigStore): TelemetryConfig | null {
  try {
    return store.read();
  } catch {
    return null;
  }
}

export interface TelemetryConfigClientDeps {
  /** The Backend-Core transport on an UNOBSERVED fetch (telemetry never counts toward a revocation). */
  readonly transport: BackendTransport;
  /** `readSendableDeviceToken`: null unless the pairing is `paired`. */
  readonly readToken: () => Promise<string | null>;
}

export interface TelemetryConfigClient {
  /** `posGetTelemetryConfig`; null when there is no sendable token or the terminal is unreachable. */
  read(): Promise<ConfigAnswer>;
}

export function createTelemetryConfigClient(
  deps: TelemetryConfigClientDeps,
): TelemetryConfigClient {
  return {
    async read() {
      const bearer = await deps.readToken();
      if (bearer === null || bearer === '') return null;
      return deps.transport.send({ method: 'GET', path: TELEMETRY_CONFIG_PATH, bearer });
    },
  };
}
