/**
 * T033 — 008 Slice 1b shared receipt-payload types.
 *
 * The `ReceiptPayload` shape consumed by the template engine (T160 in
 * Slice 2) and projected over the bridge by `receipts.preview` (Slice 2
 * onward). Mirrors `specs/008-sale-finalization-and-receipts/spec.md
 * §FR-017` (canonical receipt fields) and `data-model.md §"Entity: Sale"`
 * (the persisted source from which the payload is derived).
 *
 * **Byte-stability commitment (AD-6).** The payload is the SINGLE source
 * for both the ESC/POS byte stream and the HTML/canvas preview render.
 * Adding a preview-only branch in any consumer is forbidden — the
 * template engine reads this struct and emits BOTH outputs from one
 * composition pass.
 *
 * **Sensitive-data exclusion.** This module declares ONLY the
 * non-sensitive fields. PAN, voucher codes, voucher PII, PIN record ids,
 * issuer names are forbidden per FR-070 / FR-071 / CR3 / Constitution
 * §P6 / §P7.
 */

import type { SaleId, SaleNumber, SalesRefusalReason, TenderLineSummary } from '../sales/types.js';
import type { ReceiptLineDiscount } from '../sales/sale-line-discount.js';

// ── Template variant (closed-set) ────────────────────────────────────────────

/**
 * The 3 template variants in 008 v1. Per spec §FR-017 + the §A1 sign-off
 * sub-items in `specs/008-sale-finalization-and-receipts/visual-direction/README.md`:
 *
 *   • `first_print`       — the original receipt; no duplicate-copy marker.
 *   • `reprint_duplicate` — carries the bilingual duplicate-copy marker
 *                           (FR-029) + the duplicate-copy sequence number
 *                           (FR-031) + the reprint timestamp.
 *   • `preview`           — byte-equal to (a) `first_print` content (or to
 *                           (b) `reprint_duplicate` content if the sale has
 *                           ≥ 1 successful print event); rendered to the
 *                           canvas in the `<ReceiptPreview>` UI panel.
 */
export const RECEIPT_TEMPLATE_VARIANTS = ['first_print', 'reprint_duplicate', 'preview'] as const;
export type ReceiptTemplateVariant = (typeof RECEIPT_TEMPLATE_VARIANTS)[number];

// ── Receipt line item (the itemised slip body; FR-017) ───────────────────────

/**
 * One item line on the printed slip body, derived from the Sale row's
 * `lines_json` snapshot (the frozen `LineSnapshot[]` captured at finalize per
 * T028a). Carries ONLY the non-sensitive display fields the §(a) layout
 * renders.
 *
 * **v1 single-name note (Ahmed 2026-05-28):** the durable cart snapshot carries
 * a single `display_name` per line — there is no `name_ar`/`name_en` split in
 * 005's cart schema (catalogue integration is a stub). So v1 renders one name
 * line per item; the bilingual two-name composition in the §(a) layout
 * (decision 8) is a v2 item pending catalogue integration. See
 * slice2-mapping-pass.md.
 */
export interface ReceiptLineItem {
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  /** The line GROSS (`quantity × unit_price_minor`). */
  line_subtotal_minor: number;
  note: string | null;
  /**
   * RT-856 (OD-28-11): the line's manual discount, from the frozen
   * `lines_json`. Only kind, value and amount: no placeholder, reason or
   * approver reaches the slip or the preview bridge. Absent when undiscounted.
   */
  discount?: ReceiptLineDiscount;
  /**
   * RT-1339: the automatic offer this line took part in, from the frozen `lines_json`
   * (the name and percent are kept there, so a reprint never reads the Pack). Only a
   * reward line (`discount_minor` above 0) prints the offer copy under it.
   */
  promotion?: ReceiptLinePromotion;
}

/** The offer fields a receipt may show: no offer or Pack id reaches the slip or the preview bridge. */
export interface ReceiptLinePromotion {
  offer_name_ar: string;
  percent_off: number;
  /** The discount on this (quantity-1) line, in minor units; 0 on a participating line. */
  discount_minor: number;
}

// ── ReceiptPayload (FR-017 canonical fields) ─────────────────────────────────

