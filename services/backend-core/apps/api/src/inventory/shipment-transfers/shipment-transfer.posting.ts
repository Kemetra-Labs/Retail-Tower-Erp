/**
 * Transfer posting emission — Jira RT-1513 (RT-291 Gate 5; posting-feed.yaml 1.17.0-draft, RT-1514). The database half
 * of the two ERP legs, reusing the `inventory_count` emission chain (no second feed):
 *
 *   1. resolve and FREEZE every reference (item, batch, source / destination / transit warehouse) into
 *      `transfer_postings` + `transfer_posting_lines`, so a later re-map can neither retarget nor omit a posted leg;
 *   2. insert one `erpnext_posting_status` row per leg (`transfer_dispatch` or `transfer_receive`) whose `externalId`
 *      is the leg-level provenance key (888, 889), `ON CONFLICT DO NOTHING` on the unique leg key (migration 0126);
 *   3. link the leg's effects `not_posted -> pending`.
 *
 * The dispatch leg is written in the same transaction as its `transfer_out` effects (DC-2). A receipt leg is written
 * only once its dispatch is CONFIRMED (the contract's `not_posted until its work item exists`): in the receipt's own
 * transaction when the dispatch is already confirmed, otherwise in the transaction of the dispatch's `posted` ack
 * (`releaseReceiptLegs`). Creating the row only then gives it a sequence past the Connector's cursor, so a held leg can
 * never be skipped. The caller holds the tenant's feed sequence lock (the same order as `ackOutcome`).
 */
import type { PoolClient } from 'pg';

import type { TransferErpPort } from './transfer-erp.port';
import { payloadHash } from '../count-sessions/count-emission';
import {
  TRANSFER_SOURCE_SYSTEM,
  TransferRuleError,
  dispatchBody,
  dispatchExternalId,
  receiptExternalId,
  receiveBody,
} from './shipment-transfer.rules';

