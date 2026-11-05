/**
 * Shared DB-pool observability primitives (RT-1211, RT-148 H-4).
 *
 * The api and the worker each scrape their own pool on their own OTel meter
 * scope (api: "db", worker: "worker"; ports 9464 / 9091). The code that
 * instruments a pool is the same, so it lives here and each app injects what
 * differs: the slow-query recorder (a function bound to its own meter) or its
 * own, already scoped, `Meter`.
 *
 * Nothing here imports `pg` (this package does not depend on it): the pool
 * classes are taken structurally, so the app's `pg.Pool` type flows through.
 */
import { createHash } from "node:crypto";

import type { Attributes, ObservableGauge } from "./meter";

// ---------------------------------------------------------------------------
// Slow-query instrumentation
// ---------------------------------------------------------------------------

/** Queries at or above this duration (seconds) increment db_slow_query_total. */
export const SLOW_QUERY_THRESHOLD_SECONDS = 0.5;

/** Pattern that every valid query_class label value must satisfy. */
const QUERY_CLASS_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Stable 8-hex-char fingerprint of a parameterized SQL template.
 *
 * The hash is over the raw template text (with `$1`, `$2` … placeholders),
 * never over rendered values. An empty string (e.g. from a QueryConfig with
 * no `.text`) produces a deterministic hash rather than crashing — the caller
 * never needs to guard for undefined.
 */
export function hashQueryTemplate(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 8);
}

/**
 * Returns true when `value` is a safe query_class label: exactly 8 lowercase
 * hex characters. Anything else is rejected to prevent raw SQL fragments,
 * error text, or PII from reaching the metric label (FR-B-006 / §XIV).
 */
export function isValidQueryClass(value: string): boolean {
  return QUERY_CLASS_PATTERN.test(value);
}

/** Increments `db_slow_query_total` on the caller's own meter. */
export type SlowQueryRecorder = (attrs: { query_class: string }) => void;

/**
 * Wraps a `pg.Pool`-shaped class so that the Promise form of `query()` emits
 * `db_slow_query_total` (through `record`) for every query whose wall-clock
 * duration reaches `SLOW_QUERY_THRESHOLD_SECONDS`, on success or error.
 *
 * - Override point: `Pool.query()` is the single entry point through which
 *   both Drizzle ORM and any direct `pool.query()` call flow. The callback
 *   forms are forwarded to the base class untouched (Drizzle never uses them,
 *   and their timing cannot be captured at the subclass level without
 *   rewriting the argument list).
 * - `query_class` label: SHA-256 of the parameterized template text, first 8
 *   hex digits. Stable, bounded, and never computed over bound parameter
 *   values (PII-suspect, redaction matrix §3.3).
 *
 * Returns the base class's own type, so the app's `pg.Pool` typing (including
 * the `query` overloads) is unchanged: `class InstrumentedPool extends
 * withSlowQueryRecorder(Pool, recordDbSlowQuery) {}`.
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W5.
 */
export function withSlowQueryRecorder<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TBase extends new (...args: any[]) => { query(...args: any[]): any },
>(Base: TBase, record: SlowQueryRecorder): TBase {
  const reportIfSlow = (text: string, start: number): void => {
    const durationSeconds = (performance.now() - start) / 1000;
    if (durationSeconds >= SLOW_QUERY_THRESHOLD_SECONDS) {
      const queryClass = hashQueryTemplate(text);
      if (isValidQueryClass(queryClass)) {
        record({ query_class: queryClass });
      }
    }
  };

  class Instrumented extends Base {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override query(...args: any[]): any {
      const [queryTextOrConfig, valuesOrCallback, callback] = args;
      // Callback form — pass through without instrumentation.
      if (typeof valuesOrCallback === "function" || typeof callback === "function") {
        return super.query(queryTextOrConfig, valuesOrCallback, callback);
      }

      // Promise form — instrument with duration check.
      const text: string =
        typeof queryTextOrConfig === "string" ? queryTextOrConfig : (queryTextOrConfig.text ?? "");
      const start = performance.now();

      return (super.query(queryTextOrConfig, valuesOrCallback) as Promise<unknown>).then(
        (result) => {
          reportIfSlow(text, start);
          return result;
        },
        (err: unknown) => {
          reportIfSlow(text, start);
          throw err;
        },
      );
    }
  }
  return Instrumented as unknown as TBase;
}

// ---------------------------------------------------------------------------
// Pool gauges
// ---------------------------------------------------------------------------

/** The counters `pg.Pool` exposes; read synchronously, no DB round-trip. */
export interface PoolStats {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/** Descriptions of the two pool gauges; each app creates them on its own meter and reuses these. */
export const DB_POOL_IN_USE_DESCRIPTION =
  "Number of connections currently checked out from the DB pool.";
export const DB_POOL_WAITERS_DESCRIPTION =
  "Number of requests currently waiting for a DB pool connection.";

export interface DbPoolGauges {
  readonly inUse: ObservableGauge;
  readonly waiters: ObservableGauge;
}

/**
 * Registers addCallbacks for both pool gauges against `pool`.
 *
 * - `pool === null` → no-op handle (the no-DB / no-Redis safe path).
 * - Otherwise → synchronous callbacks; the reads are in-memory counters on
 *   the pool object.
 *
 * The returned `{ stop }` removes both callbacks so they do not outlive the
 * pool.
 */
export function registerPoolGauges(
  gauges: DbPoolGauges,
  pool: PoolStats | null,
): { stop: () => void } {
  if (pool === null) {
    return { stop: () => undefined };
  }

  const inUseCallback = (result: {
    observe(value: number, attributes: Attributes): void;
  }): void => {
    result.observe(pool.totalCount - pool.idleCount, {} as Attributes);
  };

  const waitersCallback = (result: {
    observe(value: number, attributes: Attributes): void;
  }): void => {
    result.observe(pool.waitingCount, {} as Attributes);
  };

  gauges.inUse.addCallback(inUseCallback);
  gauges.waiters.addCallback(waitersCallback);

  return {
    stop: () => {
      gauges.inUse.removeCallback(inUseCallback);
      gauges.waiters.removeCallback(waitersCallback);
    },
  };
}

// ---------------------------------------------------------------------------
// Gauge registrar teardown
// ---------------------------------------------------------------------------

/**
 * Shared teardown for the gauge registrars: stops the registered gauge handle
 * once and clears it, so a repeated shutdown is a no-op. Nest calls
 * `onModuleDestroy` by name, so the `OnModuleDestroy` interface is not needed
 * (this package does not depend on `@nestjs/common`).
 */
export abstract class GaugeHandleOwner {
  protected handle: { stop: () => void } | null = null;

  onModuleDestroy(): void {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
  }
}
