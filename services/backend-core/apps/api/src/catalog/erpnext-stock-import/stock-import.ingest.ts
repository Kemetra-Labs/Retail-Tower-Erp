/**
 * Ingestion of one reported page of ERP Stock Ledger facts (RT-1288): every row
 * is recorded once and classified (DC-4); an ERP-owned voucher without Retail
 * provenance becomes exactly one `erp_external` effect; everything else is a
 * visible finding or a recorded non-import, never a silent merge (898-904).
 *
 * Called by `ErpnextStockImportService.reportRows` inside the report's
 * transaction, which has already taken the tenant inventory settings lock
 * SHARED (`readSaleEffectsActivation`) and read the store's anchor: activation
 * (EXCLUSIVE) cannot write a new anchor between that read and these effects,
 * so the anchor watermark and the effects come from one consistent read (DC-8).
 *
 * Per row, in report order:
 *   0. A row already recorded at the same (warehouse, ledgerEntryRef,
 *      entryIndex) is a re-read (cursor overlap): skipped, never classified
 *      twice.
 *   1. Retail provenance → `retail_provenance` (899; Retail Tower already knows it).
 *   2. `creation` at or before the anchor's `snapshot_read_at` → `covered`: the
 *      anchor's Bin already contains it (DC-8; otherwise it would count twice).
 *   3. No `voucherDetailNo` → finding `unkeyable_row` (no DC-4 key).
 *   4. Not an ERP-owned family → finding `unattributed_erp_movement` (901).
 *   5. The Item maps to no single confirmed product → finding `unknown_item`.
 *   6. Zero quantity → `zero_quantity`; more than 4 fractional digits → finding
 *      `quantity_precision` (the journal keeps 4; never rounded silently).
 *   7. `stockUom` differs from the product's established unit at the store →
 *      finding `uom_mismatch`.
 *   8. Tracking: a batch-tracked product needs a Batch whose edge-map identity
 *      is of the same product; an unknown Batch is handed to RT-453 identity
 *      birth (`awaiting_identity`, no effect); a Batch of another product, a
 *      missing Batch or a serial product is a finding `tracking_mismatch`. An
 *      untracked product imports at the product grain.
 *   9. Key (DC-4, DC-6): the base key; a cancelled row whose base key is
 *      already recorded from another ledger position is the reverse row and
 *      takes the `cancel` key; any other repeat of a key is a finding
 *      `duplicate_effect_key` (never swallowed by the unique index).
 *  10. Import: the effect at the store's primary location (the bucket inbound
 *      position, M-8), `sellable`, or the identity's hold status when it has an
 *      active hold (recall over quality, G7-4); integration `external` with
 *      `erp_confirmed_at` = `creation`. `received_at` is `clock_timestamp()`,
 *      read after the settings lock, so a committed activation's anchor never
 *      counts the effect as covered (`SINCE_ANCHOR`).
 */
import type { PoolClient } from "pg";
import { emit, OUTBOX_EVENT_TYPES } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import type { StockImportRowInput } from "./dto/stock-import.dto";
import {
  cancelKey,
  effectKeyBase,
  ERP_IMPORT_SOURCE_SYSTEM,
  erpOwnedEventType,
  type ErpInventoryEventType,
  isNegativeQuantity,
  isZeroQuantity,
  journalQuantity,
} from "./stock-import.rules";

type Outcome = "imported" | "covered" | "retail_provenance" | "zero_quantity" | "awaiting_identity" | "finding";
type FindingKind =
  | "unattributed_erp_movement"
  | "unknown_item"
  | "uom_mismatch"
  | "unkeyable_row"
  | "quantity_precision"
  | "duplicate_effect_key"
  | "tracking_mismatch";

export interface IngestContext {
  readonly tenantId: string;
  readonly storeId: string;
  readonly pageId: string;
  readonly erpnextWarehouseRef: string;
  /** The anchor's `snapshot_read_at`, as Postgres text (exact microseconds). */
  readonly anchorReadAt: string;
  readonly primaryLocationId: string;
  /** `stock_movements.created_by`: the connector registration that reported. */
  readonly actorId: string;
}

export interface IngestSummary {
  readonly recorded: number;
  readonly replayed: number;
  readonly imported: readonly string[];
  readonly findings: number;
}

interface Decision {
  readonly outcome: Outcome;
  readonly finding?: { readonly kind: FindingKind; readonly detail?: Record<string, unknown> };
  readonly effectKey: string | null;
  readonly productId: string | null;
  readonly identityId: string | null;
  readonly eventType?: ErpInventoryEventType;
  readonly quantity?: string;
}

