/**
 * ConsoleSalesByStoreService — RT-1053: the console sales by store
 * (`console-sales-by-store.openapi.yaml`, RT-1008) for the Admin-Console
 * «Sales by store» report. Read only.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant
 * RLS). Every figure is counted and summed in Postgres; the projection adds
 * the per-group sums together (exact BigInt decimals) and ranks.
 *
 * Invariants (the summary's, RT-649, by reference):
 *   - Tenant: RLS plus an explicit `tenant_id` predicate on every table; the
 *     tenant is the session's, never the request's (§II, §XII).
 *   - Store: the fact tables carry tenant-only RLS, so the operator-surface
 *     store scope (`operator-store-scope.ts`) is applied here as the `st`
 *     CTE, inactive and soft-deleted stores included (D-6). An empty scope
 *     matches nothing.
 *   - Scope size: the scoped stores are counted first, before any figure is
 *     read; more than 500 is `ScopeTooLargeError` (→ 400 `scope_too_large`).
 *   - One snapshot: every store of the scope and every fact of the range and
 *     of the baseline are read by ONE statement, so the store figures, the
 *     scope totals and the baseline always agree. `asOf` is
 *     `clock_timestamp()` read after it.
 *   - Business date: sales, voids and returns carry a stored business date;
 *     legacy refunds are bucketed by the local date of `refunded_at` in the
 *     store's current IANA timezone, inside a ±1 day UTC window.
 *   - Baseline (D-2): only received sales in the ranking currency, and only
 *     with `compare=previous_period`; with `none` it is not read.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import {
  assembleByStore,
  type ByStoreFactRow,
  type ByStoreStoreRow,
  type ConsoleSalesByStore,
} from "./console-sales-by-store.projections";
import { baselineOf, BY_STORE_MAX_STORES, ScopeTooLargeError, type Compare } from "./console-sales-by-store.query";
import { businessDatesOf } from "./console-sales-summary.query";
import type { ScopedReadInput } from "./console-sales.service";

export interface SalesByStoreInput extends ScopedReadInput {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly compare: Compare;
}

/** $1 tenant, $2 scoped store ids (null = every store of the tenant), $3 limit. */
const SCOPE_COUNT_SQL = `
  SELECT count(*)::int AS n FROM (
    SELECT 1 FROM stores
     WHERE tenant_id = $1::uuid AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
     LIMIT $3
  ) s`;

/**
 * $1 tenant, $2 scoped store ids (null = every store of the tenant), $3 from,
 * $4 to, $5 ranking currency, $6 baseline from (null = `compare=none`), $7
 * baseline to. One row per scoped store (`kind = 'store'`), then one row per
 * fact group. The UTC window `[from - 1 day, to + 2 days)` contains every
 * instant whose local date in any zone lies in the range.
 */
const BY_STORE_SQL = `
  WITH st AS MATERIALIZED (
    SELECT id, name, timezone, is_active, deleted_at IS NOT NULL AS deleted FROM stores
     WHERE tenant_id = $1::uuid AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
  ),
  win AS (
    SELECT ($3::date - 1)::timestamp AT TIME ZONE 'UTC' AS lo,
           ($4::date + 2)::timestamp AT TIME ZONE 'UTC' AS hi
  )
  SELECT 'store' AS kind, NULL::text AS period, st.id::text AS store_id, st.name, st.timezone,
         st.is_active, st.deleted, NULL::text AS business_date, NULL::text AS currency_code,
         0 AS n, NULL::text AS amount
    FROM st
  UNION ALL
  SELECT 'sale', 'range', s.store_id::text, NULL, NULL, NULL, NULL, s.business_date::text, s.currency_code::text,
         count(*)::int, sum(s.pos_total)::text
    FROM sales s
    JOIN st ON st.id = s.store_id
   WHERE s.tenant_id = $1::uuid AND s.business_date BETWEEN $3::date AND $4::date
   GROUP BY s.store_id, s.business_date, s.currency_code
  UNION ALL
  SELECT 'sale', 'baseline', s.store_id::text, NULL, NULL, NULL, NULL, s.business_date::text, s.currency_code::text,
         count(*)::int, sum(s.pos_total)::text
    FROM sales s
    JOIN st ON st.id = s.store_id
   WHERE $6::date IS NOT NULL AND s.tenant_id = $1::uuid AND s.currency_code = $5::text
     AND s.business_date BETWEEN $6::date AND $7::date
   GROUP BY s.store_id, s.business_date, s.currency_code
  UNION ALL
  SELECT 'void', 'range', v.store_id::text, NULL, NULL, NULL, NULL, v.business_date::text, s.currency_code::text,
         count(*)::int, sum(s.pos_total)::text
    FROM sale_voids v
    JOIN st ON st.id = v.store_id
    JOIN sales s ON s.id = v.sale_id AND s.tenant_id = v.tenant_id AND s.store_id = v.store_id
   WHERE v.tenant_id = $1::uuid AND v.business_date BETWEEN $3::date AND $4::date
   GROUP BY v.store_id, v.business_date, s.currency_code
  UNION ALL
  SELECT 'return', 'range', r.store_id::text, NULL, NULL, NULL, NULL, r.business_date::text, r.currency_code::text,
         count(*)::int, sum(r.return_total)::text
    FROM sale_returns r
    JOIN st ON st.id = r.store_id
   WHERE r.tenant_id = $1::uuid AND r.business_date BETWEEN $3::date AND $4::date
   GROUP BY r.store_id, r.business_date, r.currency_code
  UNION ALL
  SELECT 'refund', 'range', g.store_id::text, NULL, NULL, NULL, NULL, g.local_date::text, g.currency_code::text,
         count(*)::int, sum(g.amount)::text
    FROM (SELECT f.store_id, f.currency_code, f.pos_refund_amount AS amount,
                 (f.refunded_at AT TIME ZONE st.timezone)::date AS local_date
            FROM sale_refunds f
            JOIN st ON st.id = f.store_id
            CROSS JOIN win
           WHERE f.tenant_id = $1::uuid AND f.refunded_at >= win.lo AND f.refunded_at < win.hi) g
   WHERE g.local_date BETWEEN $3::date AND $4::date
   GROUP BY g.store_id, g.local_date, g.currency_code`;

