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
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    // RT-1389 (0112): the host that provisioned a `succeeded` request (the OD-10 count input).
    provisionedHostLabel: text("provisioned_host_label"),
  },
  (t) => [
    uniqueIndex("uq_erp_provisioning_request_active_tenant_provision")
      .on(t.tenantId)
      .where(
        sql`${t.kind} = 'tenant.provision' AND ${t.status} NOT IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled')`,
      ),
    index("idx_erp_provisioning_request_tenant").on(t.tenantId, t.createdAt),
    index("idx_erp_provisioning_request_pull")
      .on(t.createdAt)
      .where(sql`${t.status} NOT IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled')`),
    index("idx_erp_provisioning_request_registration")
      .on(t.connectorRegistrationId)
      .where(sql`${t.connectorRegistrationId} IS NOT NULL`),
    // Composite-FK target so a step-log row cannot name another tenant.
    unique("uq_erp_provisioning_request_id_tenant").on(t.id, t.tenantId),
    check(
      "erp_provisioning_request_kind_valid",
      sql`${t.kind} IN ('tenant.provision', 'store.provision', 'credential.rotate')`,
    ),
    check(
      "erp_provisioning_request_status_valid",
      sql`${t.status} IN ('requested', 'claimed', 'site_created', 'erp_configured', 'connector_installed', 'credential_bound', 'verifying', 'succeeded', 'failed_retryable', 'failed_permanent', 'compensating', 'compensated', 'cancelled')`,
    ),
    check(
      "erp_provisioning_request_counters_valid",
      sql`${t.generation} >= 1 AND ${t.attempt} >= 0 AND ${t.attemptFloor} >= 0 AND ${t.templateVersion} >= 1 AND ${t.version} >= 1`,
    ),
    check(
      "erp_provisioning_request_lease_all_or_none",
      sql`(${t.leaseHolder} IS NULL) = (${t.leaseId} IS NULL) AND (${t.leaseId} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "erp_provisioning_request_terminal_at_matches_status",
      sql`(${t.terminalAt} IS NOT NULL) = (${t.status} IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled'))`,
    ),
    check(
      "erp_provisioning_request_last_error_class_valid",
      sql`${t.lastErrorClass} IS NULL OR ${t.lastErrorClass} IN ('failed_transient', 'permanently_rejected', 'conflict', 'capacity', 'compatibility', 'dependency')`,
    ),
    check(
      "erp_provisioning_request_provisioned_host_label_valid",
      sql`${t.provisionedHostLabel} IS NULL OR (${t.status} = 'succeeded' AND length(${t.provisionedHostLabel}) BETWEEN 1 AND 64)`,
    ),
    check(
      "erp_provisioning_request_text_bounds",
      sql`length(${t.siteName}) BETWEEN 1 AND 128 AND length(${t.templateId}) BETWEEN 1 AND 64 AND (${t.leaseHolder} IS NULL OR length(${t.leaseHolder}) BETWEEN 1 AND 64) AND (${t.lastReason} IS NULL OR length(${t.lastReason}) BETWEEN 1 AND 200)`,
    ),
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
  (t) => [
    index("idx_erp_provisioning_step_log_request").on(t.requestId, t.createdAt),
    // tenant_id must equal the request's tenant.
    foreignKey({
      name: "erp_provisioning_step_log_request_fk",
      columns: [t.requestId, t.tenantId],
      foreignColumns: [erpProvisioningRequest.id, erpProvisioningRequest.tenantId],
    }).onDelete("restrict"),
    // The idempotency key `{requestId}:{step}:{attempt}`.
    unique("uq_erp_provisioning_step_log_request_step_attempt").on(t.requestId, t.step, t.attempt),
    check(
      "erp_provisioning_step_log_step_valid",
      sql`${t.step} IN ('claimed', 'site_created', 'erp_configured', 'connector_installed', 'credential_bound', 'verified')`,
    ),
    check(
      "erp_provisioning_step_log_outcome_valid",
      sql`${t.outcome} IN ('done', 'failed_transient', 'permanently_rejected', 'conflict', 'capacity', 'compatibility', 'dependency')`,
    ),
    check(
      "erp_provisioning_step_log_shape",
      sql`${t.generation} >= 1 AND ${t.attempt} >= 1 AND ((${t.outcome} = 'done') = (${t.errorClass} IS NULL)) AND (${t.errorClass} IS NULL OR ${t.errorClass} = ${t.outcome}) AND (${t.outcome} <> 'permanently_rejected' OR ${t.reason} IS NOT NULL) AND (${t.reason} IS NULL OR length(${t.reason}) BETWEEN 1 AND 200) AND (${t.detail} IS NULL OR length(${t.detail}) <= 1000)`,
    ),
  ],
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
  (t) => [
    uniqueIndex("uq_erp_provisioner_credential_live_host").on(t.hostLabel).where(sql`${t.revokedAt} IS NULL`),
    check(
      "erp_provisioner_credential_host_label_valid",
      sql`${t.hostLabel} ~ '^[a-z0-9][a-z0-9-]*$' AND length(${t.hostLabel}) <= 64`,
    ),
    check(
      "erp_provisioner_credential_environment_valid",
      sql`${t.environment} IN ('dev', 'staging', 'pilot', 'prod')`,
    ),
    check(
      "erp_provisioner_credential_revocation_pair",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`,
    ),
  ],
);

export type ErpProvisioningRequestRow = typeof erpProvisioningRequest.$inferSelect;
export type NewErpProvisioningRequestRow = typeof erpProvisioningRequest.$inferInsert;
export type ErpProvisioningStepLogRow = typeof erpProvisioningStepLog.$inferSelect;
export type ErpProvisionerCredentialRow = typeof erpProvisionerCredential.$inferSelect;
