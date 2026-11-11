/**
 * `vouchers` — issued vouchers (0091, Jira RT-1107, slice I-2 of RT-1098; plan
 * `docs/planning/rt-922-voucher-issuance.md` section 5.4; contract
 * `vouchers-admin.openapi.yaml`).
 *
 * One row per voucher. The code is never stored, only `code_hash` (plan 5.3),
 * unique per tenant. `status` is `active | redeemed | cancelled`; expiry is
 * derived at read time from `expires_at` (NULL = never expires) and never
 * written back. `batch_id` groups one issue call (no batch table, no FK).
 * `(tenant_id, id)` is unique so `voucher_eligible_stores` can pin its FK to
 * the same tenant.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT + UPDATE tenant policies, no DELETE.
 * §XIV: BUSINESS-CLASS — opaque ids, a code hash, an amount in minor units and
 * a currency code, an enumerated status, timestamps, two actor user ids and a
 * bounded internal note. No PII. The tenant FK, the CHECKs, the unique
 * constraints and the policies are defined in 0091's SQL.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, customType, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const VOUCHER_STATUSES = ["active", "redeemed", "cancelled"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id").notNull(),
    codeHash: bytea("code_hash").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    appliesToAllStores: boolean("applies_to_all_stores").notNull(),
    issuedByUserId: uuid("issued_by_user_id").notNull(),
    cancelledByUserId: uuid("cancelled_by_user_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    note: text("note"),
  },
  (t) => [
    unique("vouchers_tenant_id_uk").on(t.tenantId, t.id),
    unique("vouchers_tenant_code_hash_uk").on(t.tenantId, t.codeHash),
    check("vouchers_amount_minor_positive", sql`${t.amountMinor} > 0`),
    check("vouchers_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("vouchers_status_allowed", sql`${t.status} IN ('active', 'redeemed', 'cancelled')`),
    check(
      "vouchers_cancelled_columns",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL) AND (${t.status} = 'cancelled') = (${t.cancelledByUserId} IS NOT NULL)`,
    ),
    check("vouchers_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) <= 200`),
    index("idx_vouchers_tenant_batch").on(t.tenantId, t.batchId),
    index("idx_vouchers_tenant_created").on(t.tenantId, t.createdAt, t.id),
  ],
);

export type VoucherRow = typeof vouchers.$inferSelect;
export type NewVoucherRow = typeof vouchers.$inferInsert;
