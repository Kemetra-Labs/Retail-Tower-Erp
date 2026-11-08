/**
 * Tracked Line Validation record — Drizzle schema (0087, Jira RT-451 slice S2;
 * contract `pos-sales/tracked-lines.yaml` `posValidateTrackedLine`, "THE
 * VALIDATION RECORD"; owner approval RT-451 comment 16216).
 *
 * `tracked_line_validations`: one row per TLV call, accepted or refused, the
 * server-side audit of what the till was told. Its `id` is the contract's
 * `validationId`; a sale line cites it (RT-451 S3), and a refused row's id is
 * never valid on a sale line. Tenant, store and device come from the
 * credential only.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT tenant policies only (append-only). The
 * same-tenant composite FKs (store, the store's device, the product) and the
 * policies are defined in 0087's SQL. §XIV: BUSINESS-CLASS — opaque ids, an
 * operator UUID, a lot code, dates, a quantity, enumerated codes, a till-local
 * draft line reference, a revision counter, a timestamp. No PII, no money.
 */
import { sql } from "drizzle-orm";
import { bigint, check, date, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const TRACKED_LINE_SELECTIONS = ["scanned", "fefo_suggested", "operator_selected"] as const;
export type TrackedLineSelection = (typeof TRACKED_LINE_SELECTIONS)[number];

/** The contract's closed refusal set, in the TLV's check order. */
export const TRACKED_LINE_REFUSAL_REASONS = [
  "not_sellable",
  "profile_mismatch",
  "unknown_identity",
  "wrong_product",
  "recalled",
  "held",
  "expired",
] as const;
export type TrackedLineRefusalReason = (typeof TRACKED_LINE_REFUSAL_REASONS)[number];

export const trackedLineValidations = pgTable(
  "tracked_line_validations",
  {
    // The contract's `validationId`.
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Composite FKs (tenant_id, store_id) -> stores, (device_id, tenant_id,
    // store_id) -> devices and (tenant_product_ref, tenant_id) ->
    // tenant_products are SQL-only in 0087.
    deviceId: uuid("device_id").notNull(),
    storeId: uuid("store_id").notNull(),
    operatorUserId: uuid("operator_user_id").notNull(),
    authPath: text("auth_path").notNull(),
    tenantProductRef: uuid("tenant_product_ref").notNull(),
    requestedIdentityId: uuid("requested_identity_id"),
    requestedCode: text("requested_code"),
    scannedExpiryDate: date("scanned_expiry_date"),
    resolvedIdentityId: uuid("resolved_identity_id"),
    suggestedIdentityId: uuid("suggested_identity_id"),
    selection: text("selection").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    draftLineRef: text("draft_line_ref").notNull(),
    outcome: text("outcome").notNull(),
    refusalReason: text("refusal_reason"),
    safetyRevision: bigint("safety_revision", { mode: "number" }).notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("tracked_line_validations_auth_path_allowed", sql`${t.authPath} IN ('envelope', 'device')`),
    check(
      "tracked_line_validations_requested_identity_one",
      sql`(${t.requestedIdentityId} IS NULL) <> (${t.requestedCode} IS NULL)`,
    ),
    check(
      "tracked_line_validations_scanned_expiry_with_code",
      sql`${t.scannedExpiryDate} IS NULL OR ${t.requestedCode} IS NOT NULL`,
    ),
    check(
      "tracked_line_validations_selection_allowed",
      sql`${t.selection} IN ('scanned', 'fefo_suggested', 'operator_selected')`,
    ),
    check(
      "tracked_line_validations_requested_code_shape",
      sql`${t.requestedCode} IS NULL OR char_length(${t.requestedCode}) BETWEEN 1 AND 128`,
    ),
    check(
      "tracked_line_validations_scanned_expiry_in_range",
      sql`${t.scannedExpiryDate} IS NULL OR ${t.scannedExpiryDate} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'`,
    ),
    check("tracked_line_validations_quantity_positive", sql`${t.quantity} > 0`),
    check(
      "tracked_line_validations_draft_line_ref_length",
      sql`char_length(${t.draftLineRef}) BETWEEN 1 AND 100`,
    ),
    check("tracked_line_validations_outcome_allowed", sql`${t.outcome} IN ('accepted', 'refused')`),
    check(
      "tracked_line_validations_refusal_reason",
      sql`(${t.outcome} = 'refused') = (${t.refusalReason} IS NOT NULL)`,
    ),
    check(
      "tracked_line_validations_refusal_reason_allowed",
      sql`${t.refusalReason} IS NULL OR ${t.refusalReason} IN ('not_sellable', 'profile_mismatch', 'unknown_identity', 'wrong_product', 'recalled', 'held', 'expired')`,
    ),
    check(
      "tracked_line_validations_accepted_resolved",
      sql`${t.outcome} <> 'accepted' OR ${t.resolvedIdentityId} IS NOT NULL`,
    ),
    check("tracked_line_validations_safety_revision_non_negative", sql`${t.safetyRevision} >= 0`),
    index("idx_tracked_line_validations_tenant_device_validated").on(t.tenantId, t.deviceId, t.validatedAt),
  ],
);

export type TrackedLineValidationRow = typeof trackedLineValidations.$inferSelect;