const finding = (
  kind: FindingKind,
  rest: Partial<Pick<Decision, "effectKey" | "productId" | "identityId">> = {},
  detail?: Record<string, unknown>,
): Decision => ({
  outcome: "finding",
  finding: detail === undefined ? { kind } : { kind, detail },
  effectKey: rest.effectKey ?? null,
  productId: rest.productId ?? null,
  identityId: rest.identityId ?? null,
});

/** Ingest the page's rows in report order. */
export async function ingestRows(
  client: PoolClient,
  ctx: IngestContext,
  rows: readonly StockImportRowInput[],
): Promise<IngestSummary> {
  const covered = await coveredFlags(client, ctx.anchorReadAt, rows);
  const imported: string[] = [];
  let replayed = 0;
  let findings = 0;
  for (const [i, row] of rows.entries()) {
    // sequential: each row's key and duplicate checks read the records the rows before it wrote.
    if (await alreadyRecorded(client, ctx, row)) {
      replayed += 1;
      continue;
    }
    const rowId = newId();
    const decision = await decide(client, ctx, row, covered[i] === true);
    let final = decision;
    let effectId: string | null = null;
    if (decision.outcome === "imported") {
      effectId = await writeEffect(client, ctx, row, rowId, decision);
      if (effectId === null) final = finding("duplicate_effect_key", decision, { reason: "key_exists" });
      else imported.push(effectId);
    }
    await recordRow(client, ctx, row, rowId, final, effectId);
    if (final.finding !== undefined) {
      findings += 1;
      await recordFinding(client, ctx, rowId, final.finding.kind, {
        voucherType: row.voucherType,
        voucherNo: row.voucherNo,
        ...final.finding.detail,
      });
    }
  }
  if (imported.length > 0) {
    await emit(client, {
      eventType: OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      payload: { movementIds: imported, movementType: "erp_import", tenantProductRef: null, pageId: ctx.pageId },
      correlationId: null,
    });
  }
  return { recorded: rows.length - replayed, replayed, imported, findings };
}

/** For each row, whether its `creation` is at or before the anchor snapshot (exact, in SQL). */
async function coveredFlags(
  client: PoolClient,
  anchorReadAt: string,
  rows: readonly StockImportRowInput[],
): Promise<boolean[]> {
  if (rows.length === 0) return [];
  const r = await client.query<{ covered: boolean }>(
    `SELECT (c::timestamptz <= $2::timestamptz) AS covered
       FROM unnest($1::text[]) WITH ORDINALITY AS t(c, ord)
      ORDER BY ord`,
    [rows.map((row) => row.creation), anchorReadAt],
  );
  return r.rows.map((x) => x.covered);
}

