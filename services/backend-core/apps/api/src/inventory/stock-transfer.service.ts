/**
 * StockTransferService — the intra-tenant stock transfer write path (009-US5),
 * extracted from InventoryService in RT-1221 PR 2. InventoryService builds it
 * on its own pool and delegates `createStockTransfer` to it; the SQL, the RLS
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
  type CreateStockTransferInput,
  type StockTransferBody,
} from './inventory.types';
import {
  assertReferencesInTenant,
  assertUnitMatchesEstablished,
  emitMovementCreated,
  flagIfNegativeOnHand,
  insertMovementRow,
  recordNotPosted,
  resolvePosition,
} from './inventory-write.helpers';

const AUDIT_ACTION_TRANSFER_CREATE = 'inventory.transfer.create';
const AUDIT_TARGET_TYPE_TRANSFER = 'stock_transfer';

export class StockTransferService {
  constructor(private readonly pool: Pool) {}

  /**
   * Create an intra-tenant transfer as LINKED movements (009-US5, FR-020): a
   * `transfer_out` at the source store and a `transfer_in` at the destination,
   * sharing one `transfer_group_id` so the legs are mutually discoverable
   * (SC-004). BOTH inserts + the audit run in ONE `runWithTenantContext`
   * transaction — a partial transfer (one leg without its counterpart) can never
   * commit and corrupt the on-hand invariant.
   *
   * Validation (server-side):
   *   - source ≠ destination, quantity strictly positive (else 400);
   *   - the destination store MUST resolve within the caller's tenant — the
   *     SELECT runs under RLS, so a cross-tenant destination returns zero rows
   *     and is a non-disclosing 404 (FR-051). (The source is authorized at the
   *     controller against the principal's store scope.)
   *   - each leg's `stockingUnit` MUST match that store's established unit, if
   *     the product already has movements there (FR-022, per-store).
   * Allow-and-flag (FR-024): a transfer-out driving the SOURCE on-hand negative
   * is still recorded — never rejected; the negative balance surfaces on read.
   */
  async createStockTransfer(input: CreateStockTransferInput): Promise<StockTransferBody> {
    // ---- Pre-DB validation -------------------------------------------------
    if (input.sourceStoreId === input.destinationStoreId) {
      throw new BadRequestException('source and destination stores must differ');
    }
    const qty = parseQuantity(input.quantity);
    if (qty <= 0n) {
      throw new BadRequestException('transfer quantity must be strictly positive');
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : null;

    // Signed magnitudes for the two legs (string form for the numeric cast).
    const outQty = formatQuantity(-qty);
    const inQty = formatQuantity(qty);
    const transferGroupId = newId();
    const outId = newId();
    const inId = newId();
    const auditId = newId();

    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockTransferBody> => {
        // ---- Both stores and the product must resolve within the tenant ----
        // (FR-051 / RT-61): a cross-tenant or unknown reference → 404.
        await assertReferencesInTenant(client, {
          storeIds: [input.sourceStoreId, input.destinationStoreId],
          tenantProductRef: input.tenantProductRef,
        });

        // ---- Per-store cross-unit checks (FR-022) -------------------------
        await assertUnitMatchesEstablished(
          client,
          input.sourceStoreId,
          input.tenantProductRef,
          stockingUnit,
        );
        await assertUnitMatchesEstablished(
          client,
          input.destinationStoreId,
          input.tenantProductRef,
          stockingUnit,
        );

        // ---- Positions (RT-432, RT-290 G4-6): each store's primary, sellable.
        // The instant transfer is not the target shipment workflow (974, Gate 5).
        const outPosition = await resolvePosition(client, input.sourceStoreId);
        const inPosition = await resolvePosition(client, input.destinationStoreId);

        // ---- Two linked INSERTs sharing the transfer group ----------------
        const out = await insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, transfer_group_id, created_by,
              event_type, event_ref_id, stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, 'transfer_out', $4::numeric(19,4), $5, $6, $7, now(), $8, $9,
              'transfer', $8, $10, $11)
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            outId,
            input.tenantId,
            input.sourceStoreId,
            outQty,
            stockingUnit,
            input.tenantProductRef,
            reason,
            transferGroupId,
            input.userId,
            outPosition.stockLocationId,
            outPosition.inventoryStatus,
          ],
          {
            storeId: input.sourceStoreId,
            tenantProductRef: input.tenantProductRef,
            suppliedUnit: stockingUnit,
          },
        );
        const inb = await insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, transfer_group_id, created_by,
              event_type, event_ref_id, stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, 'transfer_in', $4::numeric(19,4), $5, $6, $7, now(), $8, $9,
              'transfer', $8, $10, $11)
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            inId,
            input.tenantId,
            input.destinationStoreId,
            inQty,
            stockingUnit,
            input.tenantProductRef,
            reason,
            transferGroupId,
            input.userId,
            inPosition.stockLocationId,
            inPosition.inventoryStatus,
          ],
          {
            storeId: input.destinationStoreId,
            tenantProductRef: input.tenantProductRef,
            suppliedUnit: stockingUnit,
          },
        );
        const outRow = out.rows[0];
        const inRow = inb.rows[0];
        if (!outRow || !inRow) {
          throw new Error('InventoryService.createStockTransfer: INSERT returned no row');
        }
        // RT-425: both legs belong to one `transfer` Business Event (the
        // transfer group) and start `not_posted`, in this transaction.
        await recordNotPosted(client, input.tenantId, [outRow.id, inRow.id]);

        // ---- One audit event for the logical transfer (same transaction) --
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_TRANSFER_CREATE,
            AUDIT_TARGET_TYPE_TRANSFER,
            transferGroupId,
            JSON.stringify({
              sourceStoreId: input.sourceStoreId,
              destinationStoreId: input.destinationStoreId,
            }),
          ],
        );

        // One outbox event for the logical transfer, naming BOTH linked legs
        // (one operation = one event, mirroring the single audit row). storeId
        // is the source; the payload carries both store ids + both movement ids.
        await emitMovementCreated(client, {
          tenantId: input.tenantId,
          storeId: input.sourceStoreId,
          movementIds: [outRow.id, inRow.id],
          movementType: 'transfer',
          tenantProductRef: input.tenantProductRef,
          provenance: {
            transferGroupId,
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
          },
        });

        // ---- Negative-balance signal (FR-024) — the transfer_out leg may
        // drive the SOURCE on-hand below zero; flagged, never rejected.
        await flagIfNegativeOnHand(client, input.sourceStoreId, input.tenantProductRef);

        return {
          transferGroupId,
          outbound: toMovementBody(asNotPosted(outRow)),
          inbound: toMovementBody(asNotPosted(inRow)),
        };
      },
    );
  }
}
