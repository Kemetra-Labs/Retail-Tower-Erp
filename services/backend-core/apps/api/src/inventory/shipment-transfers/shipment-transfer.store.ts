/**
 * Shipment Transfer reads — Jira RT-1513. The SQL that loads a Transfer, its lines, its receipts and each ERP
 * leg's integration state, and the wire bodies of the contract (`ShipmentTransfer`, `ShipmentTransferReceipt`).
 * Every statement runs on the caller's tenant-context client, so RLS scopes it; nothing here writes.
 */
import type { PoolClient } from 'pg';

import { formatQuantity } from '../../common/quantity/decimal-quantity';
import { inTransitOf, type TransferState } from './shipment-transfer.rules';

export interface TransferRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly source_store_id: string;
  readonly destination_store_id: string;
  readonly state: TransferState;
  readonly reason: string | null;
  readonly created_by: string;
  readonly created_at: Date;
  readonly approved_by: string | null;
  readonly approved_at: Date | null;
  readonly reservation_expires_at: Date | null;
  readonly reservation_released_at: Date | null;
  readonly dispatched_by: string | null;
  readonly dispatched_at: Date | null;
  readonly dispatch_note: string | null;
  readonly closed_by: string | null;
  readonly closed_at: Date | null;
  readonly short_close_reason: string | null;
  readonly short_close_approved_by: string | null;
  readonly short_close_approved_at: Date | null;
  readonly cancelled_by: string | null;
  readonly cancelled_at: Date | null;
  readonly cancel_reason: string | null;
  readonly receipt_count: number;
  readonly updated_at: Date;
}

export interface LineRow {
  readonly id: string;
  readonly transfer_id: string;
  readonly line_seq: number;
  readonly tenant_product_ref: string;
  readonly stocking_unit: string;
  readonly tracking_identity_id: string | null;
  readonly quantity: string;
  readonly dispatched_quantity: string;
  readonly received_quantity: string;
  readonly short_closed_quantity: string;
  readonly dispatch_movement_id: string | null;
}

export type LegIntegrationState = 'not_posted' | 'pending' | 'confirmed' | 'rejected' | 'reconciliation_required';

export const TRANSFER_COLUMNS = `id, tenant_id, source_store_id, destination_store_id, state, reason, created_by, created_at,
  approved_by, approved_at, reservation_expires_at, reservation_released_at, dispatched_by, dispatched_at, dispatch_note,
  closed_by, closed_at, short_close_reason, short_close_approved_by, short_close_approved_at, cancelled_by, cancelled_at,
  cancel_reason, receipt_count, updated_at`;