async function alreadyRecorded(client: PoolClient, ctx: IngestContext, row: StockImportRowInput): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM erp_stock_import_rows
      WHERE erpnext_warehouse_ref = $1 AND ledger_entry_ref = $2 AND entry_index = $3`,
    [ctx.erpnextWarehouseRef, row.ledgerEntryRef, row.entryIndex],
  );
  return (r.rowCount ?? 0) > 0;
}

function baseKey(ctx: IngestContext, row: StockImportRowInput): string | null {
  if (row.voucherDetailNo === null) return null;
  return effectKeyBase({
    voucherType: row.voucherType,
    voucherNo: row.voucherNo,
    voucherDetailNo: row.voucherDetailNo,
    erpnextWarehouseRef: ctx.erpnextWarehouseRef,
    batch: row.erpnextBatchRef?.name ?? null,
  });
}

// eslint-disable-next-line complexity -- the DC-4 precedence is one ordered list; splitting it hides the order.
async function decide(
  client: PoolClient,
  ctx: IngestContext,
  row: StockImportRowInput,
  covered: boolean,
): Promise<Decision> {
  const base = baseKey(ctx, row);
  const none = { effectKey: base, productId: null, identityId: null };
  if (row.hasRetailProvenance) return { outcome: "retail_provenance", ...none };
  if (covered) return { outcome: "covered", ...none };
  if (base === null) return finding("unkeyable_row");
  const eventType = erpOwnedEventType(row);
  if (eventType === null) return finding("unattributed_erp_movement", { effectKey: base }, { purpose: row.purpose });
  const product = await resolveProduct(client, row.erpnextItemRef.name);
  if (product === null) return finding("unknown_item", { effectKey: base }, { erpnextItemRef: row.erpnextItemRef.name });
  const withProduct = { effectKey: base, productId: product.id };
  if (isZeroQuantity(row.actualQty)) return { outcome: "zero_quantity", ...withProduct, identityId: null };
  const quantity = journalQuantity(row.actualQty);
  if (quantity === null) return finding("quantity_precision", withProduct, { actualQty: row.actualQty });
  const unit = await establishedUnit(client, ctx.storeId, product.id);
  if (unit !== null && unit !== row.stockUom) {
    return finding("uom_mismatch", withProduct, { stockUom: row.stockUom, establishedUnit: unit });
  }
  const tracking = await resolveTracking(client, product, row);
  if (tracking.kind === "mismatch") return finding("tracking_mismatch", withProduct, { reason: tracking.reason });
  if (tracking.kind === "awaiting") return { outcome: "awaiting_identity", ...withProduct, identityId: null };
  const key = await keyFor(client, base, row);
  if (key === null) return finding("duplicate_effect_key", { ...withProduct, identityId: tracking.identityId });
  return {
    outcome: "imported",
    effectKey: key,
    productId: product.id,
    identityId: tracking.identityId,
    eventType,
    quantity,
  };
}

interface ProductFacts {
  readonly id: string;
  readonly trackingMode: string;
}

/** The single confirmed, active product the Item maps to (the anchor's rule), or null. */
async function resolveProduct(client: PoolClient, item: string): Promise<ProductFacts | null> {
  const r = await client.query<{ id: string; tracking_mode: string }>(
    `SELECT p.id, p.tracking_mode
       FROM (SELECT min(m.tenant_product_id::text)::uuid AS product
               FROM erpnext_item_map m
              WHERE m.erpnext_item_ref = $1 AND m.state = 'confirmed' AND m.retired_at IS NULL
             HAVING count(*) = 1) one
       JOIN tenant_products p ON p.id = one.product`,
    [item],
  );
  const row = r.rows[0];
  return row === undefined ? null : { id: row.id, trackingMode: row.tracking_mode };
}

/** The unit the product's movements at the store already use (0016), or null. */
async function establishedUnit(client: PoolClient, storeId: string, productId: string): Promise<string | null> {
  const r = await client.query<{ stocking_unit: string }>(
    `SELECT stocking_unit FROM stock_movements
      WHERE store_id = $1 AND tenant_product_ref = $2
      LIMIT 1`,
    [storeId, productId],
  );
  return r.rows[0]?.stocking_unit ?? null;
}

type Tracking =
  | { readonly kind: "ok"; readonly identityId: string | null }
  | { readonly kind: "awaiting" }
  | { readonly kind: "mismatch"; readonly reason: string };

async function resolveTracking(client: PoolClient, product: ProductFacts, row: StockImportRowInput): Promise<Tracking> {
  if (product.trackingMode === "none") return { kind: "ok", identityId: null };
  if (product.trackingMode !== "batch") return { kind: "mismatch", reason: "serial_not_supported" };
  const batch = row.erpnextBatchRef?.name ?? null;
  if (batch === null) return { kind: "mismatch", reason: "batch_missing" };
  const r = await client.query<{ id: string; tenant_product_ref: string }>(
    `SELECT i.id, i.tenant_product_ref
       FROM erpnext_tracking_map m
       JOIN tracking_identities i ON i.id = m.tracking_identity_id AND i.tenant_id = m.tenant_id
      WHERE m.kind = 'batch' AND m.erpnext_ref = $1`,
    [batch],
  );
  const identity = r.rows[0];
  if (identity === undefined) return { kind: "awaiting" };
  if (identity.tenant_product_ref !== product.id) return { kind: "mismatch", reason: "batch_of_other_product" };
  return { kind: "ok", identityId: identity.id };
}

/**
 * The key this row imports under, or null for a duplicate. A key already
 * recorded from another ledger position means either the reverse row of a
 * cancellation (DC-6: `cancel` key, once) or a real duplicate.
 */
async function keyFor(client: PoolClient, base: string, row: StockImportRowInput): Promise<string | null> {
  const r = await client.query<{ effect_key: string }>(
    `SELECT DISTINCT effect_key FROM erp_stock_import_rows WHERE effect_key = ANY($1::text[])`,
    [[base, cancelKey(base)]],
  );
  const seen = new Set(r.rows.map((x) => x.effect_key));
  if (!seen.has(base)) return base;
  if (row.isCancelled && !seen.has(cancelKey(base))) return cancelKey(base);
  return null;
}

/** The landing status of an identity-grain effect: its active hold, recall over quality (G7-4). */
async function landingStatus(client: PoolClient, identityId: string | null): Promise<string> {
  if (identityId === null) return "sellable";
  const r = await client.query<{ kind: string }>(
    `SELECT kind FROM tracking_holds WHERE tracking_identity_id = $1 AND released_at IS NULL`,
    [identityId],
  );
  const kinds = new Set(r.rows.map((x) => x.kind));
  if (kinds.has("recall_hold")) return "recall_hold";
  if (kinds.has("quality_hold")) return "quality_hold";
  return "sellable";
}

/** Append the `erp_external` effect and its `external` integration record; null when the key exists. */
async function writeEffect(
  client: PoolClient,
  ctx: IngestContext,
  row: StockImportRowInput,
  rowId: string,
  d: Decision,
): Promise<string | null> {
  if (d.identityId !== null) {
    // The safety commands' lock order (sale-effects `lockIdentitiesForKeyShare`).
    await client.query(`SELECT id FROM tracking_identities WHERE id = $1 FOR KEY SHARE`, [d.identityId]);
  }
  const status = await landingStatus(client, d.identityId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, received_at, source_system, external_id, created_by, origin, event_type, event_ref_id,
        stock_location_id, inventory_status, tracking_identity_id)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8,
             $9::timestamptz, clock_timestamp(), $10, $11, $12, 'erp_external', $13, $14,
             $15, $16, $17)
     ON CONFLICT (tenant_id, source_system, external_id)
       WHERE source_system IS NOT NULL AND external_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      newId(),
      ctx.tenantId,
      ctx.storeId,
      isNegativeQuantity(d.quantity!) ? "outbound" : "inbound",
      d.quantity,
      row.stockUom,
      d.productId,
      `ERP ${row.voucherType} ${row.voucherNo}`.slice(0, 500),
      row.creation,
      ERP_IMPORT_SOURCE_SYSTEM,
      d.effectKey,
      ctx.actorId,
      d.eventType,
      rowId,
      ctx.primaryLocationId,
      status,
      d.identityId,
    ],
  );
  const effectId = inserted.rows[0]?.id ?? null;
  if (effectId === null) return null;
  await client.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_document_ref, erp_confirmed_at)
     VALUES ($1, $2, 'external', $3, $4::timestamptz)`,
    [effectId, ctx.tenantId, row.voucherNo, row.creation],
  );
  return effectId;
}

