/**
 * Late-event compensation store — Jira RT-1424 (RT-292 Gate 6, G6-5). SQL only: loads the evidence the pure rules
 * (`late-compensation.rules.ts`) judge, writes the compensation, and re-reads the books for condition I. Every
 * statement runs on the caller's client under the tenant context (RLS); nothing here touches ERP, the posting feed,
 * an intent or a work item.
 */
import { LATEST_BIN_CTES, readPendingAwarePositions, type PendingAwarePosition } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';

import { MOVEMENT_COLUMNS } from '../inventory.types';
import { insertMovementRow } from '../inventory-write.helpers';
import type { CompensationEvidence, CompensationPlan, LedgerRow } from './late-compensation.rules';

export interface FindingRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly store_id: string;
  readonly session_id: string;
  readonly tenant_product_ref: string;
  readonly quantity: string;
  readonly event_type: string;
  readonly event_reference: string;
  readonly source_system: string;
  readonly external_id: string;
  readonly effect_id: string;
  readonly erp_stamp: Date;
  readonly detected_in_state: string;
}

export interface CompensationRow {
  readonly id: string;
  readonly session_id: string;
  readonly late_effect_id: string;
  readonly count_effect_id: string;
  readonly compensation_effect_id: string;
  readonly quantity: string;
  readonly absorbing_document_ref: string;
  readonly reason: string;
  readonly approved_by: string;
  readonly idempotency_key: string;
  readonly created_at: Date;
}

const COMPENSATION_COLUMNS = `id, session_id, late_effect_id, count_effect_id, compensation_effect_id,
  quantity::text AS quantity, absorbing_document_ref, reason, approved_by, idempotency_key, created_at`;

export async function loadFinding(
  client: PoolClient,
  sessionId: string,
  findingId: string,
): Promise<FindingRow | null> {
  const r = await client.query<FindingRow>(
    `SELECT id, tenant_id, store_id, session_id, tenant_product_ref, quantity::text AS quantity, event_type,
            event_reference, source_system, external_id, effect_id, erp_stamp, detected_in_state
       FROM count_late_event_findings WHERE id = $1 AND session_id = $2`,
    [findingId, sessionId],
  );
  return r.rows[0] ?? null;
}

