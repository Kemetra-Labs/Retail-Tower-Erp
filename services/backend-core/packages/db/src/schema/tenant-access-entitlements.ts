/**
 * The tenant access state, `restricted` or `unrestricted` (Jira RT-1353, Epic
 * RT-1332; design RT-1333 D2 = B, P2; `0104_tenant_access_entitlements.sql`,
 * [GATED]).
 *
 * One row per tenant. A tenant with NO row is `unrestricted`: no backfill, and
 * every existing tenant reads `unrestricted`. Only an explicitly restricted
 * tenant (a self-signup tenant, RT-1350) has a row. It is not a
 * `tenants.status` value, so the RT-669 / RT-213 gate is unchanged.
 *
 * Forward path (CHECKs and a trigger in the SQL migration): `restricted`, an
 * unlock request (platform admin; the durable provisioning trigger RT-1352
 * will consume), then `unrestricted` with the provisioning result. Packages,
 * quotas and billing are not here (RT-1001). RLS is forced: a tenant reads its
 * own row, only a platform admin writes it.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";
import { users } from "./users";

export const TENANT_ACCESS_STATES = ["restricted", "unrestricted"] as const;
export type TenantAccessState = (typeof TENANT_ACCESS_STATES)[number];

/** How a tenant became `unrestricted`. `manual_platform` is the platform admin's "mark provisioned". */
export const TENANT_PROVISIONING_SOURCES = ["manual_platform"] as const;
export type TenantProvisioningSource = (typeof TENANT_PROVISIONING_SOURCES)[number];

export const tenantAccessEntitlements = pgTable("tenant_access_entitlements", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "restrict" }),
  state: text("state").$type<TenantAccessState>().notNull(),
  unlockRequestedAt: timestamp("unlock_requested_at", { withTimezone: true }),
  unlockRequestedByUserId: uuid("unlock_requested_by_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
  provisionedByUserId: uuid("provisioned_by_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  provisioningSource: text("provisioning_source").$type<TenantProvisioningSource>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TenantAccessEntitlementRow = typeof tenantAccessEntitlements.$inferSelect;