async function recordRow(
  client: PoolClient,
  ctx: IngestContext,
  row: StockImportRowInput,
  rowId: string,
  d: Decision,
  effectId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO erp_stock_import_rows
       (id, tenant_id, store_id, page_id, erpnext_warehouse_ref, ledger_entry_ref, entry_index,
        voucher_type, voucher_no, voucher_detail_no, erpnext_item_ref, erpnext_batch_ref, creation,
        is_cancelled, actual_qty, stock_uom, outcome, effect_key, tenant_product_ref,
        tracking_identity_id, effect_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz,
             $14, $15::numeric, $16, $17, $18, $19, $20, $21)`,
    [
      rowId,
      ctx.tenantId,
      ctx.storeId,
      ctx.pageId,
      ctx.erpnextWarehouseRef,
      row.ledgerEntryRef,
      row.entryIndex,
      row.voucherType,
      row.voucherNo,
      row.voucherDetailNo,
      row.erpnextItemRef.name,
      row.erpnextBatchRef?.name ?? null,
      row.creation,
      row.isCancelled,
      row.actualQty,
      row.stockUom,
      d.outcome,
      d.effectKey,
      d.productId,
      d.identityId,
      effectId,
    ],
  );
}

export async function recordFinding(
  client: PoolClient,
  ctx: Pick<IngestContext, "tenantId" | "storeId" | "pageId" | "erpnextWarehouseRef">,
  rowId: string | null,
  kind: FindingKind | "unmapped_warehouse",
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO erp_stock_import_findings (id, tenant_id, store_id, page_id, row_id, erpnext_warehouse_ref, kind, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [newId(), ctx.tenantId, ctx.storeId, ctx.pageId, rowId, ctx.erpnextWarehouseRef, kind, JSON.stringify(detail)],
  );
}
