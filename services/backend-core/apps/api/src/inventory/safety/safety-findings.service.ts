/**
 * Inventory safety findings — Jira RT-449 PR 2 (RT-50 G7-5 / G7-6; ruling H6,
 * RT-449 comment 13434; decisions 953, 954).
 * Contract: `listInventorySafetyFindings` in `inventory/inventory.yaml`.
 *
 * Computed on read, never stored:
 *   - `active_tracking_hold` (critical, 954): every active hold, with the
 *     stores where the held identity has a non-zero position;
 *   - `expired_lot_sellable` (critical, 953): an identity whose `sellable`
 *     quantity at a store is positive while its expiry date is before the
 *     store's local business date. A lot is sellable THROUGH its expiry date
 *     (G7-5), so the expiry day itself is not a finding;
 *   - `expiring_lot` is reserved: the near-expiry window is a policy value
 *     that stays off until RT-50 B1, so nothing emits it;
 *   - `tracking_consistency` (critical, OD-8; RT-453, G7-12 / 956): a tracked
 *     product or identity whose records disagree, one finding per `check`
 *     grain:
 *       * `identity_without_edge_map` (per identity, tenant-wide): an identity
 *         with no ERP edge-map row;
 *       * `untracked_effect_on_tracked_product` (per product × store × unit):
 *         an effect without an identity on a product whose mode is not `none`;
 *       * `serial_position_out_of_range` (per identity × store × unit): a
 *         serial identity's position summed over the store's locations and
 *         statuses outside {0, 1};
 *       * `profile_erp_flag_mismatch` (per product, tenant-wide): the ERP Item
 *         flags reported with a store's latest complete Bin snapshot disagree
 *         with the Catalog Tracking Profile (G7-1: `batch` ⇔ `hasBatchNo`,
 *         `serial` ⇔ `hasSerialNo`, `expiryRequired` ⇒ `hasExpiryDate`). An
 *         entry without `tracking` is UNKNOWN and is not compared.
 *
 * Scope (H6). Positions carry a store; holds and identities do not. The
 * caller's store scope (`callerStoreScope`, RT-51 D6) filters positions, so a
 * store_manager sees an expired lot only at its stores, and a hold only when
 * the held identity has stock at one of them. A tenant-wide caller also sees
 * holds on identities with no stock (`storeIds` empty). A tenant-wide
 * tracking-consistency finding (`storeId` null) is shown to a tenant-wide
 * caller only.
 */
import { Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { MembershipRepository } from '../../context/membership.repository';
import { callerStoreScope, scopeStoreIds } from '../../context/operator-store-scope';
import type { ResolvedContext } from '../../context/types';
import { formatQuantity, parseQuantity } from '../decimal-quantity';

/** Contract `ActiveTrackingHoldFinding`. */
export interface ActiveTrackingHoldFinding {
  readonly kind: 'active_tracking_hold';
  readonly severity: 'critical';
  readonly holdId: string;
  readonly holdKind: string;
  readonly recallId: string | null;
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly identityKind: string;
  readonly identityCode: string;
  readonly expiryDate: string | null;
  readonly placedAt: string;
  readonly storeIds: string[];
}

/** Contract `ExpiredLotSellableFinding`. */
export interface ExpiredLotSellableFinding {
  readonly kind: 'expired_lot_sellable';
  readonly severity: 'critical';
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly identityKind: string;
  readonly identityCode: string;
  readonly expiryDate: string;
  readonly storeId: string;
  readonly storeBusinessDate: string;
  readonly sellableQuantity: string;
  readonly stockingUnit: string;
}

/** Contract `TrackingConsistencyFinding` `check`. */
type TrackingConsistencyCheck =
  | 'identity_without_edge_map'
  | 'untracked_effect_on_tracked_product'
  | 'serial_position_out_of_range'
  | 'profile_erp_flag_mismatch';

/** Contract `TrackingConsistencyFinding`. */
export interface TrackingConsistencyFinding {
  readonly kind: 'tracking_consistency';
  readonly severity: 'critical';
  readonly check: TrackingConsistencyCheck;
  readonly tenantProductRef: string;
  readonly trackingIdentityId: string | null;
  readonly storeId: string | null;
  readonly stockingUnit: string | null;
}

/** Contract `InventorySafetyFindingList`. */
export interface InventorySafetyFindingList {
  readonly findings: Array<ActiveTrackingHoldFinding | ExpiredLotSellableFinding | TrackingConsistencyFinding>;
  readonly generatedAt: string;
}

interface HoldFindingRow {
  readonly hold_id: string;
  readonly hold_kind: string;
  readonly recall_id: string | null;
  readonly tracking_identity_id: string;
  readonly tenant_product_ref: string;
  readonly identity_kind: string;
  readonly identity_code: string;
  readonly expiry_date: string | null;
  readonly placed_at: Date;
  readonly store_ids: string[];
}

interface ExpiredRow {
  readonly tracking_identity_id: string;
  readonly tenant_product_ref: string;
  readonly identity_kind: string;
  readonly identity_code: string;
  readonly expiry_date: string;
  readonly store_id: string;
  readonly business_date: string;
  readonly quantity: string;
  readonly stocking_unit: string;
}

/**
 * Active holds with the in-scope stores holding a non-zero position of the
 * identity (`$2` = the scoped store ids, null when tenant-wide). With a store
 * scope, a hold without stock in it is left out.
 */
const HOLD_FINDINGS_SQL = `
  WITH positions AS (
    SELECT m.tracking_identity_id, m.store_id
      FROM stock_movements m
     WHERE m.tenant_id = $1 AND m.tracking_identity_id IS NOT NULL
       AND ($2::uuid[] IS NULL OR m.store_id = ANY($2::uuid[]))
     GROUP BY m.tracking_identity_id, m.store_id, m.stock_location_id,
              COALESCE(m.inventory_status, 'sellable'), m.stocking_unit
    HAVING SUM(m.quantity) <> 0
  )
  SELECT h.id AS hold_id, h.kind AS hold_kind, h.recall_id, h.tracking_identity_id,
         h.tenant_product_ref, i.kind AS identity_kind, i.code AS identity_code,
         i.expiry_date::text AS expiry_date, h.placed_at,
         COALESCE(array_agg(DISTINCT p.store_id::text) FILTER (WHERE p.store_id IS NOT NULL), '{}')
           AS store_ids
    FROM tracking_holds h
    JOIN tracking_identities i ON i.id = h.tracking_identity_id AND i.tenant_id = h.tenant_id
    LEFT JOIN positions p ON p.tracking_identity_id = h.tracking_identity_id
   WHERE h.tenant_id = $1 AND h.released_at IS NULL
   GROUP BY h.id, i.id
  HAVING $2::uuid[] IS NULL OR count(p.store_id) > 0
   ORDER BY h.id`;

/**
 * Per identity, store and stocking unit: the positive `sellable` quantity of
 * an identity whose expiry date is before the store's local business date.
 */
const EXPIRED_SELLABLE_SQL = `
  SELECT i.id AS tracking_identity_id, i.tenant_product_ref, i.kind AS identity_kind,
         i.code AS identity_code, i.expiry_date::text AS expiry_date, m.store_id,
         biz.business_date::text AS business_date, SUM(m.quantity)::text AS quantity, m.stocking_unit
    FROM stock_movements m
    JOIN tracking_identities i ON i.id = m.tracking_identity_id AND i.tenant_id = m.tenant_id
    JOIN stores s ON s.id = m.store_id AND s.tenant_id = m.tenant_id
   CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE s.timezone)::date AS business_date) biz
   WHERE m.tenant_id = $1 AND m.tracking_identity_id IS NOT NULL
     AND COALESCE(m.inventory_status, 'sellable') = 'sellable'
     AND i.expiry_date < biz.business_date
     AND ($2::uuid[] IS NULL OR m.store_id = ANY($2::uuid[]))
   GROUP BY i.id, m.store_id, biz.business_date, m.stocking_unit
  HAVING SUM(m.quantity) > 0
   ORDER BY i.id, m.store_id, m.stocking_unit`;

interface ConsistencyRow {
  readonly check: TrackingConsistencyCheck;
  readonly tenant_product_ref: string;
  readonly tracking_identity_id: string | null;
  readonly store_id: string | null;
  readonly stocking_unit: string | null;
}

/**
 * The four tracking-consistency checks (RT-453), one row per grain, ordered by
 * check then ids. `$2` = the scoped store ids (null when tenant-wide); the
 * tenant-wide checks (`storeId` null) run only for a tenant-wide caller.
 */
const TRACKING_CONSISTENCY_SQL = `
  WITH latest_snap AS (
    SELECT DISTINCT ON (r.store_id) r.summary->'bin_view_report' AS rep
      FROM erpnext_reconciliation_run r
     WHERE r.tenant_id = $1 AND r.kind = 'stock'
       AND jsonb_typeof(r.summary->'bin_view_report') = 'object'
       AND jsonb_typeof(r.summary->'bin_view_report'->'recordedAt') = 'string'
       AND (r.summary->'bin_view_report'->'complete') IS DISTINCT FROM 'false'::jsonb
     ORDER BY r.store_id, (r.summary->'bin_view_report'->>'recordedAt')::timestamptz DESC, r.id DESC
  ),
  evidence AS (
    SELECT (e.value->>'tenant_product_ref')::uuid AS product,
           COALESCE((e.value->'tracking'->>'hasBatchNo')::boolean, false) AS has_batch,
           COALESCE((e.value->'tracking'->>'hasSerialNo')::boolean, false) AS has_serial,
           COALESCE((e.value->'tracking'->>'hasExpiryDate')::boolean, false) AS has_expiry
      FROM latest_snap, jsonb_array_elements(COALESCE(latest_snap.rep->'entries', '[]'::jsonb)) AS e(value)
     WHERE e.value->>'tenant_product_ref' IS NOT NULL
       AND jsonb_typeof(e.value->'tracking') = 'object'
  )
  SELECT 'identity_without_edge_map' AS check, i.tenant_product_ref, i.id AS tracking_identity_id,
         NULL::uuid AS store_id, NULL::text AS stocking_unit
    FROM tracking_identities i
   WHERE i.tenant_id = $1 AND $2::uuid[] IS NULL
     AND NOT EXISTS (SELECT 1 FROM erpnext_tracking_map m WHERE m.tracking_identity_id = i.id)
  UNION ALL
  SELECT 'untracked_effect_on_tracked_product', m.tenant_product_ref, NULL::uuid, m.store_id, m.stocking_unit
    FROM stock_movements m
    JOIN tenant_products p ON p.id = m.tenant_product_ref AND p.tenant_id = m.tenant_id
   WHERE m.tenant_id = $1 AND m.tracking_identity_id IS NULL AND p.tracking_mode <> 'none'
     AND ($2::uuid[] IS NULL OR m.store_id = ANY($2::uuid[]))
   GROUP BY m.tenant_product_ref, m.store_id, m.stocking_unit
  UNION ALL
  SELECT 'serial_position_out_of_range', i.tenant_product_ref, i.id, m.store_id, m.stocking_unit
    FROM stock_movements m
    JOIN tracking_identities i ON i.id = m.tracking_identity_id AND i.tenant_id = m.tenant_id AND i.kind = 'serial'
   WHERE m.tenant_id = $1
     AND ($2::uuid[] IS NULL OR m.store_id = ANY($2::uuid[]))
   GROUP BY i.tenant_product_ref, i.id, m.store_id, m.stocking_unit
  HAVING SUM(m.quantity) NOT IN (0, 1)
  UNION ALL
  SELECT DISTINCT 'profile_erp_flag_mismatch', p.id, NULL::uuid, NULL::uuid, NULL::text
    FROM evidence ev
    JOIN tenant_products p ON p.id = ev.product AND p.tenant_id = $1
   WHERE $2::uuid[] IS NULL
     AND NOT (CASE p.tracking_mode
                WHEN 'none' THEN NOT ev.has_batch AND NOT ev.has_serial
                WHEN 'batch' THEN ev.has_batch AND NOT ev.has_serial AND (NOT p.expiry_required OR ev.has_expiry)
                WHEN 'serial' THEN ev.has_serial AND NOT ev.has_batch
                ELSE false END)
  ORDER BY 1, 2, 3 NULLS FIRST, 4 NULLS FIRST, 5 NULLS FIRST`;

function consistencyFinding(row: ConsistencyRow): TrackingConsistencyFinding {
  return {
    kind: 'tracking_consistency',
    severity: 'critical',
    check: row.check,
    tenantProductRef: row.tenant_product_ref,
    trackingIdentityId: row.tracking_identity_id,
    storeId: row.store_id,
    stockingUnit: row.stocking_unit,
  };
}

function holdFinding(row: HoldFindingRow): ActiveTrackingHoldFinding {
  return {
    kind: 'active_tracking_hold',
    severity: 'critical',
    holdId: row.hold_id,
    holdKind: row.hold_kind,
    recallId: row.recall_id,
    trackingIdentityId: row.tracking_identity_id,
    tenantProductRef: row.tenant_product_ref,
    identityKind: row.identity_kind,
    identityCode: row.identity_code,
    expiryDate: row.expiry_date,
    placedAt: row.placed_at.toISOString(),
    storeIds: [...row.store_ids].sort(),
  };
}

function expiredFinding(row: ExpiredRow): ExpiredLotSellableFinding {
  return {
    kind: 'expired_lot_sellable',
    severity: 'critical',
    trackingIdentityId: row.tracking_identity_id,
    tenantProductRef: row.tenant_product_ref,
    identityKind: row.identity_kind,
    identityCode: row.identity_code,
    expiryDate: row.expiry_date,
    storeId: row.store_id,
    storeBusinessDate: row.business_date,
    sellableQuantity: formatQuantity(parseQuantity(row.quantity)),
    stockingUnit: row.stocking_unit,
  };
}

@Injectable()
export class SafetyFindingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly memberships: MembershipRepository,
  ) {}

  /** The tenant's current safety findings in the caller's store scope. */
  listFindings(input: {
    readonly tenantId: string;
    readonly context: ResolvedContext;
  }): Promise<InventorySafetyFindingList> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const scope = await callerStoreScope(client, this.memberships, input);
        const params = [input.tenantId, scopeStoreIds(scope)];
        const holds = await client.query<HoldFindingRow>(HOLD_FINDINGS_SQL, params);
        const expired = await client.query<ExpiredRow>(EXPIRED_SELLABLE_SQL, params);
        const consistency = await client.query<ConsistencyRow>(TRACKING_CONSISTENCY_SQL, params);
        return {
          findings: [
            ...holds.rows.map(holdFinding),
            ...expired.rows.map(expiredFinding),
            ...consistency.rows.map(consistencyFinding),
          ],
          generatedAt: new Date().toISOString(),
        };
      },
    );
  }
}
