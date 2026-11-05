/**
 * `AuditDbPool` — the worker's Nest-managed `pg.Pool` wrapper (RT-1211: moved out of
 * `worker.module.ts` so the gauge registrars can inject it without an import cycle;
 * `worker.module.ts` re-exports it).
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";

/**
 * Nest-managed wrapper that owns the worker's `pg.Pool` lifecycle.
 *
 * Why this exists
 * ---------------
 * Nest only invokes `onModuleDestroy` on providers whose resolved value
 * is a class instance implementing the hook. A `useFactory` returning a
 * raw `Pool` would be opaque to Nest — `app.close()` would not call
 * `pool.end()`, and the worker process would hang on open Postgres
 * connections under SIGTERM. This wrapper makes pool teardown
 * explicit and Nest-aware.
 *
 * Field semantics
 * ---------------
 * - `pool === null` is the safe non-prod / no-Redis / no-DB path
 *   (paired with `NoOpAuditDbAdapter` downstream). `onModuleDestroy`
 *   is then a no-op.
 * - `pool !== null` is the real DB path. `onModuleDestroy` ends the
 *   pool exactly once; double-destroy is tolerated because we null the
 *   reference before awaiting `pool.end()`.
 *
 * Constructed by `pgPoolProviderFactory()` — never `new`-instantiated
 * directly outside that factory and tests.
 */
@Injectable()
export class AuditDbPool implements OnModuleDestroy {
  private _pool: Pool | null;
  private _heartbeatPool: Pool | null;

  constructor(pool: Pool | null, heartbeatPool: Pool | null = null) {
    this._pool = pool;
    this._heartbeatPool = heartbeatPool;
  }

  /** The underlying pool, or `null` on the safe no-DB path. */
  get pool(): Pool | null {
    return this._pool;
  }

  get heartbeatPool(): Pool | null {
    return this._heartbeatPool;
  }

  /**
   * Nest lifecycle hook — fires on `app.close()` from `main.ts`.
   * Idempotent: a second invocation is a no-op because we null the
   * reference before awaiting.
   */
  async onModuleDestroy(): Promise<void> {
    const p = this._pool;
    const heartbeatPool = this._heartbeatPool;
    this._pool = null;
    this._heartbeatPool = null;
    try {
      if (heartbeatPool !== null) {
        await heartbeatPool.end();
      }
    } finally {
      if (p !== null) {
        await p.end();
      }
    }
  }
}
