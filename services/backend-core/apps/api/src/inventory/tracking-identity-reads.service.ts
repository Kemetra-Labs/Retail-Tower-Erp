/**
 * TrackingIdentityReadsService — Jira RT-1081 (RT-455 II-5 / II-2; owner
 * decision OD-6, RT-455 comment 15233). Contract: `inventory/inventory.yaml`
 * 1.9.0-draft, `getTrackingIdentity` and `getTrackingIdentityPositions`.
 *
 *   - getIdentity: one identity of the tenant, the `listTrackingIdentities`
 *     projection.
 *   - getPositions: compute-on-read signed sums of the movements that carry
 *     the identity, one row per store and stocking unit, each split into the
 *     six inventory statuses like `OnHand` and summed over the store's
 *     locations (OD-6: +5 at one location and -5 at another read as 0). A
 *     movement recorded before 0044 has no status and counts as `sellable`
 *     (G4-5). The caller's store scope (`callerStoreScope`) narrows the stores.
 *
 * An identity outside the tenant is a non-disclosing 404 (RLS hides it). The
 * role rule (owner / tenant_admin, else 404) is the controller's.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { INVENTORY_STATUSES, runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../auth/auth.module';
import { MembershipRepository } from '../context/membership.repository';
import { callerStoreScope, scopeStoreIds } from '../context/operator-store-scope';
import type { ResolvedContext } from '../context/types';
import { formatQuantity, parseQuantity } from './decimal-quantity';
import { toTrackingIdentityBody, type TrackingIdentityBody } from './inventory.service';

const SELLABLE = 'sellable';
const ZERO = '0.0000';

/** Contract `StatusQuantity`. */
interface StatusQuantityBody {
  readonly inventoryStatus: string;
  readonly quantity: string;
}

/** Contract `TrackingIdentityStorePosition`. */
export interface TrackingIdentityStorePositionBody {
  readonly storeId: string;
  readonly stockingUnit: string;
  readonly quantity: string;
  readonly sellableQuantity: string;
  readonly statusQuantities: StatusQuantityBody[];
}

/** Contract `TrackingIdentityPositions`. */
export interface TrackingIdentityPositionsBody {
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly stores: TrackingIdentityStorePositionBody[];
}

interface IdentityRow {
  id: string;
  tenant_product_ref: string;
  kind: string;
  code: string;
  expiry_date: string | null;
  manufactured_on: string | null;
  origin: string;
}

interface PositionRow {
  store_id: string;
  stocking_unit: string;
  inventory_status: string;
  quantity: string;
}

/**
 * Per store, stocking unit and status over every location (`$3` = the scoped
 * store ids, null when tenant-wide). Ordered so rows of one store and unit are
 * adjacent.
 */
const POSITIONS_SQL = `
  SELECT m.store_id::text AS store_id, m.stocking_unit,
         COALESCE(m.inventory_status, '${SELLABLE}') AS inventory_status,
         SUM(m.quantity)::numeric(19,4)::text AS quantity
    FROM stock_movements m
   WHERE m.tenant_id = $1 AND m.tracking_identity_id = $2
     AND ($3::uuid[] IS NULL OR m.store_id = ANY($3::uuid[]))
   GROUP BY m.store_id, m.stocking_unit, 3
   ORDER BY m.store_id, m.stocking_unit`;

@Injectable()
export class TrackingIdentityReadsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly memberships: MembershipRepository,
  ) {}

  getIdentity(tenantId: string, identityId: string): Promise<TrackingIdentityBody> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) =>
      toTrackingIdentityBody(await findIdentity(client, tenantId, identityId)),
    );
  }

  getPositions(input: {
    readonly tenantId: string;
    readonly identityId: string;
    readonly context: ResolvedContext;
  }): Promise<TrackingIdentityPositionsBody> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      const identity = await findIdentity(client, input.tenantId, input.identityId);
      const scope = await callerStoreScope(client, this.memberships, input);
      const r = await client.query<PositionRow>(POSITIONS_SQL, [input.tenantId, identity.id, scopeStoreIds(scope)]);
      return {
        trackingIdentityId: identity.id,
        tenantProductRef: identity.tenant_product_ref,
        stores: groupPositions(r.rows),
      };
    });
  }
}

/** The identity, or a non-disclosing 404. */
async function findIdentity(client: PoolClient, tenantId: string, identityId: string): Promise<IdentityRow> {
  const r = await client.query<IdentityRow>(
    `SELECT id, tenant_product_ref, kind, code, expiry_date::text AS expiry_date,
            manufactured_on::text AS manufactured_on, origin
       FROM tracking_identities
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, identityId],
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundException('Not Found');
  return row;
}

/** One position per (store, unit), its statuses in `INVENTORY_STATUSES` order. */
function groupPositions(rows: readonly PositionRow[]): TrackingIdentityStorePositionBody[] {
  const groups = new Map<string, PositionRow[]>();
  for (const row of rows) {
    const key = `${row.store_id}\u0000${row.stocking_unit}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const byStatus = new Map(group.map((row) => [row.inventory_status, row.quantity]));
    return {
      storeId: first.store_id,
      stockingUnit: first.stocking_unit,
      quantity: formatQuantity(group.reduce((sum, row) => sum + parseQuantity(row.quantity), 0n)),
      sellableQuantity: byStatus.get(SELLABLE) ?? ZERO,
      statusQuantities: INVENTORY_STATUSES.map((status) => ({
        inventoryStatus: status,
        quantity: byStatus.get(status) ?? ZERO,
      })),
    };
  });
}
