/**
 * The frozen rows of one transfer leg, for the posting feed — Jira RT-1513. A public port of `inventory` (RT-1453): the feed
 * projection (catalog) builds the wire work item from these rows, and used to have to name `shipment_transfers`,
 * `transfer_postings` and `transfer_posting_lines` itself. Read only, on the caller's client (RLS scopes it). Nothing here
 * reads a live map: a later re-map can neither retarget nor omit a posted leg.
 */
import type { PoolClient } from 'pg';

export interface TransferLegHead {
  readonly transferId: string;
  readonly receiptId: string | null;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly sourceWarehouseRef: string | null;
  readonly transitWarehouseRef: string;
  readonly destinationWarehouseRef: string | null;
  /** The confirmed dispatch Stock Entry `{doctype, name}` JSON text, frozen on a receipt leg. */
  readonly dispatchDocumentRef: string | null;
  readonly postingDatetime: string;
  readonly businessDate: string;
}

export interface TransferLegLine {
  readonly lineSeq: number;
  readonly transferLineRef: string;
  readonly dispatchLineSeq: number | null;
  readonly erpnextItemRef: string;
  readonly erpnextBatchRef: string | null;
  readonly quantity: string;
  readonly unit: string;
}

/** The leg's frozen head and lines, or null when the leg or its lines are not visible under the current tenant. */
export async function loadTransferLeg(
  client: PoolClient,
  intentId: string,
  kind: 'transfer_dispatch' | 'transfer_receive',
): Promise<{ readonly head: TransferLegHead; readonly lines: readonly TransferLegLine[] } | null> {
  const head = await client.query<{
    transfer_id: string;
    receipt_id: string | null;
    source_store_id: string;
    destination_store_id: string;
    source_warehouse_ref: string | null;
    transit_warehouse_ref: string;
    destination_warehouse_ref: string | null;
    dispatch_document_ref: string | null;
    posting_datetime: string;
    business_date: string;
  }>(
    `SELECT tp.transfer_id, tp.receipt_id, t.source_store_id, t.destination_store_id, tp.source_warehouse_ref,
            tp.transit_warehouse_ref, tp.destination_warehouse_ref, tp.dispatch_document_ref, tp.posting_datetime,
            tp.business_date::text AS business_date
       FROM transfer_postings tp
       JOIN shipment_transfers t ON t.id = tp.transfer_id AND t.tenant_id = tp.tenant_id
      WHERE tp.intent_id = $1 AND (tp.receipt_id IS NULL) = ($2 = 'transfer_dispatch')`,
    [intentId, kind],
  );
  const h = head.rows[0];
  if (!h) return null;
  const lines = await client.query<{
    line_seq: number;
    transfer_line_id: string;
    dispatch_line_seq: number | null;
    erpnext_item_ref: string;
    erpnext_batch_ref: string | null;
    quantity: string;
    unit: string;
  }>(
    `SELECT line_seq, transfer_line_id, dispatch_line_seq, erpnext_item_ref, erpnext_batch_ref, quantity::text AS quantity, unit
       FROM transfer_posting_lines WHERE intent_id = $1 ORDER BY line_seq`,
    [intentId],
  );
  if (lines.rows.length === 0) return null;
  return {
    head: {
      transferId: h.transfer_id,
      receiptId: h.receipt_id,
      sourceStoreId: h.source_store_id,
      destinationStoreId: h.destination_store_id,
      sourceWarehouseRef: h.source_warehouse_ref,
      transitWarehouseRef: h.transit_warehouse_ref,
      destinationWarehouseRef: h.destination_warehouse_ref,
      dispatchDocumentRef: h.dispatch_document_ref,
      postingDatetime: h.posting_datetime,
      businessDate: h.business_date,
    },
    lines: lines.rows.map((l) => ({
      lineSeq: l.line_seq,
      transferLineRef: l.transfer_line_id,
      dispatchLineSeq: l.dispatch_line_seq,
      erpnextItemRef: l.erpnext_item_ref,
      erpnextBatchRef: l.erpnext_batch_ref,
      quantity: l.quantity,
      unit: l.unit,
    })),
  };
}
