/**
 * ConsoleLowStockService — RT-1069: the runtime of `consoleListLowStock`
 * (`inventory/low-stock.yaml`; decision records
 * `docs/planning/rt-1055-low-stock-severity-read.md` LS-1 to LS-5 and
 * `docs/planning/rt-1064-low-stock-thresholds.md` TH-3). Read only.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant
 * RLS, `isPlatformAdmin: false`) plus an explicit `tenant_id` predicate on
 * every table; the tenant is the session's, never the request's (§II, §XII).
 * Nothing is read from or sent to ERPNext: thresholds come from
 * `product_stock_levels` (RT-1066, 0078) only.
 *
 * Invariants:
 *   - Store scope: the operator-surface store scope
 *     (`operator-store-scope.ts`), applied here as the `st` CTE (live stores
 *     only; an inactive store is evaluated). An empty scope matches nothing.
 *     A `store_id` outside the scope, of another tenant or soft-deleted is
 *     `LowStockNotFoundError` (→ the non-disclosing 404), checked before any
 *     position is read.
 *   - Evaluated pairs (LS-1, LS-4): a live scoped store × a product that is
 *     not retired and `is_active`, available at the store (Tenant ⊕ Store
 *     Override `is_active`, the `store-product-resolution.ts` rule) and that
 *     has a resolved reorder level. A pair with no active level at either
 *     layer is never evaluated and never counted: no threshold is invented.
 *   - Threshold resolution (TH-3): per PAIR. An active store level supplies
 *     both levels (`thresholdSource: store`, its `criticalLevel` may be
 *     null); otherwise the active tenant level supplies both (`tenant`).
 *   - On-hand (LS-3): the `sellable` share of the pair's recorded movements
 *     over every location (a movement with no status counts as `sellable`,
 *     RT-432 G4-5). A pair with no movement at all is `unknown`: counted,
 *     never listed, never shown as zero. A negative sellable on-hand is
 *     counted, never listed or ranked.
 *   - Severity (LS-2): low when `sellable < reorder`, critical when also
 *     `sellable < critical` (both strict). Order: critical first, then the
 *     exact ratio ascending, then `storeId`, then `productId`. The ratio key
 *     is `div(sellable * 10^40, reorder)`: both are `numeric(19,4)`, so two
 *     distinct ratios differ by more than 10^-38 and the truncated key keeps
 *     their order exactly. The wire ratio is `div(sellable * 10^4, reorder)`
 *     (truncated toward zero, 4 digits, at most `0.9999`).
 *   - One snapshot: every count and every item come from ONE statement, so
 *     the counts and the items always agree. `asOf` is that statement's
 *     `statement_timestamp()`: every movement committed by then is visible
 *     to the statement's snapshot.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { MembershipRepository } from "../../context/membership.repository";
import { callerStoreScope, inStoreScope, scopeStoreIds } from "../../context/operator-store-scope";
import type { ResolvedContext } from "../../context/types";

/** One listed pair on the wire (`LowStockItem`). */
export interface LowStockItem {
  readonly storeId: string;
  readonly storeName: string;
  readonly storeStatus: "active" | "inactive";
  readonly productId: string;
  readonly productName: string;
  readonly stockingUnit: string | null;
  readonly sellableOnHand: string;
  readonly reorderLevel: string;
  readonly criticalLevel: string | null;
  readonly thresholdSource: "tenant" | "store";
  readonly band: "critical" | "low";
  readonly levelRatio: string;
}

/** `ConsoleLowStockList`. */
export interface ConsoleLowStockList {
  readonly asOf: string;
  readonly completeness: "received_only";
  readonly storeId: string | null;
  readonly limit: number;
  readonly evaluatedCount: number;
  readonly belowReorderCount: number;
  readonly criticalCount: number;
  readonly unknownOnHandCount: number;
  readonly negativeOnHandCount: number;
  readonly truncated: boolean;
  readonly items: LowStockItem[];
}

/** A `store_id` outside the caller's scope, of another tenant or soft-deleted → 404. */
export class LowStockNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "LowStockNotFoundError";
  }
}

export interface LowStockInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
  /** Lower-case; null = every store of the scope. */
  readonly storeId: string | null;
  readonly limit: number;
}

