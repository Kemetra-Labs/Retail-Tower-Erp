/**
 * ERP provisioning storage (Jira RT-1357, Epic RT-1332; RT-1352 breakdown item
 * PB-B; `0109_erp_provisioning.sql`, `[GATED: migration]`). The shape the
 * provisioning service (PB-C) builds against; the wire vocabulary is the merged
 * contract `openapi/erpnext-connector/provisioning-feed.yaml` (RT-1356).
 *
 * Three tables, all FORCE RLS (policies in the migration header):
 *   - `erp_provisioning_request`: one row per request. At most one ACTIVE
 *     `tenant.provision` per tenant (partial unique index). `version` is bumped
 *     by a trigger on every UPDATE (optimistic concurrency). `attempt_floor` is
 *     the contract's `attemptFloor`. A tenant reads its own rows; the
 *     provisioner (`app.is_provisioner`) and a platform admin read all.
 *   - `erp_provisioning_step_log`: append-only; UNIQUE (request, step, attempt)
 *     is the idempotency key.
 *   - `erp_provisioner_credential`: the platform-scope provisioner credential
 *     per ERP host label and environment. The secret hash lives in `auth_tokens`
 *     (scope `connector_provisioner`); nothing secret is stored here.
 */
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { authTokens } from "./auth_tokens";
import { connectorRegistration } from "./connector_registration";
import { tenants } from "./tenants";
import { users } from "./users";

/** The seeded system actor (a `users` row that cannot sign in): the user of every provisioner token. */
export const ERP_SYSTEM_ACTOR_USER_ID = "00000000-0000-7000-8000-000000001357";

export const ERP_PROVISIONING_REQUEST_KINDS = ["tenant.provision", "store.provision", "credential.rotate"] as const;
export type ErpProvisioningRequestKind = (typeof ERP_PROVISIONING_REQUEST_KINDS)[number];

export const ERP_PROVISIONING_STATUSES = [
  "requested",
  "claimed",
  "site_created",
  "erp_configured",
  "connector_installed",
  "credential_bound",
  "verifying",
  "succeeded",
  "failed_retryable",
  "failed_permanent",
  "compensating",
  "compensated",
  "cancelled",
] as const;
export type ErpProvisioningStatus = (typeof ERP_PROVISIONING_STATUSES)[number];

/** Terminal: never offered again. Matches the partial unique index and `terminal_at`. */
export const ERP_PROVISIONING_TERMINAL_STATUSES = ["succeeded", "failed_permanent", "compensated", "cancelled"] as const;

export const ERP_PROVISIONING_STEPS = [
  "claimed",
  "site_created",
  "erp_configured",
  "connector_installed",
  "credential_bound",
  "verified",
] as const;
export type ErpProvisioningStep = (typeof ERP_PROVISIONING_STEPS)[number];

export const ERP_PROVISIONING_OUTCOMES = [
  "done",
  "failed_transient",
  "permanently_rejected",
  "conflict",
  "capacity",
  "compatibility",
  "dependency",
] as const;
export type ErpProvisioningOutcome = (typeof ERP_PROVISIONING_OUTCOMES)[number];

export const erpProvisioningRequest = pgTable(
  "erp_provisioning_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    kind: text("kind").$type<ErpProvisioningRequestKind>().notNull(),
    generation: integer("generation").notNull().default(1),
    status: text("status").$type<ErpProvisioningStatus>().notNull().default("requested"),
    attempt: integer("attempt").notNull().default(0),
    attemptFloor: integer("attempt_floor").notNull().default(0),
    leaseHolder: text("lease_holder"),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    notBefore: timestamp("not_before", { withTimezone: true }),
    lastErrorClass: text("last_error_class"),
    lastReason: text("last_reason"),
    siteName: text("site_name").notNull(),
    templateId: text("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    connectorRegistrationId: uuid("connector_registration_id").references(() => connectorRegistration.id, {
      onDelete: "restrict",
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_erp_provisioning_request_active_tenant_provision")
      .on(t.tenantId)
      .where(
        sql`${t.kind} = 'tenant.provision' AND ${t.status} NOT IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled')`,
      ),
    index("idx_erp_provisioning_request_tenant").on(t.tenantId, t.createdAt),
  ],
);

export const erpProvisioningStepLog = pgTable(
  "erp_provisioning_step_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    generation: integer("generation").notNull(),
    step: text("step").$type<ErpProvisioningStep>().notNull(),
    outcome: text("outcome").$type<ErpProvisioningOutcome>().notNull(),
    attempt: integer("attempt").notNull(),
    errorClass: text("error_class"),
    reason: text("reason"),
    detail: text("detail"),
    leaseId: uuid("lease_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_erp_provisioning_step_log_request").on(t.requestId, t.createdAt)],
);

export const erpProvisionerCredential = pgTable(
  "erp_provisioner_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostLabel: text("host_label").notNull(),
    environment: text("environment").notNull(),
    tokenId: uuid("token_id")
      .notNull()
      .unique()
      .references(() => authTokens.id, { onDelete: "restrict" }),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [uniqueIndex("uq_erp_provisioner_credential_live_host").on(t.hostLabel).where(sql`${t.revokedAt} IS NULL`)],
);

export type ErpProvisioningRequestRow = typeof erpProvisioningRequest.$inferSelect;
export type NewErpProvisioningRequestRow = typeof erpProvisioningRequest.$inferInsert;
export type ErpProvisioningStepLogRow = typeof erpProvisioningStepLog.$inferSelect;
export type ErpProvisionerCredentialRow = typeof erpProvisionerCredential.$inferSelect;
