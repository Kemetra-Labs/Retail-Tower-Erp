/**
 * `sale_quarantine_items` — the POS sale quarantine store (0093, Jira RT-1312
 * Phase 3(b); owner decision D1; contracts `pos-sales/sale-quarantine.yaml`
 * 1.0.0-draft and `sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft).
 *
 * One row per sale the till could not get captured (refused for good by
 * `captureSale`, or held after a re-pair) and uploaded for a Console repair.
 * `id` IS the contract's `quarantineRef` (UUIDv7 from the runtime).
 * (tenant_id, source_system, external_id) is UNIQUE: the upload's natural key.
 * The state machine (open -> captured | already-captured | written-off), the
 * till's reason rules, the body purge and the repair columns are CHECKs in
 * 0093's SQL, which is the source of truth (the CHECKs are not repeated here).
 *
 * Composite FKs (SQL-only in 0093, as 0089 does) pin the store, the uploading
 * device, the earlier pairing's device and the captured sale to the row's
 * tenant AND store.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT + UPDATE tenant policies, no DELETE.
 * §XIV: BUSINESS-CLASS with monetary and possibly personal data inside
 * `sale_body` (decision P3 retention). The policies are defined in 0093's SQL.
 */
import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const saleQuarantineItems = pgTable(
  "sale_quarantine_items",
  {
    // The contract's `quarantineRef`.
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    // The item's store and the uploading device; with previous_terminal_id and
    // sale_id, pinned to the row's tenant and store by composite FKs that are
    // SQL-only in 0093 (the 0089 precedent).
    storeId: uuid("store_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // The earlier pairing's device (usually revoked; a historical fact).
    previousTerminalId: uuid("previous_terminal_id"),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    // The till's capture key: audit only, never replayed.
    idempotencyKey: text("idempotency_key").notNull(),
    reasonKind: text("reason_kind").notNull(),
    tillHttpStatus: integer("till_http_status"),
    tillErrorCode: text("till_error_code"),
    tillRecordedAt: timestamp("till_recorded_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // The capture body, verbatim; NULL once purged (body_purged_at set).
    saleBody: jsonb("sale_body"),
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    // sha256 hex of the sale facts (RT-1206), so a repeat upload compares after a purge.
    factsDigest: text("facts_digest").notNull(),
    summaryOccurredAt: timestamp("summary_occurred_at", { withTimezone: true }),
    summaryPosTotal: text("summary_pos_total"),
    summaryCurrencyCode: text("summary_currency_code"),
    summaryLineCount: integer("summary_line_count"),
    state: text("state").default("open").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    repairCount: integer("repair_count").default(0).notNull(),
    lastRepairAt: timestamp("last_repair_at", { withTimezone: true }),
    lastRepairOutcome: text("last_repair_outcome"),
    lastRepairHttpStatus: integer("last_repair_http_status"),
    lastRepairErrorCode: text("last_repair_error_code"),
    uploadConflictCount: integer("upload_conflict_count").default(0).notNull(),
    saleId: uuid("sale_id"),
    writeOffNote: text("write_off_note"),
  },
  (t) => [
    unique("sale_quarantine_items_tenant_id_uk").on(t.tenantId, t.id),
    unique("sale_quarantine_items_tenant_provenance_uk").on(t.tenantId, t.sourceSystem, t.externalId),
    index("idx_sale_quarantine_items_tenant_state_id").on(t.tenantId, t.state, t.id.desc()),
  ],
);

export type SaleQuarantineItemRow = typeof saleQuarantineItems.$inferSelect;
export type NewSaleQuarantineItemRow = typeof saleQuarantineItems.$inferInsert;