/** Each zone's local date at `asOf` ($1), for `currentBusinessDate`. */
const CURRENT_DATES_SQL = `
  SELECT tz, (($1::timestamptz) AT TIME ZONE tz)::date::text AS local_date
    FROM unnest($2::text[]) AS tz`;

interface RawRow {
  readonly kind: ByStoreFactRow["kind"] | "store";
  readonly period: ByStoreFactRow["period"] | null;
  readonly store_id: string;
  readonly name: string | null;
  readonly timezone: string | null;
  readonly is_active: boolean | null;
  readonly deleted: boolean | null;
  readonly business_date: string | null;
  readonly currency_code: string | null;
  readonly n: number;
  readonly amount: string | null;
}

@Injectable()
export class ConsoleSalesByStoreService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** The report of every store in the caller's scope; the scope is resolved on every request. */
  async byStore(input: SalesByStoreInput): Promise<ConsoleSalesByStore> {
    const baseline = baselineOf(input.from, input.to);
    const compared = input.compare === "previous_period";
    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const storeIds = scopeStoreIds(await callerStoreScope(client, this.memberships, input));
        await this.assertScopeSize(client, input.tenantId, storeIds);

        const raw = await client.query<RawRow>(BY_STORE_SQL, [
          input.tenantId,
          storeIds,
          input.from,
          input.to,
          input.currency,
          compared ? baseline.from : null,
          compared ? baseline.to : null,
        ]);
        const storeRows = raw.rows.filter((r) => r.kind === "store");
        // READ COMMITTED: a store created after the count is in this snapshot; never truncate it.
        if (storeRows.length > BY_STORE_MAX_STORES) throw new ScopeTooLargeError();
        const facts = raw.rows.filter((r) => r.kind !== "store") as unknown as ByStoreFactRow[];

        const asOf = await this.readClock(client);
        const stores = await this.withLocalDates(client, asOf, storeRows);

        return assembleByStore({
          from: input.from,
          to: input.to,
          currency: input.currency,
          compare: input.compare,
          baseline,
          dates: businessDatesOf(input.from, input.to),
          asOf: asOf.toISOString(),
          stores,
          facts,
        });
      },
    );
  }

  /** D-9: more than 500 scoped stores is refused before any figure is read. */
  private async assertScopeSize(
    client: PoolClient,
    tenantId: string,
    storeIds: readonly string[] | null,
  ): Promise<void> {
    const r = await client.query<{ n: number }>(SCOPE_COUNT_SQL, [tenantId, storeIds, BY_STORE_MAX_STORES + 1]);
    if (r.rows[0]!.n > BY_STORE_MAX_STORES) throw new ScopeTooLargeError();
  }

  /** `asOf`: the server clock after the snapshot was read. */
  private async readClock(client: PoolClient): Promise<Date> {
    const r = await client.query<{ as_of: Date }>(`SELECT clock_timestamp() AS as_of`);
    return r.rows[0]!.as_of;
  }

  /** Each scoped store with its local date at `asOf` (`currentBusinessDate`). */
  private async withLocalDates(
    client: PoolClient,
    asOf: Date,
    storeRows: readonly RawRow[],
  ): Promise<ByStoreStoreRow[]> {
    const zones = [...new Set(storeRows.map((r) => r.timezone!))];
    if (zones.length === 0) return [];
    const r = await client.query<{ tz: string; local_date: string }>(CURRENT_DATES_SQL, [asOf, zones]);
    const today = new Map(r.rows.map((row) => [row.tz, row.local_date]));
    return storeRows.map((row) => ({
      store_id: row.store_id,
      name: row.name!,
      is_active: row.is_active!,
      deleted: row.deleted!,
      timezone: row.timezone!,
      current_business_date: today.get(row.timezone!)!,
    }));
  }
}
