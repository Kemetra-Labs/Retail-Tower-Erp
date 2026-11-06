/**
 * InventoryBackfill — the off-request void/refund/return restock backfill
 * (009-RESTOCK), extracted from InventoryService in RT-1221 PR 2.
 * InventoryService builds it on its own pool and delegates
 * `backfillRestockInbound` to it; the validation, the provenance-dedup SQL,
 * the RLS context, the single transaction, the audit row and the outbox event
 * are unchanged. Not a Nest provider: the module wiring is unchanged.
 */
import { BadRequestException } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool } from 'pg';

import { parseQuantity } from './decimal-quantity';
import { toMovementBody } from './inventory.mappers';
import {
  MOVEMENT_COLUMN_NAMES,
  MOVEMENT_COLUMNS,
  MOVEMENT_POSITION_JOIN,
  type BackfillRestockInboundInput,
  type MovementRow,
  type NormalizedBackfillFields,
  type StockMovementBody,
} from './inventory.types';
import {
  AUDIT_TARGET_TYPE_MOVEMENT,
  assertUnitMatchesEstablished,
  emitMovementCreated,
  insertMovementRow,
  resolvePosition,
} from './inventory-write.helpers';

const AUDIT_ACTION_MOVEMENT_BACKFILL = 'inventory.movement.backfill';

export class InventoryBackfill {
  constructor(private readonly pool: Pool) {}

  /**
   * Append a void/refund/return → restock INBOUND from the off-request backfill
   * (009-RESTOCK, T090/T091, FR-025/R6). Provenance-dedup on
   * `uq_stock_movements_tenant_source_external`, idempotent on
   * `(tenant_id, source_system, external_id)`. References the
   * originating 008 void/refund terminal event (or a customer return) as
   * `terminal_event_ref` provenance — read by value, never an FK; the ledger
   * never mutates the 008 fact (R8). A redelivered restock appends no second
   * movement and re-applies no on-hand (FR-031).
   *
   * SCOPE STOP (FR-025/FR-060): this is the MANUAL/BACKFILL entry only. There is
   * deliberately NO automatic restock-on-void route — auto restock is deferred
   * to the same future follow-up as auto-decrement.
   */
  async backfillRestockInbound(
    input: BackfillRestockInboundInput,
  ): Promise<StockMovementBody> {
    const f = this.validateBackfillInput(input, {
      movementType: 'inbound',
      typeError: 'restock movementType must be inbound',
      signError: 'inbound (restock) quantity must be positive',
      provenanceError: 'restock requires a non-empty sourceSystem and externalId',
    });

    return await this.runBackfillTransaction(input, f, {
      movementType: 'inbound',
      conflictError:
        'InventoryService.backfillRestockInbound: conflict with no matching provenance row',
      auditMetadata: {
        sourceSystem: f.sourceSystem,
        externalId: f.externalId,
        terminalEventRef: input.terminalEventRef ?? null,
        correlationId: input.correlationId ?? null,
      },
      outboxProvenance: {
        sourceSystem: f.sourceSystem,
        externalId: f.externalId,
        terminalEventRef: input.terminalEventRef ?? null,
      },
    });
  }