const STAMP_SQL = `to_char(($1::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Fail closed (O2, 886) while the source, destination or tenant transit warehouse has no ERP mapping. */
export async function assertWarehousesMapped(
  erp: TransferErpPort,
  client: PoolClient,
  sourceStoreId: string,
  destinationStoreId: string,
): Promise<{ source: string; destination: string; transit: string }> {
  const w = await erp.transferWarehouseRefs(client, sourceStoreId, destinationStoreId);
  if (w.source === null || w.destination === null || w.transit === null) {
    throw new TransferRuleError(
      'transfer_warehouse_unmapped',
      'The source store, the destination store or the tenant transit warehouse has no ERP warehouse mapping.',
    );
  }
  return { source: w.source, destination: w.destination, transit: w.transit };
}

export interface LineRefs {
  readonly itemRef: string;
  /** The ERPNext Batch from the edge map for a batch line (885); null for an untracked product. */
  readonly batchRef: string | null;
}

/**
 * The confirmed ERP item (and, for a tracked line, batch) reference of each product. A product with no confirmed
 * item mapping, or a tracked line whose identity has no edge-map row, fails closed: such a Transfer would deduct
 * stock it could never post (886, G7-9).
 */
export async function lineRefs(
  erp: TransferErpPort,
  client: PoolClient,
  lines: readonly { readonly tenant_product_ref: string; readonly tracking_identity_id: string | null }[],
): Promise<Map<string, LineRefs>> {
  const itemOf = await erp.confirmedItemRefs(client, [...new Set(lines.map((l) => l.tenant_product_ref))]);
  const batchOf = await erp.batchRefsOfIdentities(
    client,
    lines.flatMap((l) => (l.tracking_identity_id ? [l.tracking_identity_id] : [])),
  );
  const out = new Map<string, LineRefs>();
  for (const l of lines) {
    const itemRef = itemOf.get(l.tenant_product_ref);
    const batchRef = l.tracking_identity_id ? (batchOf.get(l.tracking_identity_id) ?? null) : null;
    if (itemRef === undefined || (l.tracking_identity_id !== null && batchRef === null)) {
      throw new TransferRuleError(
        'transfer_item_unmapped',
        'A Transfer line has no confirmed ERP item mapping (or no ERP batch mapping for its tracking identity).',
      );
    }
    out.set(`${l.tenant_product_ref}:${l.tracking_identity_id ?? ''}`, { itemRef, batchRef });
  }
  return out;
}

const refKey = (productId: string, identityId: string | null): string => `${productId}:${identityId ?? ''}`;

interface TransferHead {
  readonly id: string;
  readonly tenant_id: string;
  readonly source_store_id: string;
  readonly destination_store_id: string;
  readonly dispatched_at: Date | null;
}

interface PostingLineRow {
  readonly line_seq: number;
  readonly transfer_line_id: string;
  readonly dispatch_line_seq: number | null;
  readonly erpnext_item_ref: string;
  readonly erpnext_batch_ref: string | null;
  readonly quantity: string;
  readonly unit: string;
}

/** `not_posted -> pending` for the leg's effects. Refuses (rolls back) if any is not a fresh `not_posted` effect. */
async function linkEffects(client: PoolClient, intentId: string, effectIds: readonly string[]): Promise<void> {
  const r = await client.query(
    `UPDATE inventory_effect_integration
        SET state = 'pending', posting_status_id = $1, updated_at = now()
      WHERE effect_id = ANY($2::uuid[]) AND state = 'not_posted'`,
    [intentId, effectIds],
  );
  if ((r.rowCount ?? 0) !== effectIds.length) {
    throw new TransferRuleError('shipment_transfer_effect_not_postable', 'A transfer effect is not in the not_posted state.');
  }
}

async function insertPostingLines(
  client: PoolClient,
  tenantId: string,
  intentId: string,
  lines: readonly PostingLineRow[],
): Promise<void> {
  for (const l of lines) {
    await client.query(
      `INSERT INTO transfer_posting_lines
         (intent_id, tenant_id, line_seq, transfer_line_id, dispatch_line_seq, erpnext_item_ref, erpnext_batch_ref, quantity, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric(19,4), $9)`,
      [intentId, tenantId, l.line_seq, l.transfer_line_id, l.dispatch_line_seq, l.erpnext_item_ref, l.erpnext_batch_ref, l.quantity, l.unit],
    );
  }
}

/** The leg's business date in its store's time zone (one SQL definition, `store_business_date`, migration 0125). */
async function businessDate(client: PoolClient, storeId: string, at: Date): Promise<string> {
  const r = await client.query<{ d: string | null }>(`SELECT store_business_date($1::uuid, $2::timestamptz)::text AS d`, [storeId, at]);
  const d = r.rows[0]?.d;
  if (!d) throw new Error('TransferPosting: the store is not visible');
  return d;
}

/**
 * Emit the dispatch leg of an approved Transfer that has just been dispatched: one work item for the whole
 * Transfer, with every line (lineSeq = the Transfer line's seq, contiguous from 1). Idempotent per Transfer (888).
 */
export async function emitDispatchLeg(
  erp: TransferErpPort,
  client: PoolClient,
  head: TransferHead,
  effects: readonly { readonly lineId: string; readonly movementId: string }[],
): Promise<string> {
  if (!head.dispatched_at) throw new Error('TransferPosting: emitDispatchLeg needs a dispatched Transfer');
  const w = await assertWarehousesMapped(erp, client, head.source_store_id, head.destination_store_id);
  const lines = await client.query<{
    id: string;
    line_seq: number;
    tenant_product_ref: string;
    tracking_identity_id: string | null;
    quantity: string;
    stocking_unit: string;
  }>(
    `SELECT id, line_seq, tenant_product_ref, tracking_identity_id, quantity::text AS quantity, stocking_unit
       FROM shipment_transfer_lines WHERE transfer_id = $1 ORDER BY line_seq`,
    [head.id],
  );
  const refs = await lineRefs(erp, client, lines.rows);
  const stamp = (await client.query<{ s: string }>(`SELECT ${STAMP_SQL} AS s`, [head.dispatched_at])).rows[0]!.s;
  const postingLines: PostingLineRow[] = lines.rows.map((l) => {
    const r = refs.get(refKey(l.tenant_product_ref, l.tracking_identity_id))!;
    return {
      line_seq: l.line_seq,
      transfer_line_id: l.id,
      dispatch_line_seq: null,
      erpnext_item_ref: r.itemRef,
      erpnext_batch_ref: r.batchRef,
      quantity: l.quantity,
      unit: l.stocking_unit,
    };
  });
  const body = dispatchBody({
    transferRef: head.id,
    sourceStoreId: head.source_store_id,
    destinationStoreId: head.destination_store_id,
    sourceWarehouseRef: w.source,
    transitWarehouseRef: w.transit,
    postingDatetime: stamp,
    lines: postingLines.map((l) => ({
      lineSeq: l.line_seq,
      transferLineRef: l.transfer_line_id,
      erpnextItemRef: l.erpnext_item_ref,
      erpnextBatchRef: l.erpnext_batch_ref,
      quantity: l.quantity,
      unit: l.unit,
    })),
  });
  const leg = await erp.insertTransferLeg(client, {
    tenantId: head.tenant_id,
    storeId: head.source_store_id,
    kind: 'transfer_dispatch',
    sourceSystem: TRANSFER_SOURCE_SYSTEM,
    externalId: dispatchExternalId(head.id),
    payloadHash: payloadHash(body),
  });
  if (!leg.fresh) return leg.id;
  await client.query(
    `INSERT INTO transfer_postings
       (intent_id, tenant_id, transfer_id, receipt_id, source_warehouse_ref, transit_warehouse_ref,
        destination_warehouse_ref, dispatch_document_ref, posting_datetime, business_date)
     VALUES ($1, $2, $3, NULL, $4, $5, NULL, NULL, $6, $7::date)`,
    [leg.id, head.tenant_id, head.id, w.source, w.transit, stamp, await businessDate(client, head.source_store_id, head.dispatched_at)],
  );
  await insertPostingLines(client, head.tenant_id, leg.id, postingLines);
  await linkEffects(
    client,
    leg.id,
    effects.map((e) => e.movementId),
  );
  return leg.id;
}

/** The dispatch leg of a Transfer: its intent, and its status and Stock Entry reference (from the catalog port). */
async function dispatchLeg(
  erp: TransferErpPort,
  client: PoolClient,
  transferId: string,
): Promise<{ intentId: string; status: string; documentRef: string | null } | null> {
  const r = await client.query<{ intent_id: string }>(
    `SELECT intent_id FROM transfer_postings WHERE transfer_id = $1 AND receipt_id IS NULL`,
    [transferId],
  );
  const intentId = r.rows[0]?.intent_id;
  if (!intentId) return null;
  const status = await erp.postingLegStatus(client, intentId);
  return status ? { intentId, status: status.status, documentRef: status.documentRef } : null;
}

function parseStockEntry(documentRef: string): { doctype: string; name: string } {
  const parsed: unknown = JSON.parse(documentRef);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { doctype?: unknown }).doctype !== 'string' ||
    typeof (parsed as { name?: unknown }).name !== 'string'
  ) {
    throw new Error('TransferPosting: the dispatch document reference is not {doctype, name}');
  }
  return { doctype: (parsed as { doctype: string }).doctype, name: (parsed as { name: string }).name };
}

/**
 * Emit one receipt leg, only when its dispatch is `posted` (confirmed). Returns the intent id, or null when the
 * dispatch is not confirmed yet (the receipt stays `not_posted` until `releaseReceiptLegs`). Idempotent per receipt (889).
 */
async function emitReceiptLegIfReleasable(
  erp: TransferErpPort,
  client: PoolClient,
  tenantId: string,
  transferId: string,
  receiptId: string,
): Promise<string | null> {
  const dispatch = await dispatchLeg(erp, client, transferId);
  if (!dispatch || dispatch.status !== 'posted' || dispatch.documentRef === null) return null;
  const t = await client.query<TransferHead>(
    `SELECT id, tenant_id, source_store_id, destination_store_id, dispatched_at FROM shipment_transfers WHERE id = $1`,
    [transferId],
  );
  const head = t.rows[0];
  if (!head) throw new Error('TransferPosting: the Transfer is not visible');
  const receipt = await client.query<{ received_at: Date }>(
    `SELECT received_at FROM shipment_transfer_receipts WHERE id = $1`,
    [receiptId],
  );
  const receivedAt = receipt.rows[0]?.received_at;
  if (!receivedAt) throw new Error('TransferPosting: the receipt is not visible');
  const w = await assertWarehousesMapped(erp, client, head.source_store_id, head.destination_store_id);
  const rl = await client.query<{
    line_seq: number;
    transfer_line_id: string;
    quantity: string;
    movement_id: string;
    dispatch_line_seq: number;
    tenant_product_ref: string;
    tracking_identity_id: string | null;
    stocking_unit: string;
  }>(
    `SELECT r.line_seq, r.transfer_line_id, r.quantity::text AS quantity, r.movement_id, l.line_seq AS dispatch_line_seq,
            l.tenant_product_ref, l.tracking_identity_id, l.stocking_unit
       FROM shipment_transfer_receipt_lines r
       JOIN shipment_transfer_lines l ON l.id = r.transfer_line_id AND l.tenant_id = r.tenant_id
      WHERE r.receipt_id = $1 ORDER BY r.line_seq`,
    [receiptId],
  );
  const refs = await lineRefs(erp, client, rl.rows);
  const stamp = (await client.query<{ s: string }>(`SELECT ${STAMP_SQL} AS s`, [receivedAt])).rows[0]!.s;
  const postingLines: PostingLineRow[] = rl.rows.map((l) => {
    const r = refs.get(refKey(l.tenant_product_ref, l.tracking_identity_id))!;
    return {
      line_seq: l.line_seq,
      transfer_line_id: l.transfer_line_id,
      dispatch_line_seq: l.dispatch_line_seq,
      erpnext_item_ref: r.itemRef,
      erpnext_batch_ref: r.batchRef,
      quantity: l.quantity,
      unit: l.stocking_unit,
    };
  });
  const dispatchDocument = parseStockEntry(dispatch.documentRef);
  const body = receiveBody({
    transferRef: transferId,
    receiptRef: receiptId,
    destinationStoreId: head.destination_store_id,
    transitWarehouseRef: w.transit,
    destinationWarehouseRef: w.destination,
    dispatchDocument,
    postingDatetime: stamp,
    lines: postingLines.map((l) => ({
      lineSeq: l.line_seq,
      dispatchLineSeq: l.dispatch_line_seq!,
      transferLineRef: l.transfer_line_id,
      erpnextItemRef: l.erpnext_item_ref,
      erpnextBatchRef: l.erpnext_batch_ref,
      quantity: l.quantity,
      unit: l.unit,
    })),
  });
  const leg = await erp.insertTransferLeg(client, {
    tenantId,
    storeId: head.destination_store_id,
    kind: 'transfer_receive',
    sourceSystem: TRANSFER_SOURCE_SYSTEM,
    externalId: receiptExternalId(receiptId),
    payloadHash: payloadHash(body),
  });
  if (!leg.fresh) return leg.id;
  await client.query(
    `INSERT INTO transfer_postings
       (intent_id, tenant_id, transfer_id, receipt_id, source_warehouse_ref, transit_warehouse_ref,
        destination_warehouse_ref, dispatch_document_ref, posting_datetime, business_date)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9::date)`,
    [
      leg.id,
      tenantId,
      transferId,
      receiptId,
      w.transit,
      w.destination,
      dispatch.documentRef,
      stamp,
      await businessDate(client, head.destination_store_id, receivedAt),
    ],
  );
  await insertPostingLines(client, tenantId, leg.id, postingLines);
  await linkEffects(
    client,
    leg.id,
    rl.rows.map((l) => l.movement_id),
  );
  return leg.id;
}

/**
 * The ack of a dispatch leg just confirmed it: release every receipt of that Transfer that was waiting, oldest first,
 * in the ack's own transaction (the caller holds the tenant's feed sequence lock). Returns the intents created.
 */
export async function releaseReceiptLegs(
  erp: TransferErpPort,
  client: PoolClient,
  tenantId: string,
  dispatchIntentId: string,
): Promise<string[]> {
  const t = await client.query<{ transfer_id: string }>(
    `SELECT transfer_id FROM transfer_postings WHERE intent_id = $1 AND receipt_id IS NULL`,
    [dispatchIntentId],
  );
  const transferId = t.rows[0]?.transfer_id;
  if (!transferId) return [];
  const waiting = await client.query<{ id: string }>(
    `SELECT r.id FROM shipment_transfer_receipts r
      WHERE r.transfer_id = $1
        AND NOT EXISTS (SELECT 1 FROM transfer_postings tp WHERE tp.receipt_id = r.id)
      ORDER BY r.receipt_seq`,
    [transferId],
  );
  const released: string[] = [];
  for (const r of waiting.rows) {
    // A savepoint per receipt: a refusal can come after the leg's first writes (`linkEffects` runs last), and a
    // half-built leg must never commit.
    await client.query('SAVEPOINT release_receipt_leg');
    try {
      const id = await emitReceiptLegIfReleasable(erp, client, tenantId, transferId, r.id);
      if (id) released.push(id);
      await client.query('RELEASE SAVEPOINT release_receipt_leg');
    } catch (err) {
      // A mapping that went missing since the receipt, or an effect that is no longer postable, must not fail the
      // dispatch's ack (the Connector would retry it forever and the confirmation would never commit). Everything
      // that receipt wrote is rolled back to the savepoint: it stays `not_posted`, visibly stuck for the
      // delayed-transfer alert (RT-1516), and is released by the next receipt of the Transfer once repaired. Only
      // the typed rule refusals are swallowed; anything else (a SQL error) fails the ack as before.
      if (!(err instanceof TransferRuleError)) throw err;
      await client.query('ROLLBACK TO SAVEPOINT release_receipt_leg');
      await client.query('RELEASE SAVEPOINT release_receipt_leg');
    }
  }
  return released;
}
