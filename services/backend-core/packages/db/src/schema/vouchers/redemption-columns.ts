/**
 * Columns, CHECKs and composite FKs that `voucher_redemption_intents` and
 * `voucher_redemptions` (0092, Jira RT-1111) share. Both tables bind the same
 * (tenant, store, voucher, payment attempt, amounts, operator, device) facts;
 * the SQL in 0092 is the source of truth and each table repeats it there.
 */
import { sql, type SQL } from "drizzle-orm";
import { bigint, check, foreignKey, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

import { devices } from "../devices";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { vouchers } from "./vouchers";

/** The columns both tables carry, in the order 0092 declares them after `id`. */
export const redemptionSharedColumns = () => ({
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  storeId: uuid("store_id").notNull(),
  voucherId: uuid("voucher_id").notNull(),
});

/** The amounts and actors both tables carry. `paymentAttemptId` is the POS's own id: no table holds attempts, so no FK. */
export const redemptionFactColumns = () => ({
  paymentAttemptId: uuid("payment_attempt_id").notNull(),
  appliedAmountMinor: bigint("applied_amount_minor", { mode: "number" }).notNull(),
  forfeitedAmountMinor: bigint("forfeited_amount_minor", { mode: "number" }).notNull(),
  operatorUserId: uuid("operator_user_id").notNull(),
  deviceId: uuid("device_id").notNull(),
});

interface AmountColumns {
  appliedAmountMinor: AnyPgColumn;
  forfeitedAmountMinor: AnyPgColumn;
}

/** applied > 0, forfeited >= 0, both within the JS safe-integer bound (bigint mode "number"). */
export function amountChecks(prefix: string, t: AmountColumns): ReturnType<typeof check>[] {
  const applied: SQL = sql`${t.appliedAmountMinor} > 0 AND ${t.appliedAmountMinor} <= 9007199254740991`;
  const forfeited: SQL = sql`${t.forfeitedAmountMinor} >= 0 AND ${t.forfeitedAmountMinor} <= 9007199254740991`;
  return [check(`${prefix}_applied_positive`, applied), check(`${prefix}_forfeited_non_negative`, forfeited)];
}

interface ScopeColumns {
  tenantId: AnyPgColumn;
  storeId: AnyPgColumn;
  voucherId: AnyPgColumn;
  deviceId: AnyPgColumn;
}

/** The voucher, store and device composite FKs, each pinned to the row's tenant (ON DELETE RESTRICT). */
export function scopeForeignKeys(prefix: string, t: ScopeColumns): ReturnType<typeof foreignKey>[] {
  return [
    foreignKey({
      name: `fk_${prefix}_voucher_tenant`,
      columns: [t.tenantId, t.voucherId],
      foreignColumns: [vouchers.tenantId, vouchers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: `fk_${prefix}_store_tenant`,
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    foreignKey({
      name: `fk_${prefix}_device_store_tenant`,
      columns: [t.deviceId, t.tenantId, t.storeId],
      foreignColumns: [devices.id, devices.tenantId, devices.storeId],
    }).onDelete("restrict"),
  ];
}