  /**
   * Pre-DB validation for the provenance-dedup backfill entry
   * (mirrors the manual sign rules; the numeric(19,4)-scale zero rule matches
   * createStockMovement).
   */
  private validateBackfillInput(
    input: BackfillRestockInboundInput,
    spec: {
      movementType: 'inbound';
      typeError: string;
      signError: string;
      provenanceError: string;
    },
  ): NormalizedBackfillFields {
    if (input.movementType !== spec.movementType) {
      throw new BadRequestException(spec.typeError);
    }
    const qty = parseQuantity(input.quantity);
    if (qty === 0n) {
      throw new BadRequestException('quantity must be non-zero at numeric(19,4) scale');
    }
    if (qty < 0n) {
      throw new BadRequestException(spec.signError);
    }
    const sourceSystem = input.sourceSystem.trim();
    const externalId = input.externalId.trim();
    if (sourceSystem.length === 0 || externalId.length === 0) {
      // The pair is the dedup key — a blank half cannot dedup (DB CHECK keeps it
      // all-or-nothing, but reject early with an actionable message).
      throw new BadRequestException(spec.provenanceError);
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : null;
    return {
      sourceSystem,
      externalId,
      stockingUnit,
      reason,
      tenantProductRef: input.tenantProductRef ?? null,
    };
  }

  /**
   * Idempotent-append transaction for the restock backfill entry:
   * cross-unit check (FR-022) → ON CONFLICT DO NOTHING append on the
   * provenance pair (FR-031/033; the conflict target restates the partial
   * index predicate — source/external NOT NULL — or Postgres won't match the
   * partial index) → audit + outbox emit ONLY on a genuine append (a
   * redelivered job writes no duplicate audit and does NOT double-emit). A
   * restock is an INBOUND (positive), so it cannot drive on-hand below zero
   * and needs no negative-balance probe (FR-024).
   */
  private runBackfillTransaction(
    input: BackfillRestockInboundInput,
    f: NormalizedBackfillFields,
    spec: {
      movementType: 'inbound';
      conflictError: string;
      auditMetadata: Record<string, unknown>;
      outboxProvenance: Record<string, unknown>;
    },
  ): Promise<StockMovementBody> {
    const movementId = newId();
    const auditId = newId();

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementBody> => {
        // ---- Cross-unit check (FR-022) — same rule as the manual path -----
        if (f.tenantProductRef !== null) {
          await assertUnitMatchesEstablished(
            client,
            input.storeId,
            f.tenantProductRef,
            f.stockingUnit,
          );
        }

        // RT-432 (RT-290 G4-6): the store's primary location, sellable.
        const position = await resolvePosition(client, input.storeId);

        // ---- Idempotent append on the provenance pair ----------------------
        const inserted = await insertMovementRow(
          client,
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, source_system, external_id,
              sale_id, sale_line_id, terminal_event_ref, created_by,
              stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8,
              COALESCE($9::timestamptz, now()), $10, $11, $12, $13, $14, $15, $16, $17)
           ON CONFLICT (tenant_id, source_system, external_id)
             WHERE source_system IS NOT NULL AND external_id IS NOT NULL
             DO NOTHING
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            movementId,
            input.tenantId,
            input.storeId,
            spec.movementType,
            input.quantity,
            f.stockingUnit,
            f.tenantProductRef,
            f.reason,
            input.occurredAt ?? null,
            f.sourceSystem,
            f.externalId,
            input.saleId ?? null,
            input.saleLineId ?? null,
            input.terminalEventRef ?? null,
            input.userId,
            position.stockLocationId,
            position.inventoryStatus,
          ],
          {
            storeId: input.storeId,
            tenantProductRef: f.tenantProductRef,
            suppliedUnit: f.stockingUnit,
          },
        );

        const row = inserted.rows[0];
        if (!row) {
          // Conflict: a movement for this provenance pair already exists. Return
          // it WITHOUT a second INSERT and WITHOUT a second audit/side-effect —
          // on-hand stays applied exactly once (FR-031/033).
          const movementColumns = MOVEMENT_COLUMN_NAMES.map(
            (c) => `m.${c}`,
          ).join(', ');
          const existing = await client.query<MovementRow>(
            `SELECT ${movementColumns},
                    p.id AS primary_location_id
               FROM stock_movements m
               ${MOVEMENT_POSITION_JOIN}
              WHERE m.tenant_id = $1 AND m.source_system = $2 AND m.external_id = $3`,
            [input.tenantId, f.sourceSystem, f.externalId],
          );
          const existingRow = existing.rows[0];
          if (!existingRow) {
            // Should be unreachable: DO NOTHING fired but no row matches the
            // pair. Surface loudly rather than silently double-applying.
            throw new Error(spec.conflictError);
          }
          return toMovementBody(existingRow);
        }

        // ---- Audit event in the SAME transaction (FR-013, SC-007) ---------
        // Only on a genuine append. correlationId is recorded for backfill
        // traceability; no PII/payload is persisted (§XIV).
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_MOVEMENT_BACKFILL,
            AUDIT_TARGET_TYPE_MOVEMENT,
            row.id,
            JSON.stringify(spec.auditMetadata),
          ],
        );

        await emitMovementCreated(client, {
          tenantId: input.tenantId,
          storeId: input.storeId,
          movementIds: [row.id],
          movementType: row.movement_type,
          tenantProductRef: f.tenantProductRef,
          correlationId: input.correlationId ?? null,
          provenance: spec.outboxProvenance,
        });

        return toMovementBody(row);
      },
    );
  }
}