/** One listed pair as the statement returns it (inside the `items` JSON array). */
export interface LowStockItemRow {
  readonly store_id: string;
  readonly store_name: string;
  readonly store_active: boolean;
  readonly product_id: string;
  readonly product_name: string;
  readonly stocking_unit: string | null;
  readonly sellable: string;
  readonly reorder_level: string;
  readonly critical_level: string | null;
  readonly threshold_source: "tenant" | "store";
  readonly critical: boolean;
  /** `div(sellable * 10^4, reorder)`: 0..9999. */
  readonly ratio_digits: number;
}

interface LowStockRow {
  readonly as_of: Date;
  readonly evaluated_count: number;
  readonly below_reorder_count: number;
  readonly critical_count: number;
  readonly unknown_count: number;
  readonly negative_count: number;
  readonly items: LowStockItemRow[];
}

const LIVE_STORE_SQL = `SELECT 1 FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`;

/**
 * $1 tenant, $2 scoped store ids (null = every store of the tenant), $3 limit.
 * One row: the snapshot time, the scope's counts and the first `$3` low pairs
 * in contract order.
 */
const LOW_STOCK_SQL = `
  WITH st AS MATERIALIZED (
    SELECT id, name, is_active FROM stores
     WHERE tenant_id = $1::uuid AND deleted_at IS NULL
       AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
  ),
  lv AS MATERIALIZED (
    SELECT psl.store_id, psl.product_id, psl.reorder_level, psl.critical_level
      FROM product_stock_levels psl
     WHERE psl.tenant_id = $1::uuid AND psl.retired_at IS NULL
       AND (psl.store_id IS NULL OR psl.store_id IN (SELECT id FROM st))
  ),
  pairs AS (
    SELECT st.id AS store_id, t.product_id FROM st CROSS JOIN lv t WHERE t.store_id IS NULL
    UNION
    SELECT s.store_id, s.product_id FROM lv s WHERE s.store_id IS NOT NULL
  ),
  ev AS MATERIALIZED (
    SELECT p.store_id, st.name AS store_name, st.is_active AS store_active,
           p.product_id, tp.name AS product_name,
           CASE WHEN sl.product_id IS NOT NULL THEN 'store' ELSE 'tenant' END AS threshold_source,
           CASE WHEN sl.product_id IS NOT NULL THEN sl.reorder_level ELSE tl.reorder_level END AS reorder_level,
           CASE WHEN sl.product_id IS NOT NULL THEN sl.critical_level ELSE tl.critical_level END AS critical_level
      FROM pairs p
      JOIN st ON st.id = p.store_id
      JOIN tenant_products tp
        ON tp.tenant_id = $1::uuid AND tp.id = p.product_id AND tp.retired_at IS NULL AND tp.is_active
      LEFT JOIN lv sl ON sl.store_id = p.store_id AND sl.product_id = p.product_id
      LEFT JOIN lv tl ON tl.store_id IS NULL AND tl.product_id = p.product_id
      LEFT JOIN store_product_overrides spo
        ON spo.tenant_id = $1::uuid AND spo.store_id = p.store_id AND spo.product_id = p.product_id
       AND spo.retired_at IS NULL
     WHERE COALESCE(spo.is_active, tp.is_active)
  ),
  oh AS MATERIALIZED (
    SELECT ev.*, m.movement_count, m.sellable, m.stocking_unit
      FROM ev
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS movement_count,
               COALESCE(sum(sm.quantity) FILTER (WHERE COALESCE(sm.inventory_status, 'sellable') = 'sellable'), 0)
                 ::numeric(19,4) AS sellable,
               min(sm.stocking_unit) AS stocking_unit
          FROM stock_movements sm
         WHERE sm.tenant_id = $1::uuid AND sm.store_id = ev.store_id AND sm.tenant_product_ref = ev.product_id
      ) m
  ),
  low AS (
    SELECT oh.*,
           (oh.critical_level IS NOT NULL AND oh.sellable < oh.critical_level) AS critical,
           div(oh.sellable * '1e40'::numeric, oh.reorder_level) AS ratio_key
      FROM oh
     WHERE oh.movement_count > 0 AND oh.sellable >= 0 AND oh.sellable < oh.reorder_level
  ),
  head_n AS (
    SELECT * FROM low ORDER BY critical DESC, ratio_key, store_id, product_id LIMIT $3
  )
  SELECT statement_timestamp() AS as_of,
         (SELECT count(*)::int FROM oh) AS evaluated_count,
         (SELECT count(*)::int FROM low) AS below_reorder_count,
         (SELECT count(*)::int FROM low WHERE critical) AS critical_count,
         (SELECT count(*)::int FROM oh WHERE movement_count = 0) AS unknown_count,
         (SELECT count(*)::int FROM oh WHERE movement_count > 0 AND sellable < 0) AS negative_count,
         (SELECT COALESCE(json_agg(json_build_object(
                    'store_id', t.store_id::text,
                    'store_name', t.store_name,
                    'store_active', t.store_active,
                    'product_id', t.product_id::text,
                    'product_name', t.product_name,
                    'stocking_unit', t.stocking_unit,
                    'sellable', t.sellable::text,
                    'reorder_level', t.reorder_level::text,
                    'critical_level', t.critical_level::text,
                    'threshold_source', t.threshold_source,
                    'critical', t.critical,
                    'ratio_digits', div(t.sellable * 10000, t.reorder_level)::int
                  ) ORDER BY t.critical DESC, t.ratio_key, t.store_id, t.product_id), '[]'::json)
            FROM head_n t) AS items`;

