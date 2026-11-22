/**
 * Pricing authority and the legacy cutover run records (0132, Jira RT-1485, spec 044 PR-16a-1).
 *
 *   tenant_pricing_authority  One row per tenant (spec 044 §6.1, MC-4): `legacy`,
 *                             `cutover_in_progress` or `pricing`. Decides both who may write
 *                             prices and what POS sells from. Seeded `legacy` for every tenant;
 *                             a tenants trigger inserts it for every new tenant. Goes with its
 *                             tenant (ON DELETE CASCADE).
 *   pricing_import_runs       The legacy import watermark (§4.3 step 5). Written by PR-16a-2.
 *   pricing_cutover_runs      One row per cutover or rollback attempt (§6.3, §8.1). PR-16b.
 *
 * Drizzle cannot declare the freeze triggers on tenant_products and store_product_overrides,
 * the tenants seed trigger, the SECURITY DEFINER functions owned by pricing_projection_writer,
 * the run tables' no-delete triggers or the policies; those live in 0132's SQL only.
 *
 * RLS: ENABLE + FORCE on all three; tenant SELECT + INSERT, UPDATE on the authority table only;
 * no DELETE. §XIV: BUSINESS-CLASS.
 */
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

import { tenantIdColumn } from "./columns";
import { pricingRevisions } from "./pricing";

export const pricingCutoverRuns = pgTable(
  "pricing_cutover_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    kind: text("kind").notNull(),
    outcome: text("outcome").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    revisionNo: bigint("revision_no", { mode: "number" }),
    authorityFlipSequence: bigint("authority_flip_sequence", { mode: "number" }),
    report: jsonb("report").notNull().default(sql`'{}'::jsonb`),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    correlationId: uuid("correlation_id").notNull(),
  },
  (t) => [
    unique("pricing_cutover_runs_tenant_id_uk").on(t.tenantId, t.id),
    foreignKey({
      name: "pricing_cutover_runs_revision_fk",
      columns: [t.tenantId, t.revisionNo],
      foreignColumns: [pricingRevisions.tenantId, pricingRevisions.revisionNo],
    }).onDelete("restrict"),
    check("pricing_cutover_runs_kind", sql`${t.kind} IN ('cutover', 'rollback')`),
    check("pricing_cutover_runs_outcome", sql`${t.outcome} IN ('succeeded', 'aborted')`),
    check("pricing_cutover_runs_window", sql`${t.finishedAt} >= ${t.startedAt}`),
    index("idx_pricing_cutover_runs_tenant_started").on(t.tenantId, t.startedAt.desc()),
  ],
);

export const pricingImportRuns = pgTable(
  "pricing_import_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    importInstant: timestamp("import_instant", { withTimezone: true }).notNull(),
    changeLogSequence: bigint("change_log_sequence", { mode: "number" }).notNull(),
    revisionNo: bigint("revision_no", { mode: "number" }),
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    correlationId: uuid("correlation_id").notNull(),
  },
  (t) => [
    foreignKey({
      name: "pricing_import_runs_revision_fk",
      columns: [t.tenantId, t.revisionNo],
      foreignColumns: [pricingRevisions.tenantId, pricingRevisions.revisionNo],
    }).onDelete("restrict"),
    check("pricing_import_runs_sequence_non_negative", sql`${t.changeLogSequence} >= 0`),
    index("idx_pricing_import_runs_tenant_instant").on(t.tenantId, t.importInstant.desc()),
  ],
);

export const tenantPricingAuthority = pgTable(
  "tenant_pricing_authority",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    authority: text("authority").notNull().default("legacy"),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    changedByUserId: uuid("changed_by_user_id"),
    changedInRevision: bigint("changed_in_revision", { mode: "number" }),
    authorityFlipSequence: bigint("authority_flip_sequence", { mode: "number" }),
    runId: uuid("run_id"),
    reason: text("reason"),
  },
  (t) => [
    foreignKey({
      name: "tenant_pricing_authority_revision_fk",
      columns: [t.tenantId, t.changedInRevision],
      foreignColumns: [pricingRevisions.tenantId, pricingRevisions.revisionNo],
    }).onDelete("restrict"),
    foreignKey({
      name: "tenant_pricing_authority_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: [pricingCutoverRuns.tenantId, pricingCutoverRuns.id],
    }).onDelete("restrict"),
    check("tenant_pricing_authority_state", sql`${t.authority} IN ('legacy', 'cutover_in_progress', 'pricing')`),
  ],
);
