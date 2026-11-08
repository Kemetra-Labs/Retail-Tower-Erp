/**
 * RT-1292 (RT-1290 slice P1): the POS PILOT release lane.
 *
 * `pos_pilot_release_registry` — one row per promoted pilot release. Platform
 * level (no tenant column). Only signing class `pilot` is admitted and the
 * publisher refuses the lab markers, so a lab or production release cannot be
 * stored; at most one release is current (approved and activated). Immutable
 * except for approval, withdrawal and activation (trigger).
 *
 * `pos_pilot_tenant_allowlist` — the tenants that may download the pilot
 * release; one row per tenant.
 *
 * RLS (migration `0088_pos_pilot_releases.sql`): ENABLE + FORCE on both.
 * Registry: SELECT open, INSERT and UPDATE need the platform-admin GUC, no
 * DELETE. Allowlist: SELECT own tenant or platform admin, INSERT and DELETE
 * platform admin only, no UPDATE.
 */
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";
import { users } from "./users";

export const posPilotReleaseRegistry = pgTable("pos_pilot_release_registry", {
  id: uuid("id").primaryKey(),
  version: text("version").notNull().unique(),
  sha256: text("sha256").notNull().unique(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  publisher: text("publisher").notNull(),
  signingClass: text("signing_class").notNull(),
  attestationRef: text("attestation_ref").notNull(),
  sourceSha: text("source_sha").notNull(),
  artifactKey: text("artifact_key").notNull().unique(),
  artifactVersionId: text("artifact_version_id").notNull(),
  approved: boolean("approved").notNull().default(true),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  approvedBy: text("approved_by").notNull(),
  promotionRunUrl: text("promotion_run_url").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnBy: text("withdrawn_by"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedByUserId: uuid("activated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
});

export const posPilotTenantAllowlist = pgTable("pos_pilot_tenant_allowlist", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "restrict" }),
  addedByUserId: uuid("added_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PosPilotReleaseRegistryRow = typeof posPilotReleaseRegistry.$inferSelect;
export type NewPosPilotReleaseRegistryRow = typeof posPilotReleaseRegistry.$inferInsert;
export type PosPilotTenantAllowlistRow = typeof posPilotTenantAllowlist.$inferSelect;
