/**
 * Source-position negative signal — Jira RT-1584 (RT-1125 R-30, R-31).
 *
 * A status move or relocation writes `-q` and `+q` at one store, so the
 * product's store on-hand never changes and `flagIfNegativeOnHand` (FR-024)
 * cannot see a move that took more than its source held. This probe reads the
 * SOURCE position instead — (store, product, location, status, identity) —
 * after the effects are written, in the move's transaction.
 *
 * Allow-and-flag (009 FR-024): a signal, never an error. The probe runs inside
 * its own savepoint, so a failed SELECT is rolled back to it and the move's
 * transaction stays usable (a JS try/catch alone would leave Postgres in an
 * aborted transaction and fail the move).
 *
 * Known limits (same as `flagIfNegativeOnHand` in v1): the probe runs under
 * READ COMMITTED with no position lock, so two concurrent moves from one source
 * each see only their own `-q` and can both miss the signal (holds 5, two moves
 * of 3: both read 2, the source ends at -1). The counter is incremented before
 * the caller commits, so a move whose later audit, outbox or commit step fails
 * is still counted. The audit row is exact for the moves that commit.
 */
import type { PoolClient } from 'pg';

import { parseQuantity } from '../../common/quantity/decimal-quantity';
import { recordInventoryPositionNegative } from './position-events.metrics';

/** The position a move took its quantity from. */
export interface SourcePosition {
  readonly storeId: string;
  readonly tenantProductRef: string;
  readonly fromLocationId: string;
  readonly fromStatus: string;
  readonly trackingIdentityId: string | null;
}

const SAVEPOINT = 'rt1584_source_position_probe';

/**
 * A movement recorded before positions existed reads as the store's primary
 * location and `sellable` (contract `OnHand`), so it counts at that position.
 */
const SOURCE_POSITION_SQL = `
  SELECT COALESCE(SUM(m.quantity), 0)::numeric(19,4)::text AS quantity
    FROM stock_movements m
   WHERE m.store_id = $1
     AND m.tenant_product_ref = $2
     AND COALESCE(m.stock_location_id,
                  (SELECT l.id FROM stock_locations l WHERE l.store_id = $1 AND l.kind = 'primary')) = $3
     AND COALESCE(m.inventory_status, 'sellable') = $4
     AND m.tracking_identity_id IS NOT DISTINCT FROM $5`;

/**
 * True, and `inventory_position_negative_total` incremented, when the source
 * position is below zero. Never throws.
 */
export async function flagIfSourcePositionNegative(client: PoolClient, source: SourcePosition): Promise<boolean> {
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  let quantity: string;
  try {
    const r = await client.query<{ quantity: string }>(SOURCE_POSITION_SQL, [
      source.storeId,
      source.tenantProductRef,
      source.fromLocationId,
      source.fromStatus,
      source.trackingIdentityId,
    ]);
    quantity = r.rows[0]?.quantity ?? '0';
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    return false;
  }
  await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
  const negative = parseQuantity(quantity) < 0n;
  if (negative) recordInventoryPositionNegative();
  return negative;
}