/**
 * The canonical receipt payload struct. The template engine (T160) takes
 * this as input and emits both ESC/POS bytes and HTML/canvas raster.
 *
 * Fields are sourced from the persisted Sale row (per `data-model.md
 * §"Entity: Sale"`) + the latest PrintEvent / DrawerEvent projections
 * for variants that reference them.
 *
 * Per spec §"Sensitive-data minimisation": NO voucher code, NO PAN, NO
 * PII beyond `selling_operator_display_name`, NO main-only fields
 * (envelope_handoff_action_id, payment_attempt_id, envelope_cart_id).
 */
export interface ReceiptPayload {
  // ── Variant + reprint-only fields ───────────────────────────────────────
  variant: ReceiptTemplateVariant;
  /**
   * 1 for the first reprint of a sale, 2 for the second, etc. Required
   * when `variant === 'reprint_duplicate'`. NULL/undefined otherwise.
   */
  duplicate_copy_sequence_number?: number;
  /**
   * ISO-8601 UTC timestamp of the reprint event. Required when
   * `variant === 'reprint_duplicate'`. NULL/undefined otherwise.
   */
  reprinted_at?: string;

  // ── Identity ────────────────────────────────────────────────────────────
  sale_id: SaleId;
  sale_number: SaleNumber;
  receipt_number: string;

  // ── Pharmacy / tenant header (cached from terminal config; FR-017) ─────
  tenant_tax_registration_id: string;
  branch_name: string;
  branch_address: string;
  terminal_label: string;

  // ── Operator attribution (FR-013 / FR-014 / FR-024) ────────────────────
  selling_operator_display_name: string;

  // ── Monetary totals (INTEGER minor units; Constitution §II) ────────────
  /** The Sale's `subtotal_minor`: the NET charged before tax since RT-854 / RT-856. */
  subtotal_minor: number;
  total_tax_minor: number;
  total_change_due_minor: number;

  // ── Itemised body (FR-017; derived from the Sale row's lines_json) ──────
  lines: readonly ReceiptLineItem[];

  // ── Tender breakdown (non-sensitive only; FR-017) ──────────────────────
  tender_lines_summary: TenderLineSummary[];

