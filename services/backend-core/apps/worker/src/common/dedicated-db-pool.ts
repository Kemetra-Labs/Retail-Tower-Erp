/**
 * DedicatedDbPool — a worker sweep's own Postgres pool, or the domain pool it
 * borrows (RT-353 audit retention, RT-1556 sync-failure alert).
 *
 * The sweep either gets its own credential (a small pool this wrapper owns and
 * closes) or, outside production, borrows the domain pool, which `AuditDbPool`
 * owns and closes. A subclass is a class-token provider so Nest tracks it for
 * lifecycle hooks.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";

@Injectable()
export class DedicatedDbPool implements OnModuleDestroy {
  private _pool: Pool | null;

  /**
   * @param pool  the pool the sweep runs on, or `null` on the no-DB path.
   * @param owned whether this wrapper must end it (false for the borrowed
   *              domain pool, which `AuditDbPool` ends).
   */
  constructor(
    pool: Pool | null,
    private readonly owned: boolean,
  ) {
    this._pool = pool;
  }

  get pool(): Pool | null {
    return this._pool;
  }

  /** True when the sweep has its own credential, false when it borrows the domain pool. */
  get dedicated(): boolean {
    return this.owned;
  }

  async onModuleDestroy(): Promise<void> {
    const p = this._pool;
    this._pool = null;
    if (p !== null && this.owned) {
      await p.end();
    }
  }
}
