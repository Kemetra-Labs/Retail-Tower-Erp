/**
 * Source-position negative signal — Jira RT-1584 (RT-1125 R-30, R-31).
 *
 * A status move or relocation writes `-q` and `+q` at one store, so the
 * product's store on-hand never changes and `flagIfNegativeOnHand` (FR-024)
 * cannot see a move that took more than its source held. This probe reads the
 * SOURCE position instead — (store, product, location, status, identity) —
 * after the effects are written, in the move's transaction.
 *
 * Allow-and-flag (009 FR-024): a signal, never an error. Every statement of the
 * probe (SAVEPOINT, SELECT, RELEASE) runs inside one try, so a failed probe is
 * rolled back to its savepoint, logged and answered `null` ("unknown", never a
 * false "not negative"), and the move's transaction stays usable. A JS
 * try/catch alone would leave Postgres in an aborted transaction. If even the
 * savepoint cannot be set or rolled back, the transaction was already broken
 * and the caller's next statement fails, as it would without this probe.
 *
 * Known limits (same as `flagIfNegativeOnHand` in v1): the probe runs under
 * READ COMMITTED with no position lock, so two concurrent moves from one source
 * each see only their own `-q` and can both miss the signal (holds 5, two moves
 * of 3: both read 2, the source ends at -1). The counter is incremented before
 * the caller commits, so a move whose later audit, outbox or commit step fails
 * is still counted. The audit row is exact for the moves that commit.
 */
import type { Logger } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';

import { createApiLogger } from '../../common/api-logger';
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
 * The sum is compared with zero unnarrowed: a cast to numeric(19,4) could
 * overflow on a large negative sum and hide it.
 */
const SOURCE_POSITION_SQL = `
  SELECT COALESCE(SUM(m.quantity), 0) < 0 AS negative
    FROM stock_movements m
   WHERE m.store_id = $1
     AND m.tenant_product_ref = $2
     AND COALESCE(m.stock_location_id,
                  (SELECT l.id FROM stock_locations l WHERE l.store_id = $1 AND l.kind = 'primary')) = $3
     AND COALESCE(m.inventory_status, 'sellable') = $4
     AND m.tracking_identity_id IS NOT DISTINCT FROM $5`;

let defaultLogger: Pick<Logger, 'warn'> | undefined;

function logger(): Pick<Logger, 'warn'> {
  defaultLogger ??= createApiLogger('inventory.position-events');
  return defaultLogger;
}

/**
 * `true`, and `inventory_position_negative_total` incremented, when the source
 * position is below zero; `false` when it is not; `null` when the probe failed
 * (logged). Never throws.
 */
export async function flagIfSourcePositionNegative(
  client: PoolClient,
  source: SourcePosition,
): Promise<boolean | null> {
  let negative: boolean;
  try {
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    const r = await client.query<{ negative: boolean }>(SOURCE_POSITION_SQL, [
      source.storeId,
      source.tenantProductRef,
      source.fromLocationId,
      source.fromStatus,
      source.trackingIdentityId,
    ]);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    negative = r.rows[0]?.negative === true;
  } catch (err: unknown) {
    await rollBackQuietly(client);
    logger().warn(
      {
        event: 'inventory.position_negative.probe_failed',
        error_class: err instanceof Error ? err.name : typeof err,
        pg_code: (err as { code?: unknown } | null)?.code ?? null,
      },
      'source-position negative probe failed; the move is recorded and its audit row says unknown',
    );
    return null;
  }
  if (negative) recordInventoryPositionNegative();
  return negative;
}

/** Undo the probe; a failure here means the transaction was already broken. */
async function rollBackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
  } catch {
    // Nothing to undo, or an aborted transaction: the caller's next statement reports it.
  }
}
