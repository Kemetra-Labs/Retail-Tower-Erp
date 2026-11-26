/**
 * `sale_lines` — per-line snapshot of a captured sale. (data-model.md §2)
 *
 * One row per sold line; child of `sales`. Snapshot frozen at capture
 * (FR-002/003): `line_name` / `unit_price` / `tax_amount` / `unit` are the
 * values as charged and MUST NOT change when the referenced tenant product /
 * override / price history later changes. `tenant_product_ref` is lineage
 * only (nullable — ad-hoc lines have none, FR-004; no tenant product is
 * auto-created from a line).
 *
 * Key invariants:
 *   - Money: `unit_price` / `line_amount` are `numeric(19,4)` NOT NULL;
 *     `tax_amount` is `numeric(19,4)` nullable (single per-line snapshot tax,
 *     gate A.2 — the SaaS does not recompute tax). All non-negative.
 *   - `quantity` is `numeric(19,6)` (sub-unit quantities allowed), non-negative.
 *   - `currency_code` `char(3)` matches the parent sale currency.
 *   - Lines inherit the parent's `occurred_at` / `business_date` (gate B —
 *     no own time columns).
 *   - RLS-enabled + FORCE, fail-closed by `tenant_id`. Policy in `0012_sales.sql`.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "./sales";

export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").primaryKey().notNull(),
    // FK is composite (sale_id, tenant_id, store_id) — declared in the table
    // extra-config below so a line can only attach to a same-tenant/store sale.
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // Frozen snapshot fields (FR-003).
    lineName: text("line_name").notNull(),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    lineAmount: numeric("line_amount", { precision: 19, scale: 4 }).notNull(),
    // Single per-line snapshot tax (gate A.2); nullable when not reported.
    taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }),
    unit: text("unit").notNull(),
    // Optional lineage only (FR-003); NULL for ad-hoc lines (FR-004).
    tenantProductRef: uuid("tenant_product_ref"),
    // RT-538 (0047): the line's original receipt position (1-based); NULL for
    // lines captured before RT-539 stores it.
    lineSeq: integer("line_seq"),
    // RT-451 S3 (0089): the frozen tracking snapshot as the till sent it
    // (`CaptureSaleLineTracking`; no FK: an unknown identity is classified),
    // and the line's G7-9 class while tracked selling was on.
    trackingIdentityId: uuid("tracking_identity_id"),
    trackingCode: text("tracking_code"),
    trackingExpiryDate: date("tracking_expiry_date"),
    trackingSelection: text("tracking_selection"),
    trackingValidationId: uuid("tracking_validation_id"),
    /** 'valid' (row 1) | 'flagged' (rows 2-3) | 'unresolved' (row 4); NULL when not classified (tracking sent while off is provenance only). */
    trackingClass: text("tracking_class"),
    /** Row 4 only: tracking_missing | identity_unknown | identity_other_product. */
    trackingUnresolvedReason: text("tracking_unresolved_reason"),
    // RT-1565 (0133, RT-285 F-1): the line's seller, frozen at capture with the store and role it held then
    // (Policy §8). All NULL (no seller; every earlier sale) or all set. FKs to users / stores / roles are
    // declared in SQL (NOT VALID).
    sellerUserId: uuid("seller_user_id"),
    sellerStoreId: uuid("seller_store_id"),
    sellerRoleId: uuid("seller_role_id"),
    // RT-1571 (0134, RT-285 F-7): the line's one manual discount (`CaptureSaleLineDiscount`, RT-740), kept as
    // sent: kind, value, amount, reason code, authority source and approver role all NULL (no manual discount;
    // every line captured before 0134 reads "not recorded") or all set; the approver's user id is an optional,
    // unverified till claim (no FK).
    discountKind: text("discount_kind"),
    discountValue: numeric("discount_value", { precision: 19, scale: 4 }),
    discountAmount: numeric("discount_amount", { precision: 19, scale: 4 }),
    discountReasonCode: text("discount_reason_code"),
    discountAuthoritySource: text("discount_authority_source"),
    discountApproverRole: text("discount_approver_role"),
    discountApproverUserId: uuid("discount_approver_user_id"),
  },
  (t) => [
    check(
      "sale_lines_currency_code_format",
      sql`${t.currencyCode} ~ '^[A-Z]{3}$'`,
    ),
    check("sale_lines_unit_price_non_negative", sql`${t.unitPrice} >= 0`),
    check("sale_lines_line_amount_non_negative", sql`${t.lineAmount} >= 0`),
    check("sale_lines_quantity_non_negative", sql`${t.quantity} >= 0`),
    check(
      "sale_lines_tax_amount_non_negative",
      sql`${t.taxAmount} IS NULL OR ${t.taxAmount} >= 0`,
    ),
    check("sale_lines_line_seq_positive", sql`${t.lineSeq} IS NULL OR ${t.lineSeq} >= 1`),
    // RT-451 S3 (0089, NOT VALID): the snapshot is whole or absent, and only
    // a row-4 line carries a reason.
    check(
      "sale_lines_tracking_snapshot_whole",
      sql`(${t.trackingIdentityId} IS NULL) = (${t.trackingCode} IS NULL) AND (${t.trackingIdentityId} IS NULL) = (${t.trackingSelection} IS NULL) AND (${t.trackingIdentityId} IS NOT NULL OR (${t.trackingExpiryDate} IS NULL AND ${t.trackingValidationId} IS NULL))`,
    ),
    check(
      "sale_lines_tracking_code_shape",
      sql`${t.trackingCode} IS NULL OR char_length(${t.trackingCode}) BETWEEN 1 AND 128`,
    ),
    check(
      "sale_lines_tracking_expiry_in_range",
      sql`${t.trackingExpiryDate} IS NULL OR ${t.trackingExpiryDate} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'`,
    ),
    check(
      "sale_lines_tracking_selection_allowed",
      sql`${t.trackingSelection} IS NULL OR ${t.trackingSelection} IN ('scanned', 'fefo_suggested', 'operator_selected')`,
    ),
    check(
      "sale_lines_tracking_class_allowed",
      sql`${t.trackingClass} IS NULL OR ${t.trackingClass} IN ('valid', 'flagged', 'unresolved')`,
    ),
    check(
      "sale_lines_tracking_unresolved_reason_allowed",
      sql`${t.trackingUnresolvedReason} IS NULL OR ${t.trackingUnresolvedReason} IN ('tracking_missing', 'identity_unknown', 'identity_other_product')`,
    ),
    check(
      "sale_lines_tracking_unresolved_reason_iff",
      sql`(${t.trackingUnresolvedReason} IS NOT NULL) = (${t.trackingClass} IS NOT DISTINCT FROM 'unresolved')`,
    ),
    check(
      "sale_lines_tracking_missing_has_no_snapshot",
      sql`(${t.trackingUnresolvedReason} IS NOT DISTINCT FROM 'tracking_missing') = (${t.trackingClass} IS NOT NULL AND ${t.trackingIdentityId} IS NULL)`,
    ),
    // RT-1565 (0133, NOT VALID): the seller snapshot is whole or absent.
    check(
      "sale_lines_seller_snapshot_whole",
      sql`(${t.sellerUserId} IS NULL) = (${t.sellerStoreId} IS NULL) AND (${t.sellerUserId} IS NULL) = (${t.sellerRoleId} IS NULL)`,
    ),
    // RT-1571 (0134, NOT VALID): the manual discount is whole or absent, in the contract's vocabularies, and
    // its magnitude follows its kind.
    check(
      "sale_lines_discount_whole",
      sql`(${t.discountKind} IS NULL) = (${t.discountValue} IS NULL) AND (${t.discountKind} IS NULL) = (${t.discountAmount} IS NULL) AND (${t.discountKind} IS NULL) = (${t.discountReasonCode} IS NULL) AND (${t.discountKind} IS NULL) = (${t.discountAuthoritySource} IS NULL) AND (${t.discountKind} IS NULL) = (${t.discountApproverRole} IS NULL) AND (${t.discountApproverUserId} IS NULL OR ${t.discountKind} IS NOT NULL)`,
    ),
    check(
      "sale_lines_discount_vocabulary",
      sql`${t.discountKind} IS NULL OR (${t.discountKind} IN ('percent', 'amount') AND ${t.discountReasonCode} IN ('promotion', 'loyal_or_contract_customer', 'near_expiry_or_damaged', 'price_correction') AND ${t.discountAuthoritySource} IN ('cashier_approval', 'manager_session') AND ${t.discountApproverRole} IN ('manager', 'admin'))`,
    ),
    check(
      "sale_lines_discount_magnitude",
      sql`${t.discountKind} IS NULL OR (${t.discountValue} <> 'NaN'::numeric AND ${t.discountAmount} <> 'NaN'::numeric AND ${t.discountValue} > 0 AND ${t.discountAmount} >= 0 AND (${t.discountKind} <> 'percent' OR (${t.discountValue} = trunc(${t.discountValue}) AND ${t.discountValue} <= 100)) AND (${t.discountKind} <> 'amount' OR ${t.discountValue} = ${t.discountAmount}))`,
    ),
    index("idx_sale_lines_sale").on(t.saleId),
    index("idx_sale_lines_tenant_store").on(t.tenantId, t.storeId),
    // RT-459 (0082, built CONCURRENTLY): the Tracking Profile lock probe
    // (EXISTS ... WHERE tenant_product_ref = $1; RLS supplies tenant_id).
    index("idx_sale_lines_tenant_product")
      .on(t.tenantId, t.tenantProductRef)
      .where(sql`${t.tenantProductRef} IS NOT NULL`),
    // Composite FK → sales(id, tenant_id, store_id): a line can only attach to
    // a sale in the SAME tenant + store (cross-tenant linkage impossible).
    foreignKey({
      name: "fk_sale_lines_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export type SaleLineRow = typeof saleLines.$inferSelect;
export type NewSaleLineRow = typeof saleLines.$inferInsert;
