/**
 * The capture transaction's row writers (split out of `sales.service.ts`, RT-1337,
 * to keep that file under its size limit): the `sales` header with its receipt
 * snapshot, and the frozen `sale_lines` snapshot.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import type { CaptureSaleReceiptDto, CaptureSaleRequestDto } from "./dto/capture-sale-request.dto";
import { SALE_SYNC_STATUS } from "./sale-sync-status";
import type { LineClassification } from "./tracked-lines/capture-tracking.rules";
import type { CaptureSaleInput } from "./sales.service";

/**
 * RT-539: the nine `sales.receipt_*` values in INSERT order ($17-$25), all
 * null without a snapshot. `receiptNumber` and `changeGiven` stay null when
 * omitted (omitted means equal to the sale number / no change).
 */
function receiptColumns(receipt: CaptureSaleReceiptDto | undefined): ReadonlyArray<string | null> {
  if (receipt === undefined) return Array.from({ length: 9 }, () => null);
  return [
    receipt.saleNumber,
    receipt.receiptNumber ?? null,
    receipt.terminalLabel,
    receipt.operatorDisplayName,
    receipt.settledAt,
    receipt.branchName,
    receipt.branchAddress,
    receipt.taxRegistrationId,
    receipt.changeGiven ?? null,
  ];
}

/**
 * Write the `sales` header; returns false when the provenance already exists.
 *
 * Atomic dedup (FR-050/100): ON CONFLICT on the (tenant_id, source_system,
 * external_id) unique index makes the write race-safe — a concurrent or
 * re-delivered identical capture does NOT double-insert or surface a 500; it
 * falls through to `resolveReplay` (zero rows returned ⇒ the row already
 * exists).
 *
 * 032 §7: `sync_status` is set to 'captured' IN the capture transaction
 * (server-authoritative; POS never supplies it). The column also DEFAULTs to
 * 'captured' in 0026, but it is bound explicitly here so the capture write is
 * self-documenting and does not silently depend on the default. The
 * off-request drain advances it to 'synced' (see SaleProcessingProcessor).
 * processed_at stays NULL — the worker claims it.
 *
 * RT-539: the receipt snapshot columns ($17-$25) are written with the row; ON
 * CONFLICT DO NOTHING keeps a replay from rewriting them.
 */
export async function insertSaleHeader(
  client: PoolClient,
  input: CaptureSaleInput,
  header: {
    readonly saleId: string;
    readonly payloadHash: string;
    readonly mismatchFlag: boolean;
    readonly storeTimezone: string;
    readonly trackingStatus: "tracked" | "tracking_unresolved" | null;
  },
): Promise<boolean> {
  const { body } = input;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_clock_at, source_system, external_id,
        payload_hash, mismatch_flag, created_by, sync_status,
        device_id, tender_count, responsibility_count,
        receipt_sale_number, receipt_number, receipt_terminal_label,
        receipt_operator_display_name, receipt_settled_at, receipt_branch_name,
        receipt_branch_address, receipt_tax_registration_id, receipt_change_given,
        safety_revision, safety_synced_at, tracking_status)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::timestamptz,
             ($6::timestamptz AT TIME ZONE $13)::date, $7::timestamptz,
             $8, $9, $10, $11, $12, $14, $15, $16, $26,
             $17, $18, $19, $20, $21::timestamptz, $22, $23, $24, $25::numeric,
             $27::bigint, $28::timestamptz, $29)
     ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
     RETURNING id`,
    [
      header.saleId,
      input.tenantId,
      input.storeId,
      body.currencyCode,
      body.posTotal,
      body.occurredAt,
      body.sourceClockAt ?? null,
      body.sourceSystem,
      body.externalId,
      header.payloadHash,
      header.mismatchFlag,
      input.actorUserId,
      header.storeTimezone,
      SALE_SYNC_STATUS.CAPTURED,
      input.deviceId,
      (body.tenders ?? []).length,
      ...receiptColumns(input.receipt),
      (body.responsibilities ?? []).length,
      input.safety?.safetyRevision ?? null,
      input.safety?.safetySyncedAt ?? null,
      header.trackingStatus,
    ],
  );
  return inserted.rows.length > 0;
}

/**
 * Write the frozen line snapshot in the capture transaction. RT-539
 * (sales.yaml 1.9.0): each line's 1-based position in lines[] is stored as its
 * receipt sequence (line_seq).
 */
export async function insertSaleLines(
  client: PoolClient,
  sale: {
    readonly saleId: string;
    readonly tenantId: string;
    readonly storeId: string;
    readonly lines: CaptureSaleRequestDto["lines"];
    /** RT-451 S3: each line's G7-9 class (null when not classified), in line order. */
    readonly classes: ReadonlyArray<LineClassification>;
  },
): Promise<string[]> {
  const ids: string[] = [];
  // sequential: sale lines are inserted on the capture transaction; pg runs one PoolClient's queries one at a time.
  for (const [index, line] of sale.lines.entries()) {
    const id = newId();
    ids.push(id);
    const c = sale.classes[index] ?? { trackingClass: null };
    const t = line.tracking;
    await client.query(
      `INSERT INTO sale_lines
         (id, sale_id, tenant_id, store_id, line_name, unit_price,
          currency_code, quantity, line_amount, tax_amount, unit,
          tenant_product_ref, line_seq,
          tracking_identity_id, tracking_code, tracking_expiry_date, tracking_selection,
          tracking_validation_id, tracking_class, tracking_unresolved_reason)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8::numeric,
               $9::numeric, $10, $11, $12, $13,
               $14, $15, $16::date, $17, $18, $19, $20)`,
      [
        id,
        sale.saleId,
        sale.tenantId,
        sale.storeId,
        line.lineName,
        line.unitPrice,
        line.currencyCode,
        line.quantity,
        line.lineAmount,
        line.taxAmount ?? null,
        line.unit,
        line.tenantProductRef ?? null,
        index + 1,
        t?.identityId ?? null,
        t?.code ?? null,
        t?.expiryDate ?? null,
        t?.selection ?? null,
        t?.validationId ?? null,
        c.trackingClass,
        c.trackingClass === "unresolved" ? c.reason : null,
      ],
    );
  }
  return ids;
}
