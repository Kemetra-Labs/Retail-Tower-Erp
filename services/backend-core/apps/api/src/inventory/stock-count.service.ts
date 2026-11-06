/**
 * StockCountService — the physical stock count write path (009-US6),
 * extracted from InventoryService in RT-1221 PR 2. InventoryService builds it
 * on its own pool and delegates `recordStockCount` to it; the SQL, the RLS
 * context, the single transaction, the audit row and the outbox event are
 * unchanged. Not a Nest provider: the module wiring is unchanged.
 */
import { BadRequestException } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool } from 'pg';

import { formatQuantity, parseQuantity } from './decimal-quantity';
import { asNotPosted, toMovementBody } from './inventory.mappers';
import {
  MOVEMENT_COLUMNS,
  type RecordStockCountInput,
  type StockCountResultBody,
  type StockMovementBody,
} from './inventory.types';
import {
  assertReferencesInTenant,
  assertUnitMatchesEstablished,
  emitMovementCreated,
  insertMovementRow,
  recordNotPosted,
  resolvePosition,
} from './inventory-write.helpers';

const AUDIT_ACTION_COUNT_RECORD = 'inventory.count.record';
const AUDIT_TARGET_TYPE_COUNT = 'stock_count';

export class StockCountService {
  constructor(private readonly pool: Pool) {}

  /**
   * Record a physical stock count and append a `count_correction` movement for
   * any variance (009-US6, FR-021). The history is NEVER rewritten: the variance
   * (counted − derived on-hand) is an APPEND-ONLY signed correction movement
   * linked to the recorded count via `stock_count_id`. After the count, the
   * derived on-hand equals the counted quantity (SC-005). A zero-variance count
   * is deterministic — the count is recorded but NO correction movement is
   * appended (`correctionMovement: null`). The stock_counts insert + the optional
   * correction + the audit all run in ONE `runWithTenantContext` transaction.
   *
   * The store is the PATH-scoped target (authorized at the controller), never a
   * body field (§XII). The count_correction movement is the ONLY movement type
   * that may carry a `stock_count_id` (and MUST, when it is that type) — the
   * 0014 biconditional CHECK enforces it; the composite FK ties it to a count in
   * the SAME tenant + store.
   */
  async recordStockCount(input: RecordStockCountInput): Promise<StockCountResultBody> {
    const counted = parseQuantity(input.countedQuantity, 'countedQuantity');
    if (counted < 0n) {
      throw new BadRequestException('countedQuantity must be non-negative');
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }

    const stockCountId = newId();
    const auditId = newId();

    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockCountResultBody> => {
        await assertReferencesInTenant(client, {
          storeIds: [input.storeId],
          tenantProductRef: input.tenantProductRef,
        });
        // ---- Established-unit check (FR-022) ------------------------------
        await assertUnitMatchesEstablished(
          client,
          input.storeId,
          input.tenantProductRef,
          stockingUnit,
        );

        // ---- Derived on-hand at count time (signed SUM) -------------------
        const onHandRow = await client.query<{ quantity: string }>(
          `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS quantity
             FROM stock_movements
            WHERE store_id = $1 AND tenant_product_ref = $2`,
          [input.storeId, input.tenantProductRef],
        );
        const derivedOnHand = parseQuantity(onHandRow.rows[0]?.quantity ?? '0.0000');
        // Check the calculated variance before attempting a numeric(19,4) insert.
        const variance = counted - derivedOnHand;
        const varianceStr = formatQuantity(variance, 'variance');

        // ---- Record the count (provenance for the correction) -------------
        await client.query(
          `INSERT INTO stock_counts
             (id, tenant_id, store_id, tenant_product_ref, counted_quantity,
              derived_on_hand_at_count, stocking_unit, counted_at, created_by)
           VALUES ($1, $2, $3, $4, $5::numeric(19,4), $6::numeric(19,4), $7,
                   COALESCE($8::timestamptz, now()), $9)`,
          [
            stockCountId,
            input.tenantId,
            input.storeId,
            input.tenantProductRef,
            formatQuantity(counted),
            formatQuantity(derivedOnHand),
            stockingUnit,
            input.countedAt ?? null,
            input.userId,
          ],
        );

        // ---- Append the count_correction ONLY for a non-zero variance ----
        let correctionMovement: StockMovementBody | null = null;
        if (variance !== 0n) {
          // RT-432 (RT-290 G4-6): the immediate count corrects the store's
          // primary location, sellable; Gate 6 (RT-292) scopes counts by position.
          const position = await resolvePosition(client, input.storeId);
          const corr = await insertMovementRow(
            client,
            `INSERT INTO stock_movements
               (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                tenant_product_ref, stock_count_id, reason, occurred_at, created_by,
                event_type, event_ref_id, stock_location_id, inventory_status)
             VALUES
               ($1, $2, $3, 'count_correction', $4::numeric(19,4), $5, $6, $7,
                'count variance', now(), $8, 'count', $7, $9, $10)
             RETURNING ${MOVEMENT_COLUMNS}`,
            [
              newId(),
              input.tenantId,
              input.storeId,
              varianceStr,
              stockingUnit,
              input.tenantProductRef,
              stockCountId,
              input.userId,
              position.stockLocationId,
              position.inventoryStatus,
            ],
            {
              storeId: input.storeId,
              tenantProductRef: input.tenantProductRef,
              suppliedUnit: stockingUnit,
            },
          );
          const row = corr.rows[0];
          if (!row) {
            throw new Error('InventoryService.recordStockCount: correction INSERT returned no row');
          }
          // RT-425: the correction is the `count` Business Event's effect
          // (the recorded count) and starts `not_posted`, in this transaction.
          await recordNotPosted(client, input.tenantId, [row.id]);
          correctionMovement = toMovementBody(asNotPosted(row));
        }

        // ---- Audit the count in the SAME transaction ----------------------
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_COUNT_RECORD,
            AUDIT_TARGET_TYPE_COUNT,
            stockCountId,
            JSON.stringify({ variance: varianceStr, hasCorrection: variance !== 0n }),
          ],
        );

        // Emit the movement event ONLY when a correction movement was appended
        // (a zero-variance count records the count + audits it but writes NO
        // movement — so there is no movement.created to emit).
        if (correctionMovement !== null) {
          await emitMovementCreated(client, {
            tenantId: input.tenantId,
            storeId: input.storeId,
            movementIds: [correctionMovement.id],
            movementType: correctionMovement.movementType,
            tenantProductRef: input.tenantProductRef,
            provenance: { stockCountId },
          });
        }

        return {
          stockCountId,
          countedQuantity: formatQuantity(counted),
          variance: varianceStr,
          correctionMovement,
        };
      },
    );
  }
}
