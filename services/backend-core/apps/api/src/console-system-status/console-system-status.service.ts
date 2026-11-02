/**
 * ConsoleSystemStatusService — RT-1062: the facts behind
 * `consoleGetSystemStatus` (`console-system-status.openapi.yaml`, RT-1056).
 *
 * Two checks, each in its own transaction under the caller's tenant GUC
 * (`runWithTenantContext`, `isPlatformAdmin: false` for every caller, so RLS
 * scopes every row to that tenant), run side by side:
 *
 *   - saleSync: the tenant's undelivered `sale.captured` outbox events
 *     (`pending`, `claimed`, `failed`) — count and oldest `created_at` — and
 *     its open NEEDS_REPAIR dead letters (spec 032, the predicate of
 *     `consoleListNeedsRepair`).
 *   - erpConnector: the tenant's connector registrations joined to their
 *     spec 020 health row (the `listConnectorHealth` join), liveness derived
 *     at read by `connector-health.liveness.ts`.
 *
 * Bound (D-4). Each check sets a transaction-local `statement_timeout` and
 * is also raced against a timer of the same length (that covers a wait for
 * a pool connection). A check that does not answer in time is that
 * component's `unknown` / `check_timed_out`, never a 500 and never `ok`. Any
 * other error propagates (500).
 *
 * Query cost. The undelivered predicate is written as
 * `delivery_state IN ('pending','failed') OR delivery_state = 'claimed'` so
 * the planner can BitmapOr the two existing partial indexes
 * (`outbox_events_drainer_claim_idx`, `outbox_events_stale_claim_idx`): the
 * scan covers only undelivered rows, never the delivered history. The
 * NEEDS_REPAIR count uses the tenant-led partial
 * `idx_sale_sync_deadletters_needs_repair_open`. No migration or index.
 *
 * Backend-Core makes no outbound ERPNext call here. Not audited (D-4).
 */
import { Inject, Injectable } from "@nestjs/common";
import { OUTBOX_EVENT_TYPES, runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import {
  type ConnectorRegistrationFacts,
  type ConsoleSystemStatus,
  type SaleSyncFacts,
  toConsoleSystemStatus,
} from "./console-system-status.projections";

/** DI token: the per-check bound in milliseconds (D-4). */
export const CONSOLE_SYSTEM_STATUS_CHECK_TIMEOUT_MS = Symbol("CONSOLE_SYSTEM_STATUS_CHECK_TIMEOUT_MS");
/** Default per-check bound. */
export const DEFAULT_CHECK_TIMEOUT_MS = 2000;

/** Postgres `query_canceled` (a `statement_timeout`). */
const QUERY_CANCELED = "57014";

const TIMED_OUT: unique symbol = Symbol("check_timed_out");
type TimedOut = typeof TIMED_OUT;

function isQueryCanceled(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === QUERY_CANCELED;
}

const UNDELIVERED_SQL = `
  SELECT count(*)::int AS undelivered_count,
         CASE WHEN count(*) = 0 THEN NULL
              ELSE GREATEST(0, floor(extract(epoch FROM (now() - min(created_at)))))::bigint
         END AS oldest_age_seconds
    FROM outbox_events
   WHERE event_type = $1
     AND (delivery_state IN ('pending', 'failed') OR delivery_state = 'claimed')
`;

const NEEDS_REPAIR_SQL = `
  SELECT count(*)::int AS needs_repair_count
    FROM sale_sync_deadletters
   WHERE classification = 'needs-repair'
     AND resolved_at IS NULL
`;

const REGISTRATIONS_SQL = `
  SELECT r.disabled_at       AS disabled_at,
         h.last_seen_at      AS last_seen_at,
         h.erpnext_reachable AS erpnext_reachable
    FROM connector_registration r
    LEFT JOIN connector_health h
      ON h.connector_registration_id = r.id
`;

@Injectable()
export class ConsoleSystemStatusService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONSOLE_SYSTEM_STATUS_CHECK_TIMEOUT_MS) private readonly checkTimeoutMs: number,
  ) {}

  /** The tenant's system status, computed on read at one `asOf`. */
  async read(input: { tenantId: string }): Promise<ConsoleSystemStatus> {
    const now = new Date();
    const [saleSync, registrations] = await Promise.all([
      this.bounded(input.tenantId, (client) => this.saleSyncFacts(client)),
      this.bounded(input.tenantId, (client) => this.registrations(client)),
    ]);
    return toConsoleSystemStatus(
      now,
      saleSync === TIMED_OUT ? null : saleSync,
      registrations === TIMED_OUT ? null : registrations,
    );
  }

  private async saleSyncFacts(client: PoolClient): Promise<SaleSyncFacts> {
    const undelivered = await client.query<{ undelivered_count: number; oldest_age_seconds: string | null }>(
      UNDELIVERED_SQL,
      [OUTBOX_EVENT_TYPES.SALE_CAPTURED],
    );
    const repair = await client.query<{ needs_repair_count: number }>(NEEDS_REPAIR_SQL);
    const u = undelivered.rows[0];
    return {
      undeliveredCount: u?.undelivered_count ?? 0,
      oldestUndeliveredAgeSeconds: u === undefined || u.oldest_age_seconds === null ? null : Number(u.oldest_age_seconds),
      needsRepairCount: repair.rows[0]?.needs_repair_count ?? 0,
    };
  }

  private async registrations(client: PoolClient): Promise<ConnectorRegistrationFacts[]> {
    const res = await client.query<{
      disabled_at: Date | null;
      last_seen_at: Date | null;
      erpnext_reachable: boolean | null;
    }>(REGISTRATIONS_SQL);
    return res.rows.map((r) => ({
      disabledAt: r.disabled_at,
      lastSeenAt: r.last_seen_at,
      erpnextReachable: r.erpnext_reachable,
    }));
  }

  /**
   * Run `work` under the tenant GUC within the check bound. A
   * `statement_timeout` cancel or the timer is `TIMED_OUT`; anything else
   * rejects.
   */
  private bounded<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T | TimedOut> {
    const ms = this.checkTimeoutMs;
    // Set when the timer wins: a check whose connection arrives after the
    // deadline returns at once (its transaction still ends and the client is
    // released by runWithTenantContext), so no status query runs for an
    // answer that was already sent.
    let abandoned = false;
    const check: Promise<T | TimedOut> = runWithTenantContext<T | TimedOut>(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      if (abandoned) return TIMED_OUT;
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${ms}ms`]);
      return work(client);
    }).catch((err: unknown): TimedOut => {
      if (isQueryCanceled(err)) return TIMED_OUT;
      throw err;
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<TimedOut>((resolve) => {
      timer = setTimeout(() => {
        abandoned = true;
        resolve(TIMED_OUT);
      }, ms);
    });
    // The losing side settles later; never leave its rejection unhandled.
    check.catch(() => undefined);
    return Promise.race([check, deadline]).finally(() => clearTimeout(timer));
  }
}