  // ── Timestamps (FR-017 + Constitution Localization) ────────────────────
  settled_at: string;
  finalized_at: string;
  local_calendar_day: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 008-sale-finalization-and-receipts Slice 2: `receipts.*` namespace (mutating)
// ────────────────────────────────────────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"Namespace: receipts.* (mutating)" → "receipts.preview"
//
// Slice 2 lands `receipts.preview` ONLY. It is the one read-shaped member of
// the mutating namespace — it renders the AD-6 engine's HTML for a sale and
// has NO side effects (no print command, no drawer kick, no Sale mutation).
// The genuinely-mutating handlers (reprint / retryPrint / manualOverride) land
// in Slices 3 / 5 / 6. Every handler is gated server-side by
// `requireOperatorSession`; preview reuses the `SalesRefusalReason` vocabulary
// (no_session / sale_not_found / forbidden_field_in_request).

// ── receipts.preview ──────────────────────────────────────────────────────────

export interface ReceiptsPreviewRequest {
  sale_id: SaleId;
  /**
   * Present for symmetry with the mutating `receipts.*` handlers; preview is
   * effectively idempotent (no side effects), so it is not used to dedupe.
   */
  idempotency_key: string;
}

export interface ReceiptPreviewPayload {
  /** The AD-6 engine's HTML output. The renderer mounts this directly. */
  html: string;
  /** ESC/POS column width the printed slip uses (80 mm Font A → 42 in v1). */
  width_chars: number;
  /** Locale/direction hint so the preview pane mirrors the printed slip. */
  bilingual_locale: 'ar-EG-RTL-with-latin-en';
}

export type ReceiptsPreviewResponse =
  | { kind: 'ok'; preview: ReceiptPreviewPayload }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── receipts.retryPrint (008 Slice 3) ────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"receipts.retryPrint"
//
// THREE-way response. A successful retry is the canonical first print
// (FR-052): no duplicate-copy marker. A still-failed retry returns kind:'ok'
// with outcome:'failure' (NOT kind:'refused') because the retry attempt itself
// was accepted — it ran and got a failure ack back; the banner stays loud.

export interface ReceiptsRetryPrintRequest {
  sale_id: SaleId;
  idempotency_key: string;
}

export type ReceiptsRetryPrintResponse =
  // success
  | {
      kind: 'ok';
      outcome: 'success';
      print_event_id: string;
      purpose: 'retry_after_failure';
      render_path: 'escpos_direct' | 'os_print';
      printed_at: string;
    }
  // still-failed (attempt accepted, print failed)
  | {
      kind: 'ok';
      outcome: 'failure';
      print_event_id: string;
      purpose: 'retry_after_failure';
      failure_reason:
        | 'printer_offline'
        | 'printer_out_of_paper'
        | 'printer_jam'
        | 'os_print_error'
        | 'escpos_write_failure'
        | 'escpos_status_unknown';
    }
  // refused (attempt NOT accepted — gate/isolation/not-found)
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── receipts.reprint (008 Slice 5) ────────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"receipts.reprint"
//
// TWO-way response (success | refused) — NOT three-way like retryPrint. A
// reprint is repeatable by design (the n-th reprint gets
// duplicate_copy_sequence_number=n), so a print FAILURE refuses with
// `printer_unavailable` rather than returning an ok+failure outcome. RT-546
// (OD-534-2, supersedes AD-10's "any operator"): a cashier reprints only their
// own sale; a manager or admin any sale in scope; another cashier's sale
// refuses as `sale_not_found`. It renders the `reprint_duplicate` template variant (bilingual
// duplicate-copy marker) and NEVER kicks the drawer (FR-030).

export interface ReceiptsReprintRequest {
  sale_id: SaleId;
  idempotency_key: string;
}

export type ReceiptsReprintResponse =
  // success
  | {
      kind: 'ok';
      print_event_id: string;
      duplicate_copy_sequence_number: number;
      reprinted_at: string;
      render_path: 'escpos_direct' | 'os_print';
    }
  // refused (gate / isolation / precondition / printer-down)
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── receipts.manualOverride (008 Slice 6) ─────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"receipts.manualOverride"
//
// Cashier invokes manual-receipt override after a print failure (from the
// printer-failure banner). The handler records that a receipt was handled
// out-of-band: it INSERTs a print_events row with purpose='first_print',
// outcome='manual_override', render_path=NULL — NO slip is rendered or printed.
// Two-way response (success | refused). Idempotent per-sale (Path A, key-on-
// state): a sale that already has a manual_override is a no-op returning the
// original row. The drawer is NEVER kicked (no print succeeded).

export interface ReceiptsManualOverrideRequest {
  sale_id: SaleId;
  idempotency_key: string;
}

export type ReceiptsManualOverrideResponse =
  // success
  | {
      kind: 'ok';
      print_event_id: string;
      purpose: 'first_print';
      outcome: 'manual_override';
      overridden_at: string;
    }
  // refused (gate / isolation / not-found)
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── ReceiptsBridgeAPI surface ───────────────────────────────────────────────

/**
 * 008 mutating-namespace bridge surface. S2 landed `preview`; S3 adds
 * `retryPrint`; S5 adds `reprint`; S6 adds `manualOverride`. Gated server-side
 * by `requireOperatorSession`; tenant/branch/terminal scoping is derived from
 * the operator session per the §A4 checklist.
 */
export interface ReceiptsBridgeAPI {
  /** Render the read-only HTML preview of a sale's receipt. No side effects. */
  preview(req: ReceiptsPreviewRequest): Promise<ReceiptsPreviewResponse>;
  /** Retry a failed print. Three-way response (success / still-failed / refused). */
  retryPrint(req: ReceiptsRetryPrintRequest): Promise<ReceiptsRetryPrintResponse>;
  /** Reprint a previously-printed sale (duplicate copy). Two-way response. */
  reprint(req: ReceiptsReprintRequest): Promise<ReceiptsReprintResponse>;
  /** Record a manual-receipt override after a print failure. Two-way response. */
  manualOverride(req: ReceiptsManualOverrideRequest): Promise<ReceiptsManualOverrideResponse>;
}
