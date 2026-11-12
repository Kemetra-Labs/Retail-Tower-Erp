/**
 * RT-1339 (RT-286 S7) — the paired-only Offer Pack read-down worker.
 *
 * It reads the Pack at start and then every `tickIntervalMs` with the device
 * token, sending `If-None-Match` while a readable Pack is held. A 200 replaces the
 * Pack; a 304 keeps it and refreshes trusted time and freshness from
 * `X-Server-Time`. Any failure leaves the held Pack and its anchor as they are:
 * the Pack simply ages toward `stale`, and an `online_only` offer stops applying
 * once the last successful read is older than the online proof. Two answers drop the
 * Pack at once instead: a 404 (the server has no Pack for this till) and no sendable
 * device token (the till was revoked).
 *
 * The monotonic reading is taken BEFORE the request, so latency never extends an
 * offer. Single-flight: a tick while one runs joins it. Never rejects.
 */
import type { OfferPackClient, OfferPackReadOutcome } from './offer-pack-client.js';
import type { OfferPackService } from './offer-pack-service.js';

/** Five minutes: short enough that `ONLINE_PROOF_MS` (ten) tolerates one missed poll. */
export const OFFER_PACK_TICK_INTERVAL_MS = 5 * 60 * 1_000;

type OfferPackTickResult = OfferPackReadOutcome['kind'] | 'applied' | 'rejected' | 'skipped';

interface OfferPackWorkerLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface OfferPackWorkerDeps {
  readonly client: OfferPackClient;
  readonly service: Pick<
    OfferPackService,
    'conditionalEtag' | 'applyOk' | 'applyNotModified' | 'restore' | 'forget'
  >;
  /** The one reader of the device token for sending (null unless paired, not revoked). */
  readonly readDeviceToken: () => Promise<string | null>;
  readonly tenantId: string;
  readonly monotonicMs: () => number;
  readonly tickIntervalMs: number;
  readonly logger: OfferPackWorkerLogger;
}

export interface OfferPackWorker {
  runTickOnce(): Promise<OfferPackTickResult>;
  start(): void;
  stop(): void;
}

/** A task that joins its own run while one is in flight, and starts afresh once it has settled. */
function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= task().finally(() => {
      running = null;
    });
    return running;
  };
}

export function createOfferPackWorker(deps: OfferPackWorkerDeps): OfferPackWorker {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<OfferPackTickResult> {
    const token = await deps.readDeviceToken();
    if (token === null) {
      // A paired-only worker with no sendable token: the device was revoked. Hold no Pack.
      deps.service.forget();
      return 'skipped';
    }
    const monoAtStartMs = deps.monotonicMs();
    const outcome = await deps.client.read(token, deps.service.conditionalEtag());
    if (outcome.kind === 'ok') {
      const applied = deps.service.applyOk({
        tenantId: deps.tenantId,
        body: outcome.body,
        etag: outcome.etag,
        serverTime: outcome.serverTime,
        monoAtStartMs,
      });
      return applied ? 'applied' : 'rejected';
    }
    if (outcome.kind === 'not_modified') {
      const applied = deps.service.applyNotModified({
        serverTime: outcome.serverTime,
        monoAtStartMs,
      });
      return applied ? 'applied' : 'rejected';
    }
    if (outcome.kind === 'not_found') deps.service.forget();
    return outcome.kind;
  }

  const runTickOnce = singleFlight(() =>
    tick()
      .catch((err: unknown) => {
        deps.logger.warn(
          { error: err instanceof Error ? err.name : 'unknown' },
          'offer_pack_read_down:tick_failed',
        );
        return 'skipped' as const;
      })
      .then((result) => {
        deps.logger.info({ outcome: result }, 'offer_pack_read_down:tick');
        return result;
      }),
  );

  return {
    runTickOnce,
    start() {
      if (timer !== null) return;
      deps.service.restore(deps.tenantId);
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
