/**
 * `user_consents` — the durable consent record, keyed to the USER (Jira
 * RT-1350 slice 2; design RT-1333 v6 D6 "on the user"; `0107_pending_signups.sql`,
 * [GATED: migration]).
 *
 * Written by the signup service when a signup completes. Append-only: RLS has
 * a platform-admin SELECT and INSERT policy and no UPDATE or DELETE policy, and
 * no tenant policy (a tenant session sees nothing). `pending_signup_id` is
 * provenance only (ON DELETE SET NULL, so purging a pending row keeps the
 * consent). `ip_hash` is a hash, never the address. Retained for the life of
 * the user.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { pendingSignups } from "./pending-signups";
import { users } from "./users";

export const USER_CONSENT_SOURCES = ["self_signup"] as const;
export type UserConsentSource = (typeof USER_CONSENT_SOURCES)[number];

export const userConsents = pgTable("user_consents", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  termsVersion: text("terms_version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  ipHash: text("ip_hash").notNull(),
  source: text("source").$type<UserConsentSource>().notNull(),
  pendingSignupId: uuid("pending_signup_id").references(() => pendingSignups.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserConsentRow = typeof userConsents.$inferSelect;
export type NewUserConsentRow = typeof userConsents.$inferInsert;
