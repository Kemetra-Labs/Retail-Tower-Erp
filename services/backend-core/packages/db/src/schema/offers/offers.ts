/**
 * Offer Engine V1 — `offers` (0101, Jira RT-1336, RT-286 spec 048 slice S3;
 * contract `offers.openapi.yaml` `Offer`).
 *
 * One row per offer: tenant identity and the stored lifecycle facts. The
 * contract's `state` is DERIVED when read (no published version = draft;
 * ended_at, archived_at, the open whole-offer pause in `offer_pauses` and the
 * current version's schedule give the rest).
 *
 * The draft of the next version is a mutable JSONB working copy of
 * `OfferDefinition`, validated by the runtime (no FKs: preview reports invalid
 * references). `draft_revision` is the optimistic-concurrency token: the last
 * revision ever issued, never reused across drafts.
 *
 * Invariants in 0101's SQL (`offers_guard` trigger and CHECKs): a draft is
 * whole or absent; the draft revision never moves back; id, tenant and the
 * creation facts never change; an end is recorded once; an archived offer
 * never changes (and gets no new version).
 *
 * RLS: ENABLE + FORCE; SELECT, INSERT and UPDATE tenant policies; no DELETE.
 * §XIV: BUSINESS-CLASS.
 */
import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    draftRevision: integer("draft_revision").notNull().default(0),
    /** `OfferDefinition` of the next version, or null when there is no draft. */
    draftDefinition: jsonb("draft_definition"),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }),
    draftUpdatedByUserId: uuid("draft_updated_by_user_id"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: uuid("archived_by_user_id"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("offers_draft_revision_non_negative", sql`${t.draftRevision} >= 0`),
    check(
      "offers_draft_whole",
      sql`(${t.draftDefinition} IS NULL) = (${t.draftUpdatedAt} IS NULL) AND (${t.draftDefinition} IS NULL) = (${t.draftUpdatedByUserId} IS NULL) AND (${t.draftDefinition} IS NULL OR ${t.draftRevision} >= 1)`,
    ),
    check("offers_draft_is_object", sql`${t.draftDefinition} IS NULL OR jsonb_typeof(${t.draftDefinition}) = 'object'`),
    check("offers_ended_whole", sql`(${t.endedAt} IS NULL) = (${t.endedByUserId} IS NULL)`),
    check("offers_archived_whole", sql`(${t.archivedAt} IS NULL) = (${t.archivedByUserId} IS NULL)`),
    check("offers_ended_after_created", sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.createdAt}`),
    check("offers_archived_after_created", sql`${t.archivedAt} IS NULL OR ${t.archivedAt} >= ${t.createdAt}`),
    unique("offers_tenant_id_uk").on(t.tenantId, t.id),
  ],
);

export type OfferRow = typeof offers.$inferSelect;
export type NewOfferRow = typeof offers.$inferInsert;