/** One compensation per late event; serialised across sessions by an advisory lock on the late effect. */
export async function lockLateEvent(client: PoolClient, tenantId: string, lateEffectId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('count_late_compensation:' || $1::text || ':' || $2::text, 0))`,
    [tenantId, lateEffectId],
  );
}

export async function findCompensation(
  client: PoolClient,
  tenantId: string,
  lateEffectId: string,
): Promise<CompensationRow | null> {
  const r = await client.query<CompensationRow>(
    `SELECT ${COMPENSATION_COLUMNS} FROM count_late_compensations WHERE tenant_id = $1 AND late_effect_id = $2`,
    [tenantId, lateEffectId],
  );
  return r.rows[0] ?? null;
}

export async function listCompensations(client: PoolClient, sessionId: string): Promise<CompensationRow[]> {
  const r = await client.query<CompensationRow>(
    `SELECT ${COMPENSATION_COLUMNS} FROM count_late_compensations WHERE session_id = $1 ORDER BY created_at, id`,
    [sessionId],
  );
  return r.rows;
}

interface LedgerDbRow {
  is_cancelled: boolean;
  posting_date: string | null;
  posting_time: string | null;
  actual_qty: string;
  stock_uom: string;
  creation: Date;
}

const LEDGER_COLUMNS = `is_cancelled, posting_date::text AS posting_date, posting_time::text AS posting_time, actual_qty::text AS actual_qty,
  stock_uom, creation`;

const toLedger = (r: LedgerDbRow): LedgerRow => ({
  isCancelled: r.is_cancelled,
  postingDate: r.posting_date,
  postingTime: r.posting_time,
  actualQty: r.actual_qty,
  stockUom: r.stock_uom,
  creation: r.creation,
});

/** `{"doctype": ..., "name": ...}` stored as JSON text; anything else is no document. */
function parseDocument(text: string | null): { doctype: string; name: string } | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as { doctype?: unknown; name?: unknown };
    return typeof v.doctype === 'string' && typeof v.name === 'string' ? { doctype: v.doctype, name: v.name } : null;
  } catch {
    return null;
  }
}

async function voucherRows(
  client: PoolClient,
  storeId: string,
  doc: { doctype: string; name: string } | null,
  item: string,
  warehouse: string,
): Promise<LedgerRow[]> {
  if (doc === null) return [];
  const r = await client.query<LedgerDbRow>(
    `SELECT ${LEDGER_COLUMNS} FROM erp_stock_import_rows
      WHERE store_id = $1 AND voucher_type = $2 AND voucher_no = $3 AND erpnext_item_ref = $4
        AND erpnext_warehouse_ref = $5`,
    [storeId, doc.doctype, doc.name, item, warehouse],
  );
  return r.rows.map(toLedger);
}

export interface SessionFacts {
  readonly id: string;
  readonly tenant_id: string;
  readonly store_id: string;
  readonly state: string;
  readonly cut_at: Date | null;
}

/** Load everything the rules judge. A missing piece is `null` or an empty list, never an exception. */
export async function loadEvidence(
  client: PoolClient,
  session: SessionFacts,
  finding: FindingRow,
): Promise<CompensationEvidence> {
  const lateQ = await client.query(
    `SELECT m.id, m.store_id, m.tenant_product_ref, m.quantity::text AS quantity, m.stocking_unit,
            m.stock_location_id, m.inventory_status, m.movement_type, m.origin, m.event_type,
            m.event_ref_id::text AS event_ref_id, m.source_system, m.external_id, m.received_at,
            i.state AS integration_state, i.erp_document_ref, i.erp_confirmed_at
       FROM stock_movements m LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
      WHERE m.id = $1`,
    [finding.effect_id],
  );
  const l = lateQ.rows[0];
  const late: CompensationEvidence['late'] = l
    ? {
        id: l.id,
        storeId: l.store_id,
        productId: l.tenant_product_ref,
        quantity: l.quantity,
        unit: l.stocking_unit,
        locationId: l.stock_location_id,
        status: l.inventory_status,
        movementType: l.movement_type,
        origin: l.origin,
        eventType: l.event_type,
        eventRefId: l.event_ref_id,
        sourceSystem: l.source_system,
        externalId: l.external_id,
        receivedAt: l.received_at,
        integrationState: l.integration_state,
        erpDocumentRef: l.erp_document_ref,
        erpConfirmedAt: l.erp_confirmed_at,
      }
    : null;

  const lineQ = await client.query<{ stock_count_id: string | null; correction_effect_ids: string[] | null }>(
    `SELECT stock_count_id, correction_effect_ids FROM count_session_lines
      WHERE session_id = $1 AND tenant_product_ref = $2`,
    [session.id, finding.tenant_product_ref],
  );
  const lineRow = lineQ.rows[0];
  const effects = await client.query(
    `SELECT id, movement_type, compensates_effect_id, stock_location_id, inventory_status
       FROM stock_movements WHERE id = ANY($1::uuid[])`,
    [lineRow?.correction_effect_ids ?? []],
  );

  const chunk = await client.query(
    `SELECT l.result, l.verified_qty_after, l.counted_quantity::text AS counted_quantity, l.unit, l.erpnext_item_ref,
            l.warehouse_ref, p.status, p.document_ref, p.posted_at
       FROM count_posting_lines l
       JOIN erpnext_posting_status p ON p.id = l.intent_id AND p.tenant_id = l.tenant_id
      WHERE p.count_session_id = $1 AND p.kind = 'inventory_count' AND l.tenant_product_ref = $2`,
    [session.id, finding.tenant_product_ref],
  );
  const c = chunk.rows.length === 1 ? chunk.rows[0] : null;
  const countRows = c
    ? await voucherRows(client, session.store_id, parseDocument(c.document_ref), c.erpnext_item_ref, c.warehouse_ref)
    : [];
  let lateRows: LedgerRow[] = [];
  if (late && c) {
    if (late.origin === 'erp_external') {
      const r = await client.query<LedgerDbRow>(
        `SELECT ${LEDGER_COLUMNS} FROM erp_stock_import_rows
          WHERE store_id = $1 AND effect_id = $2 AND erpnext_item_ref = $3 AND erpnext_warehouse_ref = $4`,
        [session.store_id, late.id, c.erpnext_item_ref, c.warehouse_ref],
      );
      lateRows = r.rows.map(toLedger);
    } else {
      lateRows = await voucherRows(
        client,
        session.store_id,
        parseDocument(late.erpDocumentRef),
        c.erpnext_item_ref,
        c.warehouse_ref,
      );
    }
  }

  const bin = await client.query<{ quantity: string; read_at: Date; uom: string | null }>(
    `WITH ${LATEST_BIN_CTES} SELECT quantity::text AS quantity, read_at, uom FROM bin WHERE store_id = $1 AND product = $2`,
    [session.store_id, finding.tenant_product_ref],
  );
  const book = await readBook(client, session.store_id);
  const position = book.get(finding.tenant_product_ref) ?? null;

  return {
    session: { state: session.state, cutAt: session.cut_at },
    finding: {
      id: finding.id,
      sessionId: finding.session_id,
      productId: finding.tenant_product_ref,
      quantity: finding.quantity,
      eventType: finding.event_type,
      eventReference: finding.event_reference,
      sourceSystem: finding.source_system,
      externalId: finding.external_id,
      effectId: finding.effect_id,
      erpStamp: finding.erp_stamp,
      detectedInState: finding.detected_in_state,
    },
    late,
    storeId: session.store_id,
    countEffects: effects.rows.map((e) => ({
      id: e.id,
      movementType: e.movement_type,
      compensates: e.compensates_effect_id,
      locationId: e.stock_location_id,
      status: e.inventory_status,
    })),
    stockCountId: lineRow?.stock_count_id ?? null,
    countLine: c
      ? {
          result: c.result,
          verifiedQtyAfter: c.verified_qty_after,
          countedQuantity: c.counted_quantity,
          unit: c.unit,
          intentStatus: c.status,
          documentRef: c.document_ref,
          postedAt: c.posted_at,
        }
      : null,
    countRows,
    lateRows,
    bin: bin.rows[0] ? { quantity: bin.rows[0].quantity, readAt: bin.rows[0].read_at, uom: bin.rows[0].uom } : null,
    position: position
      ? {
          operationalPosition: position.operationalPosition,
          expectedErpBook: position.expectedErpBook,
          operationalUnit: position.operationalUnit,
          erpStockUom: position.erpStockUom,
        }
      : null,
  };
}

/** The store's whole pending-aware book, keyed by product: the before/after picture of condition I. */
export async function readBook(client: PoolClient, storeId: string): Promise<Map<string, PendingAwarePosition>> {
  const all = await readPendingAwarePositions(client, storeId);
  return new Map(all.map((p) => [p.tenantProductRef, p]));
}

export interface WrittenCompensation {
  readonly effectId: string;
  readonly row: CompensationRow;
}

/** Append the compensating effect (never an update), its `erp_absorbed` state, and the compensation record. */
export async function writeCompensation(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly sessionId: string;
    readonly finding: FindingRow;
    readonly plan: CompensationPlan;
    readonly lateUnit: string;
    readonly locationId: string | null;
    readonly status: string | null;
    readonly stockCountId: string;
    readonly approvedBy: string;
    readonly reason: string;
    readonly key: string;
  },
): Promise<WrittenCompensation> {
  const effectId = newId();
  await insertMovementRow(
    client,
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, stock_count_id, reason,
        occurred_at, created_by, event_type, event_ref_id, stock_location_id, inventory_status, compensates_effect_id)
     VALUES ($1, $2, $3, 'count_correction', $4::numeric(19,4), $5, $6, $7, 'late event absorbed by ERP count', now(),
             $8, 'count', $7, $9, $10, $11)
     RETURNING ${MOVEMENT_COLUMNS}`,
    [
      effectId,
      input.tenantId,
      input.storeId,
      input.plan.quantity,
      input.lateUnit,
      input.finding.tenant_product_ref,
      input.stockCountId,
      input.approvedBy,
      input.locationId,
      input.status,
      input.plan.countEffectId,
    ],
    { storeId: input.storeId, tenantProductRef: input.finding.tenant_product_ref, suppliedUnit: input.lateUnit },
  );
  await client.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_document_ref, state_reason)
     VALUES ($1, $2, 'erp_absorbed', $3, 'late_event_absorbed_by_count')`,
    [effectId, input.tenantId, input.plan.absorbingDocument],
  );
  const r = await client.query<CompensationRow>(
    `INSERT INTO count_late_compensations
       (id, tenant_id, store_id, session_id, tenant_product_ref, late_effect_id, count_effect_id,
        compensation_effect_id, quantity, absorbing_document_ref, reason, approved_by, idempotency_key, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric(19,4), $10, $11, $12, $13, $14::jsonb)
     RETURNING ${COMPENSATION_COLUMNS}`,
    [
      newId(),
      input.tenantId,
      input.storeId,
      input.sessionId,
      input.finding.tenant_product_ref,
      input.finding.effect_id,
      input.plan.countEffectId,
      effectId,
      input.plan.quantity,
      input.plan.absorbingDocument,
      input.reason,
      input.approvedBy,
      input.key,
      JSON.stringify(input.plan.evidence),
    ],
  );
  return { effectId, row: r.rows[0] as CompensationRow };
}
