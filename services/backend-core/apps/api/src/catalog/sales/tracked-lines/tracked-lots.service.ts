/**
 * Jira RT-451 slice S1 — the POS lot lookup (`posListTrackedLots`,
 * `pos-sales/tracked-lines.yaml` 1.0.0-draft; RT-50 G7-5, G7-13, Q10, Q12).
 *
 * For one product at the caller's store, the batch identities the till may
 * offer:
 *   - not expired at the store's business date, inclusive (G7-5): the
 *     business date is `now()` in the store's time zone, resolved by the
 *     server (the same rule as `expired_lot_sellable`, safety-findings.service);
 *   - not held: no active `quality_hold` or `recall_hold` (RT-449);
 *   - ordered by the contract's key: under `suggest`, lots with a positive
 *     sellable position first, then by expiry ascending (a lot without one
 *     last), then by `code` (byte order, so "lowest code" is deterministic);
 *     under `off`, by expiry then `code`;
 *   - with the advisory sellable position at the store (the identity's
 *     `sellable` movements, summed over the store's locations; one stocking
 *     unit per product and store, 0016), null until positions are live for
 *     the tenant (RT-427 sale-effects activation, `sale_effects_activated_at`).
 *
 * Read only: nothing is written, nothing is reserved, quantity never filters a
 * lot (Q12). A product that is not in the tenant is the non-disclosing 404
 * (`null` here), and so is every product while the tenant has not switched
 * tracked selling on (RT-451 S2, `tenant_inventory_settings`, 0086). A product that cannot be sold as a lot (tracking mode not
 * `batch`, retired or inactive) has no lots: a 200 with an empty list.
 *
 * Everything runs in ONE tenant-context transaction (RLS, FORCE on every table
 * read), so a cross-tenant id resolves to nothing.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../../auth/auth.module";
import {
  effectiveFefoPolicy,
  MAX_TRACKED_LOTS,
  toTrackedLotRows,
  type FefoPolicy,
  type OrderedLotRow,
  type TrackedLotRow,
} from "./tracked-lots.ranking";

/** Contract `TrackedLotList`. */
export interface TrackedLotList {
  readonly productId: string;
  readonly businessDate: string;
  readonly fefoPolicy: FefoPolicy;
  readonly safetyRevision: number;
  readonly lots: TrackedLotRow[];
}

interface ProductRow {
  readonly tracking_mode: string;
  readonly expiry_required: boolean;
  readonly sellable: boolean;
}

interface ContextRow {
  readonly business_date: string | null;
  readonly safety_revision: string;
  readonly positions_live: boolean;
}

/** RT-451 S2 (0086): the tenant's tracked-selling switch; no settings row reads OFF. */
const TENANT_SWITCH_SQL = `
  SELECT COALESCE((SELECT tracked_selling_enabled FROM tenant_inventory_settings WHERE tenant_id = $1), false)
           AS enabled`;

const PRODUCT_SQL = `
  SELECT tracking_mode, expiry_required, (is_active AND retired_at IS NULL) AS sellable
    FROM tenant_products
   WHERE id = $1 AND tenant_id = $2`;

const CONTEXT_SQL = `
  SELECT (SELECT (now() AT TIME ZONE s.timezone)::date::text
            FROM stores s WHERE s.id = $2 AND s.tenant_id = $1) AS business_date,
         COALESCE((SELECT revision FROM tenant_inventory_safety_revisions WHERE tenant_id = $1), 0)::text
           AS safety_revision,
         EXISTS (SELECT 1 FROM tenant_inventory_settings
                  WHERE tenant_id = $1 AND sale_effects_activated_at IS NOT NULL) AS positions_live`;

/**
 * `$1` tenant, `$2` product, `$3` store, `$4` business date, `$5` positions
 * live, `$6` positive-position-first (policy `suggest`), `$7` limit.
 */
const LOTS_SQL = `
  SELECT i.id::text AS identity_id, i.code, i.expiry_date::text AS expiry_date,
         CASE WHEN $5::boolean THEN COALESCE(pos.quantity, 0)::text END AS sellable_position
    FROM tracking_identities i
    LEFT JOIN LATERAL (
      SELECT SUM(m.quantity) AS quantity
        FROM stock_movements m
       WHERE m.tenant_id = i.tenant_id AND m.store_id = $3
         AND m.tracking_identity_id = i.id
         AND COALESCE(m.inventory_status, 'sellable') = 'sellable'
    ) pos ON true
   WHERE i.tenant_id = $1 AND i.tenant_product_ref = $2 AND i.kind = 'batch'
     AND (i.expiry_date IS NULL OR i.expiry_date >= $4::date)
     AND NOT EXISTS (
       SELECT 1 FROM tracking_holds h
        WHERE h.tenant_id = i.tenant_id AND h.tracking_identity_id = i.id AND h.released_at IS NULL)
   ORDER BY CASE WHEN $6::boolean AND $5::boolean AND COALESCE(pos.quantity, 0) > 0 THEN 0 ELSE 1 END,
            i.expiry_date ASC NULLS LAST, i.code COLLATE "C" ASC, i.id
   LIMIT $7`;

@Injectable()
export class TrackedLotsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** The lot list, or null when the product does not resolve in the tenant (404). */
  listLots(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId: string;
  }): Promise<TrackedLotList | null> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, (client) =>
      this.read(client, input),
    );
  }

  private async read(
    client: PoolClient,
    input: { readonly tenantId: string; readonly storeId: string; readonly productId: string },
  ): Promise<TrackedLotList | null> {
    // RT-451 S2: tracked selling is in effect only when the tenant has switched
    // it on (the deployment gate is the controller's); off is the same 404.
    const tenantSwitch = await client.query<{ enabled: boolean }>(TENANT_SWITCH_SQL, [input.tenantId]);
    if (tenantSwitch.rows[0]?.enabled !== true) return null;
    const product = (await client.query<ProductRow>(PRODUCT_SQL, [input.productId, input.tenantId])).rows[0];
    if (!product) return null;
    const context = (await client.query<ContextRow>(CONTEXT_SQL, [input.tenantId, input.storeId])).rows[0];
    // The store comes from the credential; a store outside the tenant is the same 404.
    if (!context || context.business_date === null) return null;

    const policy = effectiveFefoPolicy({ expiryRequired: product.expiry_required });
    const base = {
      productId: input.productId,
      businessDate: context.business_date,
      fefoPolicy: policy,
      safetyRevision: Number(context.safety_revision),
    };
    if (product.tracking_mode !== "batch" || !product.sellable) return { ...base, lots: [] };

    const rows = await client.query<OrderedLotRow>(LOTS_SQL, [
      input.tenantId,
      input.productId,
      input.storeId,
      context.business_date,
      context.positions_live,
      policy === "suggest",
      MAX_TRACKED_LOTS,
    ]);
    return { ...base, lots: toTrackedLotRows(rows.rows, policy) };
  }
}
