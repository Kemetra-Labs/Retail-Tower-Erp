/**
 * ShipmentTransfersService — Jira RT-1513 (RT-291 Gate 5; contract RT-1512, `inventory/inventory.yaml` 1.21.0-draft).
 * The shipment Transfer lifecycle: create (Draft), approve (reserves the source stock), cancel (before dispatch only),
 * dispatch (the goods go In Transit), receive (partial, damaged, repeated), close (a received Transfer, or an approved
 * short-close), and the reads. DARK: every operation answers the non-disclosing 404 until the tenant's
 * `shipment_transfers_enabled` is on (`ShipmentTransferActivationService` owns that switch).
 *
 * Every command runs in ONE `runWithTenantContext` transaction under the Transfer row lock (`FOR UPDATE`), so
 * concurrent commands serialise. The commands that can emit an ERP leg (dispatch, receive) take the tenant's feed
 * sequence lock FIRST, the same order as `ackOutcome`, so the feed cursor can never skip a new leg.
 *
 *   - Quantities are exact (scaled bigint); In Transit is a per-line quantity, never a Stock Location (G4-1, 736).
 *   - Dispatch writes `transfer_out` effects at the source and consumes the reservation: stock is deducted once.
 *   - A receipt writes `transfer_in` effects at the destination in the line's disposition (damaged allowed, 811);
 *     a tracked line of a held identity lands in the hold's status (G7-4); over-receipt is refused (813, O5).
 *   - A short-close is Backend-Core only in this slice: the ERP leg of a write-off in transit is NOT decided
 *     (posting-feed.yaml 1.16.0 / 1.17.0), so it is audited and recorded in `shipment_transfer_discrepancies` with
 *     `erp_state = 'not_emitted'` and no work item is emitted.
 *   - One person may create, approve and dispatch: each step is audited with its actor (owner decision 2026-11-19).
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { lockPostingFeedSequence, runWithTenantContext, type InventoryStatus } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { formatQuantity, parseQuantity } from '../../common/quantity/decimal-quantity';
import { MembershipRepository } from '../../context';
import { PG_POOL } from '../../database';
import { recordInventoryNegativeBalance } from '../../observability/metrics/api.metrics';
import {
  emitMovementCreated,
  flagIfNegativeOnHand,
  insertMovementRow,
  recordNotPosted,
  resolvePosition,
} from '../inventory-write.helpers';
import { MOVEMENT_COLUMNS } from '../inventory.types';
import {
  decodeTransferCursor,
  encodeTransferCursor,
  type TransferCursorBinding,
} from './shipment-transfer.cursor';
import {
  assertWarehousesMapped,
  emitDispatchLeg,
  lineRefs,
  releaseReceiptLegs,
} from './shipment-transfer.posting';
import {
  TENANT_WIDE_ROLES,
  assertShipmentTransfersEnabled,
  auditTransfer,
  inScope,
  lockedTransferOr404,
  readAccess,
  requireStoreAuthority,
  tenantOnlyLegalEntity,
  toHttp,
  transferBodyOr404,
  type Access,
  type CreateTransferInput,
  type TransferCaller,
} from './shipment-transfer.access';
import { assertDraftInputShape, createDraftTransfer } from './shipment-transfer.draft';
import { TRANSFER_ERP_PORT, type TransferErpPort } from './transfer-erp.port';
import {
  TRANSFER_SOURCE_SYSTEM,
  TransferRuleError,
  applyCommand,
  assertSameLegalEntity,
  dispatchExternalId,
  planClose,
  planReceipt,
  receiptExternalId,
  stateAfterReceipt,
  type LineQuantities,
  type TransferState,
} from './shipment-transfer.rules';
import {
  TRANSFER_COLUMNS,
  loadLineRows,
  loadTransferRow,
  receiptBodies,
  receiptBodyOf,
  transferBodies,
  type LineRow,
  type ReceiptBody,
  type TransferBody,
  type TransferRow,
} from './shipment-transfer.store';

/** A sort key as UTC text with six fractional digits: the pg driver's `Date` keeps only milliseconds and would repeat or skip rows. */
const CURSOR_KEY_SQL = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DISPOSITIONS: ReadonlySet<string> = new Set(['sellable', 'damaged']);

export type { CreateTransferInput, TransferCaller, TransferContext } from './shipment-transfer.access';