/** `ratio_digits` (0..9999) as the contract's `LevelRatio` (`"0.0000"`..`"0.9999"`). */
export function levelRatioOf(ratioDigits: number): string {
  if (!Number.isInteger(ratioDigits) || ratioDigits < 0 || ratioDigits > 9999) {
    throw new Error(`low-stock: ratio digits out of range: ${ratioDigits}`);
  }
  return `0.${String(ratioDigits).padStart(4, "0")}`;
}

export function toLowStockItem(row: LowStockItemRow): LowStockItem {
  return {
    storeId: row.store_id,
    storeName: row.store_name,
    storeStatus: row.store_active ? "active" : "inactive",
    productId: row.product_id,
    productName: row.product_name,
    stockingUnit: row.stocking_unit,
    sellableOnHand: row.sellable,
    reorderLevel: row.reorder_level,
    criticalLevel: row.critical_level,
    thresholdSource: row.threshold_source,
    band: row.critical ? "critical" : "low",
    levelRatio: levelRatioOf(row.ratio_digits),
  };
}

@Injectable()
export class ConsoleLowStockService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** consoleListLowStock — the scope's top `limit` low pairs and its counts, from one snapshot. */
  async list(input: LowStockInput): Promise<ConsoleLowStockList> {
    return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      const scope = await callerStoreScope(client, this.memberships, input);
      let stores: readonly string[] | null = scopeStoreIds(scope);
      if (input.storeId !== null) {
        if (!inStoreScope(scope, input.storeId)) throw new LowStockNotFoundError();
        const live = await client.query(LIVE_STORE_SQL, [input.storeId, input.tenantId]);
        if (live.rowCount === 0) throw new LowStockNotFoundError();
        stores = [input.storeId];
      }
      // Tenant-wide store GUC for the override join; the explicit `st` predicate bounds the rows.
      await client.query("SELECT set_config('app.current_store', '*', true)");
      const r = await client.query<LowStockRow>(LOW_STOCK_SQL, [
        input.tenantId,
        stores === null ? null : [...stores],
        input.limit,
      ]);
      const row = r.rows[0];
      if (row === undefined) throw new Error("low-stock: the statement returned no row");
      const items = row.items.map(toLowStockItem);
      return {
        asOf: row.as_of.toISOString(),
        completeness: "received_only",
        storeId: input.storeId,
        limit: input.limit,
        evaluatedCount: row.evaluated_count,
        belowReorderCount: row.below_reorder_count,
        criticalCount: row.critical_count,
        unknownOnHandCount: row.unknown_count,
        negativeOnHandCount: row.negative_count,
        truncated: row.below_reorder_count > items.length,
        items,
      };
    });
  }
}
