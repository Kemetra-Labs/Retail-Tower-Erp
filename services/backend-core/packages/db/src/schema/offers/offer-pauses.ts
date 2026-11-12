/**
 * Offer Engine V1 — `offer_pauses` (0101, Jira RT-1336; contract
 * `offers.openapi.yaml` `OfferPause`, `OfferStorePause`, OD-12).
 *
 * Whole-offer pauses (`store_id` null) and store-level pauses, with their
 * required reason (1..500, "no PII"). A resume sets `resumed_at` and
 * `resumed_by_user_id` once; nothing else changes and no row is deleted (§21:
 * pausing never deletes history). At most one open whole-offer pause per
 * offer, and one open pause per (offer, store) (partial unique indexes).
 *
 * RLS: ENABLE + FORCE; SELECT, INSERT and UPDATE tenant policies (the guard
 * trigger allows only the resume); no DELETE. §XIV: BUSINESS-CLASS.
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { stores } from "../stores";
import { offers } from "./offers";

export const offerPauses = pgTable(
  "offer_pauses",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    /** Null: the whole offer. */
    storeId: uuid("store_id"),
    reason: text("reason").notNull(),
    pausedByUserId: uuid("paused_by_user_id").notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true }).defaultNow().notNull(),
    resumedByUserId: uuid("resumed_by_user_id"),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "fk_offer_pauses_offer_tenant",
      columns: [t.tenantId, t.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_offer_pauses_store_tenant",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    check("offer_pauses_reason_length", sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
    check("offer_pauses_resumed_whole", sql`(${t.resumedAt} IS NULL) = (${t.resumedByUserId} IS NULL)`),
    uniqueIndex("uq_offer_pauses_open_offer")
      .on(t.tenantId, t.offerId)
      .where(sql`${t.storeId} IS NULL AND ${t.resumedAt} IS NULL`),
    uniqueIndex("uq_offer_pauses_open_store")
      .on(t.tenantId, t.offerId, t.storeId)
      .where(sql`${t.storeId} IS NOT NULL AND ${t.resumedAt} IS NULL`),
  ],
);

export type OfferPauseRow = typeof offerPauses.$inferSelect;
export type NewOfferPauseRow = typeof offerPauses.$inferInsert;
