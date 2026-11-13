/**
 * `pending_signups` — a customer self-signup that was requested and not yet
 * completed (Jira RT-1350 slice 2, Epic RT-1332; design RT-1333 v6 section 4;
 * `0107_pending_signups.sql`, [GATED: migration]).
 *
 * PRE-TENANT: no `tenant_id` until `completeSignup` creates the tenant. RLS is
 * forced with NO tenant policy (a tenant session sees nothing) and a single
 * platform-admin policy per command (SELECT, INSERT, UPDATE; no DELETE yet).
 *
 * `token_hash` is NULL under D1-B (provider-sent link, no token stored) and the
 * hash of Backend-Core's own token under the fallback D1-A, never the token.
 * `tenant_id` + `completed_at` + `status = 'completed'` answer a lost 201
 * idempotently. PII-class: 24 h expiry, hard delete 7 days later by a later
 * slice's purge job. D5 rate limits live in Redis, so there are no counters.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";

export const PENDING_SIGNUP_STATUSES = ["pending", "completed", "expired"] as const;
export type PendingSignupStatus = (typeof PENDING_SIGNUP_STATUSES)[number];

export const PENDING_SIGNUP_LOCALES = ["ar", "en"] as const;
export type PendingSignupLocale = (typeof PENDING_SIGNUP_LOCALES)[number];

export const pendingSignups = pgTable("pending_signups", {
  id: uuid("id").primaryKey(),
  emailNormalized: text("email_normalized").notNull(),
  name: text("name").notNull(),
  businessName: text("business_name").notNull(),
  locale: text("locale").$type<PendingSignupLocale>(),
  termsVersion: text("terms_version").notNull(),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }).notNull(),
  ipHash: text("ip_hash").notNull(),
  tokenHash: text("token_hash"),
  status: text("status").$type<PendingSignupStatus>().notNull().default("pending"),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type PendingSignupRow = typeof pendingSignups.$inferSelect;
export type NewPendingSignupRow = typeof pendingSignups.$inferInsert;
