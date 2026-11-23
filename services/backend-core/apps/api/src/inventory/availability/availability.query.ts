/**
 * RT-1576 (RT-1511 S1) — reads the Available-to-Sell facts of one (store, product) on the caller's tenant-scoped client
 * (RLS is already active) and composes them with `composeAvailability`. Compute-on-read, no stored projection, no new
 * table, no ERPNext read (A-9).
 *
 * One statement, so every figure comes from one snapshot. A movement recorded before 0044 has no location or status and
 * is read as (the store's primary location, `sellable`) (G4-5), like `getOnHand`.
 *
 * The store's business date is `store_business_date()` (0125, SECURITY INVOKER: a store of another tenant reads nothing).
 * A lot is sellable THROUGH its expiry date (G7-5), so only `expiry_date < business date` is expired.
 */
import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { composeAvailability } from './availability.rules';
import { LOT_EXPIRED_SQL, MOVEMENT_SELLABLE_AT_PRIMARY_SQL, RESERVATION_ACTIVE_SQL } from './availability.sql';
import type { AvailabilityBody } from './availability.types';

interface FactsRow {
  readonly primary_location_id: string;
  readonly primary_sellable: string;
  readonly expired_tracked_sellable: string;
  readonly active_reserved: string;
  readonly in_transit_inbound: string;
  readonly in_transit_outbound: string;
  readonly as_of: Date;
}

const FACTS_SQL = `
  WITH loc AS (
    SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'
  ),
  biz AS (SELECT store_business_date($1) AS d),
  sellable AS (
    SELECT COALESCE(SUM(m.quantity), 0) AS total,
           COALESCE(SUM(m.quantity) FILTER (WHERE ${LOT_EXPIRED_SQL}), 0) AS expired
      FROM loc
      CROSS JOIN biz
      LEFT JOIN stock_movements m
             ON m.store_id = $1
            AND m.tenant_product_ref = $2
            AND ${MOVEMENT_SELLABLE_AT_PRIMARY_SQL}
      LEFT JOIN tracking_identities ti ON ti.id = m.tracking_identity_id
  ),
  reserved AS (
    SELECT COALESCE(SUM(r.quantity), 0) AS total
      FROM loc
      LEFT JOIN inventory_reservations r
             ON r.store_id = $1
            AND r.tenant_product_ref = $2
            AND r.stock_location_id = loc.id
            AND ${RESERVATION_ACTIVE_SQL}
  ),
  transit AS (
    SELECT COALESCE(SUM(l.dispatched_quantity - l.received_quantity - l.short_closed_quantity)
                    FILTER (WHERE t.destination_store_id = $1), 0) AS inbound,
           COALESCE(SUM(l.dispatched_quantity - l.received_quantity - l.short_closed_quantity)
                    FILTER (WHERE t.source_store_id = $1), 0) AS outbound
      FROM shipment_transfer_lines l
      JOIN shipment_transfers t ON t.id = l.transfer_id AND t.tenant_id = l.tenant_id
     WHERE l.tenant_product_ref = $2
       AND (t.source_store_id = $1 OR t.destination_store_id = $1)
       AND t.state IN ('in_transit', 'partially_received')
  )
  SELECT loc.id AS primary_location_id,
         sellable.total::numeric(19,4)::text AS primary_sellable,
         sellable.expired::numeric(19,4)::text AS expired_tracked_sellable,
         reserved.total::numeric(19,4)::text AS active_reserved,
         transit.inbound::numeric(19,4)::text AS in_transit_inbound,
         transit.outbound::numeric(19,4)::text AS in_transit_outbound,
         clock_timestamp() AS as_of
    FROM loc, sellable, reserved, transit`;

export async function readAvailability(
  client: PoolClient,
  input: { readonly storeId: string; readonly productId: string },
): Promise<AvailabilityBody> {
  const result = await client.query<FactsRow>(FACTS_SQL, [input.storeId, input.productId]);
  const row = result.rows[0];
  // Every store has exactly one immutable primary location (0044); none means the store is not visible.
  if (!row) throw new NotFoundException('Not Found');
  return composeAvailability({
    primaryLocationId: row.primary_location_id,
    primarySellable: row.primary_sellable,
    expiredTrackedSellable: row.expired_tracked_sellable,
    activeReserved: row.active_reserved,
    inTransitInbound: row.in_transit_inbound,
    inTransitOutbound: row.in_transit_outbound,
    asOf: row.as_of,
  });
}
