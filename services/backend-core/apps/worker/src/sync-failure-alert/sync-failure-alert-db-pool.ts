/**
 * SyncFailureAlertDbPool — the sync-failure alert sweep's own Postgres pool (RT-1556).
 *
 * The sweep (RT-1034) reads the posting and sale failure state and writes only
 * its own two alert tables and `audit_events`, but it ran on the worker's shared
 * `DATABASE_URL` role, which also writes `erpnext_posting_status` and `sales` for
 * other jobs. It connects with `SYNC_FAILURE_ALERT_DATABASE_URL` instead: a role
 * created from `docs/operations/sql/sync-failure-alert-role.sql` that holds no
 * write grant on those tables.
 *
 *   - production + sweep enabled + URL missing → throws at boot.
 *   - sweep disabled, or non-production, + URL missing → borrows the domain pool
 *     (dev / CI keep working; `AuditDbPool` still owns and closes it).
 *   - URL set → a small dedicated pool that this wrapper owns and closes.
 *
 * The role's grants are checked at boot by `SyncFailureAlertRoleVerifier`.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";

import { InstrumentedPool } from "../observability/instrumented-pool";
import { resolveSyncFailureAlertEnabled } from "./sync-failure-alert.config";

@Injectable()
export class SyncFailureAlertDbPool implements OnModuleDestroy {
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

export function syncFailureAlertPoolProviderFactory(domainPool: Pool | null): SyncFailureAlertDbPool {
  const url = process.env["SYNC_FAILURE_ALERT_DATABASE_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production" && resolveSyncFailureAlertEnabled()) {
      throw new Error(
        "WorkerModule: SYNC_FAILURE_ALERT_DATABASE_URL is required in production when " +
          "SYNC_FAILURE_ALERT_ENABLED=true; the sync-failure alert sweep must not run on " +
          "the DATABASE_URL role (RT-1556)",
      );
    }
    return new SyncFailureAlertDbPool(domainPool, false);
  }
  // One sweep at a time, tenants one after another: two connections are plenty.
  return new SyncFailureAlertDbPool(new InstrumentedPool({ connectionString: url, max: 2 }), true);
}
