/**
 * `voucher_redemption_intents` — one row per voucher validate (0092, Jira
 * RT-1111, slice R-2 of RT-1098; contract `pos-payments/vouchers.yaml`).
 *
 * Validate issues the short-lived `redemption_intent_token`; only its hash is
 * stored (`token_hash`, unique per tenant). The row binds the token to
 * (tenant, store, voucher, `payment_attempt_id`, applied and forfeited
 * amounts) and to the cashier and terminal that validated. `expires_at` is at
 * most 5 minutes after `created_at` (CHECK in 0092). Redeem sets `consumed_at`
 * once. Composite FKs (see `redemption-columns.ts` and 0092's SQL) pin the
 * voucher, the store and the device (id, tenant, store) to the row's tenant.
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT + UPDATE tenant policies, no DELETE.
 * §XIV: BUSINESS-CLASS with a monetary attribute — opaque ids, a token hash,
 * amounts in minor units, timestamps, operator user id and device id (actors
 * and equipment, not customer PII). The policies are defined in 0092's SQL.
 */
import { sql } from "drizzle-orm";
import { check, customType, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { amountChecks, redemptionFactColumns, redemptionSharedColumns, scopeForeignKeys } from "./redemption-columns";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const voucherRedemptionIntents = pgTable(
  "voucher_redemption_intents",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    ...redemptionSharedColumns(),
    ...redemptionFactColumns(),
    tokenHash: bytea("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("voucher_redemption_intents_tenant_id_uk").on(t.tenantId, t.id),
    unique("voucher_redemption_intents_tenant_token_hash_uk").on(t.tenantId, t.tokenHash),
    ...amountChecks("voucher_redemption_intents", t),
    check("voucher_redemption_intents_ttl", sql`${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`),
    index("idx_voucher_redemption_intents_tenant_voucher").on(t.tenantId, t.voucherId),
    ...scopeForeignKeys("voucher_redemption_intents", t),
  ],
);

export type VoucherRedemptionIntentRow = typeof voucherRedemptionIntents.$inferSelect;
export type NewVoucherRedemptionIntentRow = typeof voucherRedemptionIntents.$inferInsert;
