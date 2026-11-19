/**
 * Column builders shared by the Retail Pricing tables (0121, 0123; RT-1151).
 * Not re-exported from the schema index: only the pricing table files use them.
 */
import { bigint, boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

/** `tenant_id`, NOT NULL, FK to tenants (RESTRICT). */
export const tenantIdColumn = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" });

/** Who wrote a row, when, and under which request (every pricing table). */
export const pricingAuthorshipColumns = () => ({
  createdByUserId: uuid("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  correlationId: uuid("correlation_id").notNull(),
});

/** The timeline row lifecycle shared by memberships and events. */
export const timelineColumns = () => ({
  state: text("state").notNull().default("active"),
  publishedInRevision: bigint("published_in_revision", { mode: "number" }).notNull(),
  endedInRevision: bigint("ended_in_revision", { mode: "number" }),
  carriedForward: boolean("carried_forward").notNull().default(false),
});

/** The time basis and its bounds: absolute instants, or Store-local wall-clock times (spec 041 §4.3). */
export const effectiveBoundsColumns = () => ({
  timeBasis: text("time_basis").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  effectiveFromLocal: timestamp("effective_from_local", { withTimezone: false }),
  effectiveToLocal: timestamp("effective_to_local", { withTimezone: false }),
});