export interface ReceiptInput {
  readonly lines: readonly {
    readonly transferLineId: string;
    readonly quantity: string;
    readonly disposition: string;
    readonly stockLocationId: string | null;
  }[];
  readonly note: string | null;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface ListFilters {
  readonly storeId: string | null;
  readonly direction: 'outbound' | 'inbound' | 'any';
  readonly state: TransferState | null;
}

@Injectable()
export class ShipmentTransfersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Inject(TRANSFER_ERP_PORT) private readonly erp: TransferErpPort,
  ) {}

  // ---- plumbing ------------------------------------------------------------------------------------------------

  private async tx<T>(caller: TransferCaller, fn: (client: PoolClient, access: Access) => Promise<T>, feedLock = false): Promise<T> {
    try {
      return await runWithTenantContext(
        this.pool,
        { tenantId: caller.tenantId, isPlatformAdmin: false },
        async (client) => {
          // The ack path takes the feed lock before any row lock: so do the commands that can emit a leg.
          if (feedLock) await lockPostingFeedSequence(client, caller.tenantId);
          await assertShipmentTransfersEnabled(client, caller.tenantId);
          return await fn(client, await this.access(client, caller));
        },
      );
    } catch (err) {
      throw toHttp(err);
    }
  }

  private async access(client: PoolClient, caller: TransferCaller): Promise<Access> {
    return await readAccess(client, this.memberships, caller);
  }

  /** A Transfer outside the caller's scope (neither store in it) is the non-disclosing 404. */
  private visibleOr404(row: TransferRow | null, a: Access): TransferRow {
    if (!row) throw new NotFoundException('Not Found');
    if (a.scope.kind !== 'tenant' && !inScope(a.scope, row.source_store_id) && !inScope(a.scope, row.destination_store_id)) {
      throw new NotFoundException('Not Found');
    }
    return row;
  }

  /** The authority to act on one store: owner / tenant_admin everywhere, a store_manager inside its scope. */
  private requireStore(a: Access, storeId: string, other?: string): void {
    requireStoreAuthority(a, storeId, other);
  }

  private async audit(
    client: PoolClient,
    caller: TransferCaller,
    action: string,
    transfer: TransferRow,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await auditTransfer(client, caller, action, transfer, metadata);
  }

  private async lockedTransfer(client: PoolClient, id: string): Promise<TransferRow> {
    return await lockedTransferOr404(client, id);
  }

  /** The Transfer, locked, visible to the caller, in a state the source-store command allows, and the caller's authority. */
  private async lockedForSourceCommand(
    client: PoolClient,
    a: Access,
    transferId: string,
    command: 'approve' | 'cancel' | 'dispatch',
  ): Promise<TransferRow> {
    const t = this.visibleOr404(await this.lockedTransfer(client, transferId), a);
    this.requireStore(a, t.source_store_id, t.destination_store_id);
    applyCommand(t.state, command);
    if (command === 'dispatch') await this.assertReservationLive(client, t.id);
    return t;
  }

  /**
   * 798: a reservation past its explicit expiry never dispatches. `expireDue` ran in its own committed transaction before this
   * command, so a reservation that lapsed in the meantime is caught here, under the Transfer's row lock and on the database
   * clock. The refusal rolls this transaction back; the next call expires it (audited) and returns the Transfer to draft.
   */
  private async assertReservationLive(client: PoolClient, transferId: string): Promise<void> {
    const r = await client.query<{ lapsed: boolean }>(
      `SELECT (reservation_expires_at IS NULL OR reservation_expires_at <= now()) AS lapsed FROM shipment_transfers WHERE id = $1`,
      [transferId],
    );
    if (r.rows[0]?.lapsed !== false) {
      throw new TransferRuleError(
        'shipment_transfer_not_in_state',
        'The reservation of this Transfer has expired: it returns to draft and must be approved again.',
      );
    }
  }

  private async lockedLines(client: PoolClient, id: string): Promise<LineRow[]> {
    return (await loadLineRows(client, [id], true)).get(id) ?? [];
  }

  private async bodyOrThrow(client: PoolClient, id: string): Promise<TransferBody> {
    return await transferBodyOr404(client, id);
  }

  // ---- reservation expiry (797, 798) ---------------------------------------------------------------------------

  /**
   * Release the reservation of every approved Transfer whose explicit expiry has passed, by an audited event, and send
   * it back to `draft` (798). It runs in its OWN committed transaction before the command or read that needs the true
   * state, so a command that then refuses does not roll the expiry back. `transferId` narrows it to one Transfer.
   */
  async expireDue(caller: TransferCaller, transferId: string | null): Promise<number> {
    return await this.tx(caller, async (client, a) => {
      // Only Transfers the caller can see: a reader never takes row locks on, nor triggers the expiry of, a Transfer of a
      // store outside its scope (that Transfer stays a non-disclosing 404 to it, and is expired by someone who sees it).
      const scoped = a.scope.kind === 'tenant' ? null : a.scope.storeIds;
      const due = await client.query<{ id: string }>(
        `SELECT id FROM shipment_transfers
          WHERE state = 'approved' AND reservation_expires_at <= now() AND ($1::uuid IS NULL OR id = $1::uuid)
            AND ($2::uuid[] IS NULL OR source_store_id = ANY($2::uuid[]) OR destination_store_id = ANY($2::uuid[]))
          ORDER BY reservation_expires_at, id LIMIT 100 FOR UPDATE`,
        [transferId, scoped],
      );
      for (const d of due.rows) {
        const row = await this.lockedTransfer(client, d.id);
        const released = await client.query(
          `UPDATE inventory_reservations
              SET state = 'expired', state_reason = 'reservation expired before dispatch',
                  state_changed_by = $3, state_changed_at = now()
            WHERE tenant_id = $1 AND source_type = 'transfer' AND source_id = $2 AND state = 'active'`,
          [caller.tenantId, row.id, caller.userId],
        );
        await client.query(
          `UPDATE shipment_transfers
              SET state = 'draft', approved_by = NULL, approved_at = NULL, reservation_expires_at = NULL,
                  reservation_released_at = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        // The expiry is a consequence of the clock, not of this caller: the audit actor is the person whose request
        // triggered the sweep (`triggeredBy`), and `selfActioned` is not applicable to it.
        await this.audit(client, caller, 'reservation_expired', row, {
          reservationsReleased: released.rowCount ?? 0,
          expiredAt: row.reservation_expires_at?.toISOString() ?? null,
          trigger: 'lazy_expiry',
          triggeredBy: caller.userId,
          selfActioned: null,
        });
      }
      return due.rows.length;
    });
  }

  // ---- create (800-802, 962, 963, G7-4) ------------------------------------------------------------------------

  /**
   * The Draft is created by the RT-1597 port (`createDraftTransfer`), in this command's own transaction. The pure input
   * rules still run before any transaction is opened, as before; the port repeats them (pure, no database).
   */
  async create(caller: TransferCaller, input: CreateTransferInput): Promise<TransferBody> {
    assertDraftInputShape(input);
    try {
      return await runWithTenantContext(this.pool, { tenantId: caller.tenantId, isPlatformAdmin: false }, (client) =>
        createDraftTransfer(client, caller, input, { memberships: this.memberships }),
      );
    } catch (err) {
      throw toHttp(err);
    }
  }

  /**
   * G7-4: an identity under an active hold, or past its expiry at the source store's business date, cannot be sent.
   * Returns nothing; throws `tracking_identity_held_or_expired`.
   */
  private async assertIdentitiesSendable(client: PoolClient, sourceStoreId: string, lines: readonly LineRow[]): Promise<void> {
    const ids = lines.flatMap((l) => (l.tracking_identity_id ? [l.tracking_identity_id] : []));
    if (ids.length === 0) return;
    // G7-4: an expiry before the source store's business date (its own time zone) is past; an active hold blocks too.
    const r = await client.query<{ id: string }>(
      `SELECT i.id
         FROM tracking_identities i
        WHERE i.id = ANY($1::uuid[])
          AND (i.expiry_date < store_business_date($2::uuid, now())
               OR EXISTS (SELECT 1 FROM tracking_holds h WHERE h.tracking_identity_id = i.id AND h.released_at IS NULL))`,
      [ids, sourceStoreId],
    );
    if (r.rows.length > 0) {
      throw new TransferRuleError(
        'tracking_identity_held_or_expired',
        'A line names a tracking identity that is under an active hold or past its expiry.',
      );
    }
  }

  // ---- approve (805, 806, 794-798) -----------------------------------------------------------------------------

  async approve(caller: TransferCaller, transferId: string, reservationExpiresAt: Date): Promise<TransferBody> {
    await this.expireDue(caller, transferId);
    return await this.tx(caller, async (client, a) => {
      const t = await this.lockedForSourceCommand(client, a, transferId, 'approve');
      const future = await client.query<{ ok: boolean }>(`SELECT $1::timestamptz > now() AS ok`, [reservationExpiresAt]);
      if (!future.rows[0]!.ok) {
        throw new TransferRuleError('validation_error', 'reservationExpiresAt must be in the future.');
      }
      assertSameLegalEntity(tenantOnlyLegalEntity(caller.tenantId), t.source_store_id, t.destination_store_id);
      const lines = await this.lockedLines(client, t.id);
      await assertWarehousesMapped(this.erp, client, t.source_store_id, t.destination_store_id);
      await lineRefs(this.erp, client, lines);
      await this.assertIdentitiesSendable(client, t.source_store_id, lines);

      // The source position: the store's primary location, where the dispatch effect will land.
      const position = await resolvePosition(client, t.source_store_id);
      let overReserved = false;
      for (const l of lines) {
        await client.query(
          `INSERT INTO inventory_reservations
             (id, tenant_id, store_id, stock_location_id, tenant_product_ref, tracking_identity_id, quantity, expires_at,
              source_type, source_id, source_line_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7::numeric(19,4), $8, 'transfer', $9, $10, $11)`,
          [
            newId(), caller.tenantId, t.source_store_id, position.stockLocationId, l.tenant_product_ref,
            l.tracking_identity_id, l.quantity, reservationExpiresAt, t.id, l.id, caller.userId,
          ],
        );
        overReserved = (await this.flagIfNegativeAvailable(client, t.source_store_id, l.tenant_product_ref)) || overReserved;
      }
      await client.query(
        `UPDATE shipment_transfers
            SET state = 'approved', approved_by = $2, approved_at = now(), reservation_expires_at = $3,
                reservation_released_at = NULL, updated_at = now()
          WHERE id = $1`,
        [t.id, caller.userId, reservationExpiresAt],
      );
      // Approval is never refused for lack of stock (owner decision 2026-11-19): a reservation above Available to
      // Sell is recorded and the negative Available to Sell is flagged (743), as every other stock write is.
      await this.audit(client, caller, 'approve', t, {
        reservationExpiresAt: reservationExpiresAt.toISOString(),
        reservedLines: lines.length,
        availableToSellNegative: overReserved,
      });
      return await this.bodyOrThrow(client, t.id);
    });
  }

  /** The sellable on-hand of a position less its live reservations; below zero is flagged, never refused (743). */
  private async flagIfNegativeAvailable(client: PoolClient, storeId: string, productId: string): Promise<boolean> {
    const r = await client.query<{ available: string }>(
      `SELECT (COALESCE((SELECT SUM(quantity) FROM stock_movements
                          WHERE store_id = $1 AND tenant_product_ref = $2 AND COALESCE(inventory_status, 'sellable') = 'sellable'), 0)
             - COALESCE((SELECT SUM(quantity) FROM inventory_reservations
                          WHERE store_id = $1 AND tenant_product_ref = $2 AND state = 'active'), 0))::numeric(19,4)::text AS available`,
      [storeId, productId],
    );
    const negative = parseQuantity(r.rows[0]?.available ?? '0') < 0n;
    if (negative) recordInventoryNegativeBalance();
    return negative;
  }

  // ---- cancel (798) --------------------------------------------------------------------------------------------

  async cancel(caller: TransferCaller, transferId: string, reason: string): Promise<TransferBody> {
    await this.expireDue(caller, transferId);
    return await this.tx(caller, async (client, a) => {
      const t = await this.lockedForSourceCommand(client, a, transferId, 'cancel');
      const released = await client.query(
        `UPDATE inventory_reservations
            SET state = 'released', state_reason = $3, state_changed_by = $4, state_changed_at = now()
          WHERE tenant_id = $1 AND source_type = 'transfer' AND source_id = $2 AND state = 'active'`,
        [caller.tenantId, t.id, reason.slice(0, 500), caller.userId],
      );
      await client.query(
        `UPDATE shipment_transfers
            SET state = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3,
                reservation_released_at = CASE WHEN reservation_expires_at IS NOT NULL THEN now() END, updated_at = now()
          WHERE id = $1`,
        [t.id, caller.userId, reason],
      );
      // The reservation is released by an audited event (798); no quantity changes.
      await this.audit(client, caller, 'cancel', t, { reason, reservationsReleased: released.rowCount ?? 0, fromState: t.state });
      return await this.bodyOrThrow(client, t.id);
    });
  }

  // ---- dispatch (807, 808, 876, 888) ---------------------------------------------------------------------------

  async dispatch(caller: TransferCaller, transferId: string, note: string | null): Promise<TransferBody> {
    await this.expireDue(caller, transferId);
    return await this.tx(
      caller,
      async (client, a) => {
        const t = await this.lockedForSourceCommand(client, a, transferId, 'dispatch');
        assertSameLegalEntity(tenantOnlyLegalEntity(caller.tenantId), t.source_store_id, t.destination_store_id);
        const lines = await this.lockedLines(client, t.id);
        await this.assertIdentitiesSendable(client, t.source_store_id, lines);
        // Fail closed BEFORE any stock moves: a dispatch that deducts stock it cannot post is a stuck leg (886).
        await assertWarehousesMapped(this.erp, client, t.source_store_id, t.destination_store_id);
        await lineRefs(this.erp, client, lines);

        const position = await resolvePosition(client, t.source_store_id);
        const effects: { lineId: string; movementId: string }[] = [];
        for (const l of lines) {
          const movementId = newId();
          const out = await insertMovementRow(
            client,
            `INSERT INTO stock_movements
               (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason, occurred_at,
                transfer_group_id, created_by, event_type, event_ref_id, stock_location_id, inventory_status,
                tracking_identity_id, source_system, external_id)
             VALUES ($1, $2, $3, 'transfer_out', $4::numeric(19,4), $5, $6, $7, now(), $8, $9, 'transfer', $8, $10, $11, $12, $13, $14)
             RETURNING ${MOVEMENT_COLUMNS}`,
            [
              movementId, caller.tenantId, t.source_store_id, formatQuantity(-parseQuantity(l.quantity)), l.stocking_unit,
              l.tenant_product_ref, t.reason, t.id, caller.userId, position.stockLocationId, position.inventoryStatus,
              l.tracking_identity_id, TRANSFER_SOURCE_SYSTEM, `${dispatchExternalId(t.id)}:${l.line_seq}`,
            ],
            { storeId: t.source_store_id, tenantProductRef: l.tenant_product_ref, suppliedUnit: l.stocking_unit },
          );
          if (!out.rows[0]) throw new Error('ShipmentTransfers.dispatch: INSERT returned no row');
          effects.push({ lineId: l.id, movementId });
          // In Transit is held on the line, not as a Stock Location (G4-1): dispatched = the whole approved quantity.
          await client.query(
            `UPDATE shipment_transfer_lines SET dispatched_quantity = quantity, dispatch_movement_id = $2 WHERE id = $1`,
            [l.id, movementId],
          );
        }
        await recordNotPosted(client, caller.tenantId, effects.map((e) => e.movementId));
        // The reservation is consumed by the dispatch effect, so the quantity is deducted once (794-798).
        await client.query(
          `UPDATE inventory_reservations
              SET state = 'consumed', state_reason = 'dispatched', state_changed_by = $3, state_changed_at = now()
            WHERE tenant_id = $1 AND source_type = 'transfer' AND source_id = $2 AND state = 'active'`,
          [caller.tenantId, t.id, caller.userId],
        );
        await client.query(
          `UPDATE shipment_transfers
              SET state = 'in_transit', dispatched_by = $2, dispatched_at = now(), dispatch_note = $3,
                  reservation_released_at = now(), updated_at = now()
            WHERE id = $1`,
          [t.id, caller.userId, note],
        );
        // The ERP leg is one `transfer_dispatch` work item, in this same transaction as the effects (DC-2).
        const head = await client.query<{ id: string; tenant_id: string; source_store_id: string; destination_store_id: string; dispatched_at: Date }>(
          `SELECT id, tenant_id, source_store_id, destination_store_id, dispatched_at FROM shipment_transfers WHERE id = $1`,
          [t.id],
        );
        const intentId = await emitDispatchLeg(this.erp, client, head.rows[0]!, effects);
        await this.audit(client, caller, 'dispatch', t, { note, lineCount: lines.length, dispatchIntentId: intentId });
        await emitMovementCreated(client, {
          tenantId: caller.tenantId,
          storeId: t.source_store_id,
          movementIds: effects.map((e) => e.movementId),
          movementType: 'transfer',
          provenance: { transferId: t.id, leg: 'dispatch', sourceStoreId: t.source_store_id, destinationStoreId: t.destination_store_id },
        });
        for (const l of lines) await flagIfNegativeOnHand(client, t.source_store_id, l.tenant_product_ref);
        return await this.bodyOrThrow(client, t.id);
      },
      true,
    );
  }

  // ---- receive (803, 804, 809-813, 877, 889) -------------------------------------------------------------------

  async receive(caller: TransferCaller, transferId: string, input: ReceiptInput): Promise<{ transfer: TransferBody; receipt: ReceiptBody }> {
    for (const l of input.lines) {
      if (!DISPOSITIONS.has(l.disposition)) {
        throw new BadRequestException({ code: 'validation_error', message: 'disposition must be sellable or damaged' });
      }
    }
    return await this.tx(
      caller,
      async (client, a) => {
        const t = this.visibleOr404(await this.lockedTransfer(client, transferId), a);
        // A receipt lands only at the destination store (owner decision 2026-11-19).
        this.requireStore(a, t.destination_store_id, t.source_store_id);
        applyCommand(t.state, 'receive');
        const lines = await this.lockedLines(client, t.id);
        const quantities = lines.map(toQuantities);
        const plan = planReceipt(quantities, input.lines.map((l) => ({ transferLineId: l.transferLineId, quantity: l.quantity })));
        const nextState = stateAfterReceipt(quantities, plan);

        const receiptId = newId();
        const seq = t.receipt_count + 1;
        await client.query(
          `INSERT INTO shipment_transfer_receipts (id, tenant_id, transfer_id, receipt_seq, received_by, note)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [receiptId, caller.tenantId, t.id, seq, caller.userId, input.note],
        );
        const lineById = new Map(lines.map((l) => [l.id, l] as const));
        const requested = new Map(input.lines.map((l) => [l.transferLineId, l] as const));
        const effects: string[] = [];
        let lineSeq = 0;
        for (const p of plan) {
          const l = lineById.get(p.transferLineId)!;
          const req = requested.get(p.transferLineId)!;
          lineSeq += 1;
          const position = await this.receiptPosition(client, t.destination_store_id, l, req);
          const movementId = newId();
          const inb = await insertMovementRow(
            client,
            `INSERT INTO stock_movements
               (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason, occurred_at,
                transfer_group_id, created_by, event_type, event_ref_id, stock_location_id, inventory_status,
                tracking_identity_id, source_system, external_id)
             VALUES ($1, $2, $3, 'transfer_in', $4::numeric(19,4), $5, $6, $7, now(), $8, $9, 'transfer', $15, $10, $11, $12, $13, $14)
             RETURNING ${MOVEMENT_COLUMNS}`,
            [
              movementId, caller.tenantId, t.destination_store_id, formatQuantity(p.quantity), l.stocking_unit,
              l.tenant_product_ref, input.note, t.id, caller.userId, position.stockLocationId, position.inventoryStatus,
              l.tracking_identity_id, TRANSFER_SOURCE_SYSTEM, `${receiptExternalId(receiptId)}:${lineSeq}`, receiptId,
            ],
            { storeId: t.destination_store_id, tenantProductRef: l.tenant_product_ref, suppliedUnit: l.stocking_unit },
          );
          if (!inb.rows[0]) throw new Error('ShipmentTransfers.receive: INSERT returned no row');
          effects.push(movementId);
          await client.query(
            `INSERT INTO shipment_transfer_receipt_lines
               (receipt_id, tenant_id, line_seq, transfer_line_id, quantity, inventory_status, stock_location_id, movement_id)
             VALUES ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8)`,
            [receiptId, caller.tenantId, lineSeq, l.id, formatQuantity(p.quantity), position.inventoryStatus, position.stockLocationId, movementId],
          );
          // Short receipts fabricate nothing: only what arrived leaves In Transit (812).
          await client.query(`UPDATE shipment_transfer_lines SET received_quantity = $2::numeric(19,4) WHERE id = $1`, [
            l.id, formatQuantity(p.receivedAfter),
          ]);
        }
        await recordNotPosted(client, caller.tenantId, effects);
        await client.query(
          `UPDATE shipment_transfers SET state = $2, receipt_count = $3, updated_at = now() WHERE id = $1`,
          [t.id, nextState, seq],
        );
        // The ERP leg: written only once the dispatch is CONFIRMED (here, or later in the dispatch's ack).
        const released = await this.releaseIfDispatchConfirmed(client, caller.tenantId, t.id);
        await this.audit(client, caller, 'receive', t, {
          receiptId, receiptSeq: seq, lineCount: plan.length, resultingState: nextState, legsReleased: released,
          dispositions: input.lines.map((l) => l.disposition),
        });
        await emitMovementCreated(client, {
          tenantId: caller.tenantId,
          storeId: t.destination_store_id,
          movementIds: effects,
          movementType: 'transfer',
          provenance: { transferId: t.id, leg: 'receipt', receiptId, sourceStoreId: t.source_store_id, destinationStoreId: t.destination_store_id },
        });
        return { transfer: await this.bodyOrThrow(client, t.id), receipt: await receiptBodyOf(client, receiptId) };
      },
      true,
    );
  }

  /** G7-4 / 811: the landing position. A held tracked identity lands in the hold's status, whatever the disposition. */
  private async receiptPosition(
    client: PoolClient,
    destinationStoreId: string,
    line: LineRow,
    req: { disposition: string; stockLocationId: string | null },
  ): Promise<{ stockLocationId: string; inventoryStatus: InventoryStatus }> {
    let status = req.disposition as InventoryStatus;
    if (line.tracking_identity_id) {
      const hold = await client.query<{ kind: string }>(
        `SELECT kind FROM tracking_holds WHERE tracking_identity_id = $1 AND released_at IS NULL
          ORDER BY (kind = 'recall_hold') DESC LIMIT 1`,
        [line.tracking_identity_id],
      );
      if (hold.rows[0]) status = hold.rows[0].kind as InventoryStatus;
    }
    return await resolvePosition(client, destinationStoreId, { stockLocationId: req.stockLocationId, inventoryStatus: status });
  }

  private async releaseIfDispatchConfirmed(client: PoolClient, tenantId: string, transferId: string): Promise<number> {
    const dispatch = await client.query<{ intent_id: string }>(
      `SELECT intent_id FROM transfer_postings WHERE transfer_id = $1 AND receipt_id IS NULL`,
      [transferId],
    );
    const intentId = dispatch.rows[0]?.intent_id;
    if (!intentId) return 0;
    const leg = await this.erp.postingLegStatus(client, intentId);
    if (leg?.status !== 'posted') return 0;
    return (await releaseReceiptLegs(this.erp, client, tenantId, intentId)).length;
  }

  // ---- close (812) ---------------------------------------------------------------------------------------------

  async close(caller: TransferCaller, transferId: string, shortCloseReason: string | null): Promise<TransferBody> {
    return await this.tx(caller, async (client, a) => {
      const t = this.visibleOr404(await this.lockedTransfer(client, transferId), a);
      applyCommand(t.state, 'close');
      const lines = await this.lockedLines(client, t.id);
      const plan = planClose(lines.map(toQuantities), shortCloseReason);
      if (plan.shortClose) {
        // A short-close needs the discrepancy approval capability: owner or tenant_admin (812).
        if (!TENANT_WIDE_ROLES.has(a.role)) {
          throw new TransferRuleError('forbidden', 'A short-close needs the discrepancy approval capability (owner or tenant_admin).');
        }
      } else {
        // Closing a fully received Transfer: also a store_manager of the destination store.
        this.requireStore(a, t.destination_store_id, t.source_store_id);
      }
      for (const s of plan.lines) {
        await client.query(
          `INSERT INTO shipment_transfer_discrepancies (id, tenant_id, transfer_id, transfer_line_id, kind, quantity, reason, approved_by)
           VALUES ($1, $2, $3, $4, 'short_close', $5::numeric(19,4), $6, $7)`,
          [newId(), caller.tenantId, t.id, s.transferLineId, formatQuantity(s.quantity), shortCloseReason, caller.userId],
        );
        await client.query(
          `UPDATE shipment_transfer_lines SET short_closed_quantity = short_closed_quantity + $2::numeric(19,4) WHERE id = $1`,
          [s.transferLineId, formatQuantity(s.quantity)],
        );
      }
      await client.query(
        `UPDATE shipment_transfers
            SET state = 'closed', closed_by = $2, closed_at = now(), short_close_reason = $3,
                short_close_approved_by = CASE WHEN $3::text IS NULL THEN NULL ELSE $2::uuid END,
                short_close_approved_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, updated_at = now()
          WHERE id = $1`,
        [t.id, caller.userId, plan.shortClose ? shortCloseReason : null],
      );
      // V1 keeps a short-close in Backend-Core: no ERP work item (the ERP leg is not decided), so the write-off is
      // listed as drift (`erp_state = 'not_emitted'`) for the later reconciliation.
      await this.audit(client, caller, 'close', t, {
        shortClose: plan.shortClose,
        shortCloseReason: plan.shortClose ? shortCloseReason : null,
        writtenOff: plan.lines.map((s) => ({ lineId: s.transferLineId, quantity: formatQuantity(s.quantity) })),
        erpState: plan.shortClose ? 'not_emitted' : null,
      });
      return await this.bodyOrThrow(client, t.id);
    });
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  async get(caller: TransferCaller, transferId: string): Promise<TransferBody> {
    await this.expireDue(caller, transferId);
    return await this.tx(caller, async (client, a) => {
      this.visibleOr404(await loadTransferRow(client, transferId, false), a);
      return await this.bodyOrThrow(client, transferId);
    });
  }

  async list(caller: TransferCaller, filters: ListFilters, cursor: string | null, limit: number): Promise<Page<TransferBody>> {
    await this.expireDue(caller, null);
    const binding: TransferCursorBinding = {
      operation: 'transfers',
      tenantId: caller.tenantId,
      transferId: null,
      filter: `${filters.storeId ?? ''}|${filters.storeId ? filters.direction : ''}|${filters.state ?? ''}`,
    };
    return await this.tx(caller, async (client, a) => {
      const pos = cursor ? decodeTransferCursor(cursor, binding) : null;
      const scoped = a.scope.kind === 'tenant' ? null : a.scope.storeIds;
      const r = await client.query<TransferRow & { cursor_key: string }>(
        `SELECT ${TRANSFER_COLUMNS}, ${CURSOR_KEY_SQL('created_at')} AS cursor_key FROM shipment_transfers
          WHERE ($1::uuid[] IS NULL OR source_store_id = ANY($1::uuid[]) OR destination_store_id = ANY($1::uuid[]))
            AND ($2::uuid IS NULL
                 OR (($3 IN ('outbound', 'any')) AND source_store_id = $2::uuid)
                 OR (($3 IN ('inbound', 'any')) AND destination_store_id = $2::uuid))
            AND ($4::text IS NULL OR state = $4::text)
            AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $7`,
        [scoped, filters.storeId, filters.direction, filters.state, pos?.a ?? null, pos?.b ?? null, limit + 1],
      );
      const rows = r.rows.slice(0, limit);
      const items = await transferBodies(client, rows);
      const last = rows[rows.length - 1];
      return {
        items,
        nextCursor: r.rows.length > limit && last ? encodeTransferCursor(binding, { a: last.cursor_key, b: last.id }) : null,
      };
    });
  }

  async listReceipts(caller: TransferCaller, transferId: string, cursor: string | null, limit: number): Promise<Page<ReceiptBody>> {
    const binding: TransferCursorBinding = { operation: 'receipts', tenantId: caller.tenantId, transferId, filter: null };
    return await this.tx(caller, async (client, a) => {
      this.visibleOr404(await loadTransferRow(client, transferId, false), a);
      const pos = cursor ? decodeTransferCursor(cursor, binding) : null;
      const r = await client.query<{ id: string; transfer_id: string; received_by: string; received_at: Date; note: string | null; cursor_key: string }>(
        `SELECT id, transfer_id, received_by, received_at, note, ${CURSOR_KEY_SQL('received_at')} AS cursor_key FROM shipment_transfer_receipts
          WHERE transfer_id = $1 AND ($2::timestamptz IS NULL OR (received_at, id) > ($2::timestamptz, $3::uuid))
          ORDER BY received_at ASC, id ASC LIMIT $4`,
        [transferId, pos?.a ?? null, pos?.b ?? null, limit + 1],
      );
      const rows = r.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: await receiptBodies(client, rows),
        nextCursor: r.rows.length > limit && last ? encodeTransferCursor(binding, { a: last.cursor_key, b: last.id }) : null,
      };
    });
  }
}

function toQuantities(l: LineRow): LineQuantities {
  return {
    id: l.id,
    lineSeq: l.line_seq,
    quantity: l.quantity,
    dispatchedQuantity: l.dispatched_quantity,
    receivedQuantity: l.received_quantity,
    shortClosedQuantity: l.short_closed_quantity,
  };
}
