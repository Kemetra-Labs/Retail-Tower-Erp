/**
 * RT-475 — the paired-only branding read-down worker (spec 039 FR-30).
 *
 * It reads the branding at start and then hourly with the device token,
 * sending `If-None-Match` while the cache is valid (FR-35a). It is not gated on
 * an operator session. A changed branding replaces the cache in one write and
 * notifies the screens; a 304 or any failure leaves the cache as it is, so the
 * last good logo keeps showing offline.
 *
 * Scope: the worker is built for one tenant. Each tick re-reads the pairing,
 * and again just before writing, so a read that started before a re-pair can
 * never land in the new pairing's cache.
 *
 * A branding 401 is not fed to the device-revocation detector: RT-215 decision
 * 2 closes that to the cashier-admissions, read-down and sale-sync routes.
 */

import type { BrandingCache } from './branding-cache.js';
import type { BrandingClient, BrandingReadOutcome } from './branding-client.js';
import type { BrandingPairing } from './branding-service.js';

export type BrandingTickResult = BrandingReadOutcome['kind'] | 'skipped' | 'superseded';

export interface BrandingWorkerLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface BrandingWorkerDeps {
  readonly client: BrandingClient;
  readonly cache: Pick<BrandingCache, 'load' | 'replace'>;
  readonly pairing: Pick<BrandingPairing, 'getStatus'>;
  /** The one reader of the device token for sending (null unless paired, not revoked). */
  readonly readDeviceToken: () => Promise<string | null>;
  readonly tenantId: string;
  readonly now: () => string;
  /** Called after the cache was replaced. */
  readonly onChanged: () => void;
  readonly tickIntervalMs: number;
  readonly logger: BrandingWorkerLogger;
}

export interface BrandingWorker {
  /** One read; single-flight (a tick while one runs joins it). Never rejects. */
  runTickOnce(): Promise<BrandingTickResult>;
  start(): void;
  stop(): void;
}

/** The current pairing epoch when it is still this worker's tenant, else null. */
async function currentEpoch(
  pairing: Pick<BrandingPairing, 'getStatus'>,
  tenantId: string,
): Promise<number | null> {
  const status = await pairing.getStatus();
  return status.kind === 'paired' && status.tenant_id === tenantId ? status.paired_at : null;
}

export function createBrandingWorker(deps: BrandingWorkerDeps): BrandingWorker {
  const { tenantId } = deps;
  let inFlight: Promise<BrandingTickResult> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<BrandingTickResult> {
    const pairedAt = await currentEpoch(deps.pairing, tenantId);
    if (pairedAt === null) return 'skipped';
    const scope = { tenant_id: tenantId, paired_at: pairedAt };
    const cached = deps.cache.load(scope);
    const token = await deps.readDeviceToken();
    if (token === null) return 'skipped';
    const outcome = await deps.client.read(token, cached.conditionalEtag);
    if (outcome.kind !== 'ok') return outcome.kind;
    if ((await currentEpoch(deps.pairing, tenantId)) !== pairedAt) return 'superseded';
    deps.cache.replace(scope, outcome.branding, deps.now());
    deps.onChanged();
    return 'ok';
  }

  function runTickOnce(): Promise<BrandingTickResult> {
    if (inFlight !== null) return inFlight;
    inFlight = tick()
      .catch((err: unknown) => {
        deps.logger.warn(
          { error: err instanceof Error ? err.name : 'unknown' },
          'branding_read_down:tick_failed',
        );
        return 'skipped' as const;
      })
      .then((result) => {
        deps.logger.info({ outcome: result }, 'branding_read_down:tick');
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    runTickOnce,
    start() {
      if (timer !== null) return;
      void runTickOnce();
      timer = setInterval(() => {
        void runTickOnce();
      }, deps.tickIntervalMs);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
