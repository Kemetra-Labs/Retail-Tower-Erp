/**
 * `voucher_redemptions` — one row per voucher redeem (0092, Jira RT-1111,
 * slice R-2 of RT-1098; contract `pos-payments/vouchers.yaml`).
 *
 * `id` IS the contract's `redemption_id`. `intent_id` is unique, so an intent
 * yields at most one redemption. A reverse sets `reversed_at` and
 * `reversed_by_device_id` together. A partial unique index
 * (`uq_voucher_redemptions_open_per_voucher`, declared below and in 0092's
 * SQL) allows at most one un-reversed redemption per voucher (decision 1A: the
 * voucher is used once; a reverse frees it).
 *
 * RLS: ENABLE + FORCE; SELECT + INSERT + UPDATE tenant policies, no DELETE.
 * §XIV: BUSINESS-CLASS with a monetary attribute — opaque ids, amounts in
 * minor units, timestamps, operator user id and device ids (actors and
 * equipment, not customer PII). The policies are defined in 0092's SQL.
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { devices } from "../devices";
import { amountChecks, redemptionFactColumns, redemptionSharedColumns, scopeForeignKeys } from "./redemption-columns";
import { voucherRedemptionIntents } from "./voucher-redemption-intents";

export const voucherRedemptions = pgTable(
  "voucher_redemptions",
  {
    // The contract's `redemption_id`.
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    ...redemptionSharedColumns(),
    intentId: uuid("intent_id").notNull(),
    ...redemptionFactColumns(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).defaultNow().notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    // Any device of the redemption's store may reverse it (FK below, RT-1110 c16417).
    reversedByDeviceId: uuid("reversed_by_device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("voucher_redemptions_tenant_id_uk").on(t.tenantId, t.id),
    unique("voucher_redemptions_tenant_intent_uk").on(t.tenantId, t.intentId),
    uniqueIndex("uq_voucher_redemptions_open_per_voucher")
      .on(t.tenantId, t.voucherId)
      .where(sql`${t.reversedAt} IS NULL`),
    index("idx_voucher_redemptions_tenant_voucher").on(t.tenantId, t.voucherId),
    ...amountChecks("voucher_redemptions", t),
    check("voucher_redemptions_reversed_after_redeemed", sql`${t.reversedAt} IS NULL OR ${t.reversedAt} >= ${t.redeemedAt}`),
    check("voucher_redemptions_reversed_columns", sql`(${t.reversedAt} IS NULL) = (${t.reversedByDeviceId} IS NULL)`),
    ...scopeForeignKeys("voucher_redemptions", t),
    foreignKey({
      name: "fk_voucher_redemptions_intent_tenant",
      // The redemption equals its intent in store, voucher, attempt and amounts.
      columns: [t.tenantId, t.intentId, t.storeId, t.voucherId, t.paymentAttemptId, t.appliedAmountMinor, t.forfeitedAmountMinor],
      foreignColumns: [
        voucherRedemptionIntents.tenantId,
        voucherRedemptionIntents.id,
        voucherRedemptionIntents.storeId,
        voucherRedemptionIntents.voucherId,
        voucherRedemptionIntents.paymentAttemptId,
        voucherRedemptionIntents.appliedAmountMinor,
        voucherRedemptionIntents.forfeitedAmountMinor,
      ],
    }).onDelete("restrict"),
    // A NULL reversing device skips this composite FK (MATCH SIMPLE).
    foreignKey({
      name: "fk_voucher_redemptions_reversed_by_device_store_tenant",
      columns: [t.reversedByDeviceId, t.tenantId, t.storeId],
      foreignColumns: [devices.id, devices.tenantId, devices.storeId],
    }).onDelete("restrict"),
  ],
);

export type VoucherRedemptionRow = typeof voucherRedemptions.$inferSelect;
export type NewVoucherRedemptionRow = typeof voucherRedemptions.$inferInsert;
