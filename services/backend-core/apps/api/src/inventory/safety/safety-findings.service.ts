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
 *     that stays off until RT-50 B1, so nothing emits it.
 *
 * Scope (H6). Positions carry a store; holds and identities do not. The
 * caller's store scope (`callerStoreScope`, RT-51 D6) filters positions, so a
 * store_manager sees an expired lot only at its stores, and a hold only when
 * the held identity has stock at one of them. A tenant-wide caller also sees
 * holds on identities with no stock (`storeIds` empty).
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

/** Contract `InventorySafetyFindingList`. */
export interface InventorySafetyFindingList {
  readonly findings: Array<ActiveTrackingHoldFinding | ExpiredLotSellableFinding>;
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
        return {
          findings: [...holds.rows.map(holdFinding), ...expired.rows.map(expiredFinding)],
          generatedAt: new Date().toISOString(),
        };
      },
    );
  }
}