const LINE_COLUMNS = `id, transfer_id, line_seq, tenant_product_ref, stocking_unit, tracking_identity_id,
  quantity::text AS quantity, dispatched_quantity::text AS dispatched_quantity, received_quantity::text AS received_quantity,
  short_closed_quantity::text AS short_closed_quantity, dispatch_movement_id`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function loadTransferRow(client: PoolClient, id: string, lock: boolean): Promise<TransferRow | null> {
  const r = await client.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM shipment_transfers WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function loadLineRows(client: PoolClient, transferIds: readonly string[], lock = false): Promise<Map<string, LineRow[]>> {
  const r = await client.query<LineRow>(
    `SELECT ${LINE_COLUMNS} FROM shipment_transfer_lines WHERE transfer_id = ANY($1::uuid[])
      ORDER BY transfer_id, line_seq${lock ? ' FOR UPDATE' : ''}`,
    [transferIds],
  );
  const byTransfer = new Map<string, LineRow[]>();
  for (const row of r.rows) {
    const list = byTransfer.get(row.transfer_id) ?? [];
    list.push(row);
    byTransfer.set(row.transfer_id, list);
  }
  return byTransfer;
}

/**
 * The ERP posting state of a leg, from the integration state of its effects (G2-3). One intent represents every
 * effect of a leg, so they move together; the aggregate is still defined for a mixed set. An empty set, or effects
 * with no intent yet, is `not_posted` (a receipt waits for its dispatch to be confirmed).
 */
export function aggregateLegState(states: readonly string[]): LegIntegrationState {
  if (states.length === 0) return 'not_posted';
  if (states.includes('rejected')) return 'rejected';
  if (states.includes('reconciliation_required')) return 'reconciliation_required';
  if (states.includes('pending')) return 'pending';
  if (states.every((s) => s === 'confirmed')) return 'confirmed';
  return 'not_posted';
}

/** movementId -> its integration state. */
async function effectStates(client: PoolClient, movementIds: readonly string[]): Promise<Map<string, string>> {
  if (movementIds.length === 0) return new Map();
  const r = await client.query<{ effect_id: string; state: string }>(
    `SELECT effect_id, state FROM inventory_effect_integration WHERE effect_id = ANY($1::uuid[])`,
    [movementIds],
  );
  return new Map(r.rows.map((x) => [x.effect_id, x.state] as const));
}

interface TransferLineBody {
  readonly id: string;
  readonly lineSeq: number;
  readonly tenantProductRef: string;
  readonly stockingUnit: string;
  readonly trackingIdentityId: string | null;
  readonly quantity: string;
  readonly dispatchedQuantity: string;
  readonly receivedQuantity: string;
  readonly shortClosedQuantity: string;
  readonly inTransitQuantity: string;
  readonly dispatchMovementId: string | null;
}

interface ActorStampBody {
  readonly by: string;
  readonly at: string;
}

export interface TransferBody {
  readonly id: string;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly state: TransferState;
  readonly lines: TransferLineBody[];
  readonly reason: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly approval: ActorStampBody | null;
  readonly reservation: {
    readonly reservedBy: string;
    readonly reservedAt: string;
    readonly expiresAt: string;
    readonly releasedAt: string | null;
  } | null;
  readonly dispatch: ActorStampBody | null;
  readonly dispatchIntegrationState: LegIntegrationState | null;
  readonly shortClose: { readonly approvedBy: string; readonly approvedAt: string; readonly reason: string } | null;
  readonly closure: ActorStampBody | null;
  readonly cancellation: { readonly cancelledBy: string; readonly cancelledAt: string; readonly reason: string } | null;
  readonly receiptCount: number;
  readonly updatedAt: string;
}

function lineBody(l: LineRow): TransferLineBody {
  const inTransit = inTransitOf({
    id: l.id,
    lineSeq: l.line_seq,
    quantity: l.quantity,
    dispatchedQuantity: l.dispatched_quantity,
    receivedQuantity: l.received_quantity,
    shortClosedQuantity: l.short_closed_quantity,
  });
  return {
    id: l.id,
    lineSeq: l.line_seq,
    tenantProductRef: l.tenant_product_ref,
    stockingUnit: l.stocking_unit,
    trackingIdentityId: l.tracking_identity_id,
    quantity: l.quantity,
    dispatchedQuantity: l.dispatched_quantity,
    receivedQuantity: l.received_quantity,
    shortClosedQuantity: l.short_closed_quantity,
    inTransitQuantity: formatQuantity(inTransit),
    dispatchMovementId: l.dispatch_movement_id,
  };
}

const stamp = (by: string | null, at: Date | null): ActorStampBody | null =>
  by && at ? { by, at: at.toISOString() } : null;

function reservationBody(t: TransferRow): TransferBody['reservation'] {
  if (!(t.approved_by && t.approved_at && t.reservation_expires_at)) return null;
  return {
    reservedBy: t.approved_by,
    reservedAt: t.approved_at.toISOString(),
    expiresAt: t.reservation_expires_at.toISOString(),
    releasedAt: iso(t.reservation_released_at),
  };
}

function shortCloseBody(t: TransferRow): TransferBody['shortClose'] {
  if (!(t.short_close_approved_by && t.short_close_approved_at && t.short_close_reason)) return null;
  return {
    approvedBy: t.short_close_approved_by,
    approvedAt: t.short_close_approved_at.toISOString(),
    reason: t.short_close_reason,
  };
}

function cancellationBody(t: TransferRow): TransferBody['cancellation'] {
  if (!(t.cancelled_by && t.cancelled_at && t.cancel_reason)) return null;
  return { cancelledBy: t.cancelled_by, cancelledAt: t.cancelled_at.toISOString(), reason: t.cancel_reason };
}

function transferBody(t: TransferRow, lines: readonly LineRow[], dispatchState: LegIntegrationState | null): TransferBody {
  return {
    id: t.id,
    sourceStoreId: t.source_store_id,
    destinationStoreId: t.destination_store_id,
    state: t.state,
    lines: lines.map(lineBody),
    reason: t.reason,
    createdBy: t.created_by,
    createdAt: t.created_at.toISOString(),
    approval: stamp(t.approved_by, t.approved_at),
    reservation: reservationBody(t),
    dispatch: stamp(t.dispatched_by, t.dispatched_at),
    dispatchIntegrationState: dispatchState,
    shortClose: shortCloseBody(t),
    closure: stamp(t.closed_by, t.closed_at),
    cancellation: cancellationBody(t),
    receiptCount: t.receipt_count,
    updatedAt: t.updated_at.toISOString(),
  };
}

/** The wire bodies of several Transfers, in the order given, with their lines and dispatch leg state. */
export async function transferBodies(client: PoolClient, rows: readonly TransferRow[]): Promise<TransferBody[]> {
  if (rows.length === 0) return [];
  const lines = await loadLineRows(
    client,
    rows.map((r) => r.id),
  );
  const movementIds = [...lines.values()].flat().flatMap((l) => (l.dispatch_movement_id ? [l.dispatch_movement_id] : []));
  const states = await effectStates(client, movementIds);
  return rows.map((t) => {
    const ls = lines.get(t.id) ?? [];
    const dispatched = ls.filter((l) => l.dispatch_movement_id !== null);
    const dispatchState =
      dispatched.length === 0
        ? null
        : aggregateLegState(dispatched.map((l) => states.get(l.dispatch_movement_id!) ?? 'not_posted'));
    return transferBody(t, ls, dispatchState);
  });
}

export async function transferBodyOf(client: PoolClient, id: string): Promise<TransferBody | null> {
  const row = await loadTransferRow(client, id, false);
  return row ? (await transferBodies(client, [row]))[0]! : null;
}

// ---- Receipts -----------------------------------------------------------------------------------------------

interface ReceiptLineBody {
  readonly transferLineId: string;
  readonly quantity: string;
  readonly inventoryStatus: string;
  readonly stockLocationId: string;
  readonly movementId: string;
}

export interface ReceiptBody {
  readonly id: string;
  readonly transferId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly note: string | null;
  readonly integrationState: LegIntegrationState;
  readonly lines: ReceiptLineBody[];
}

interface ReceiptRow {
  readonly id: string;
  readonly transfer_id: string;
  readonly received_by: string;
  readonly received_at: Date;
  readonly note: string | null;
}

export async function receiptBodies(client: PoolClient, rows: readonly ReceiptRow[]): Promise<ReceiptBody[]> {
  if (rows.length === 0) return [];
  const lines = await client.query<{
    receipt_id: string;
    line_seq: number;
    transfer_line_id: string;
    quantity: string;
    inventory_status: string;
    stock_location_id: string;
    movement_id: string;
  }>(
    `SELECT receipt_id, line_seq, transfer_line_id, quantity::text AS quantity, inventory_status, stock_location_id, movement_id
       FROM shipment_transfer_receipt_lines WHERE receipt_id = ANY($1::uuid[]) ORDER BY receipt_id, line_seq`,
    [rows.map((r) => r.id)],
  );
  const states = await effectStates(
    client,
    lines.rows.map((l) => l.movement_id),
  );
  return rows.map((r) => {
    const mine = lines.rows.filter((l) => l.receipt_id === r.id);
    return {
      id: r.id,
      transferId: r.transfer_id,
      receivedBy: r.received_by,
      receivedAt: r.received_at.toISOString(),
      note: r.note,
      integrationState: aggregateLegState(mine.map((l) => states.get(l.movement_id) ?? 'not_posted')),
      lines: mine.map((l) => ({
        transferLineId: l.transfer_line_id,
        quantity: l.quantity,
        inventoryStatus: l.inventory_status,
        stockLocationId: l.stock_location_id,
        movementId: l.movement_id,
      })),
    };
  });
}

export async function receiptBodyOf(client: PoolClient, receiptId: string): Promise<ReceiptBody> {
  const r = await client.query<ReceiptRow>(
    `SELECT id, transfer_id, received_by, received_at, note FROM shipment_transfer_receipts WHERE id = $1`,
    [receiptId],
  );
  if (!r.rows[0]) throw new Error('ShipmentTransfer: the receipt that was just written is not visible');
  return (await receiptBodies(client, r.rows))[0]!;
}
