/**
 * `cashier_suspensions`: whether a cashier is suspended at one store (Jira
 * RT-1138, Story RT-1130; `0106_cashier_suspensions.sql`, [GATED]).
 *
 * One row per (tenant, store, user). A cashier with NO row is not suspended:
 * no backfill, and every existing cashier reads active. A row is created on the
 * first suspension; reactivation flips `status` back to `active` and keeps the
 * row (each change's history is in `audit_events`). Rows are never deleted.
 *
 * `changed_at` / `changed_by_user_id` hold the LAST change only. RLS is forced
 * by tenant; the composite FK keeps the store in the row's own tenant.
 */
import { foreignKey, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

export type CashierSuspensionStatus = "suspended" | "active";

/** A NOT NULL uuid column that references `users.id` (the cashier, and the actor of the last change). */
const userRef = (column: string) =>
  uuid(column)
    .notNull()
    .references(() => users.id, { onDelete: "restrict" });

export const cashierSuspensions = pgTable(
  "cashier_suspensions",
  {
    storeId: uuid("store_id").notNull(),
    userId: userRef("user_id"),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    status: text("status").$type<CashierSuspensionStatus>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    changedByUserId: userRef("changed_by_user_id"),
  },
  (t) => [
    primaryKey({ name: "cashier_suspensions_pkey", columns: [t.tenantId, t.storeId, t.userId] }),
    foreignKey({
      name: "fk_cashier_suspensions_store_tenant",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
  ],
);

export type CashierSuspensionRow = typeof cashierSuspensions.$inferSelect;
export type NewCashierSuspensionRow = typeof cashierSuspensions.$inferInsert;
