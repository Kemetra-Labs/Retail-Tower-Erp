/**
 * RT-1358 — the api writer of `erp_provisioning_request` and the only reader
 * that maps it. Migration 0109 lets the provisioner UPDATE every column the guard
 * trigger does not freeze, so every write here goes through `writeRequest`, which
 * checks `transitionAllowed` and the optimistic `version`. The worker sweep
 * (`packages/db/src/helpers/erp-provisioning-sweep.ts`) is the only other writer and
 * checks the same shared table (RT-1389); migration 0112's trigger enforces it in SQL
 * too. A fence test pins both writers.
 *
 * RT-1389: a `succeeded` request records its host in `provisioned_host_label` (the
 * OD-10 per-host site count reads it) and keeps no lease. A `failed_permanent`
 * request still ends its lease with the holder kept (`end`): that holder is the
 * replay key of a repeated failure report; nothing counts it.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { newId } from "@data-pulse-2/shared";

import {
  isTerminal,
  transitionAllowed,
  type ErrorClass,
  type RequestPatch,
  type RequestState,
  type RequestStatus,
  type StepName,
  type StepOutcome,
} from "./provisioning-state";

export interface RequestRow extends RequestState {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: "tenant.provision" | "store.provision" | "credential.rotate";
  readonly generation: number;
  readonly attempt: number;
  readonly leaseId: string | null;
  readonly siteName: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly connectorRegistrationId: string | null;
  readonly provisionedHostLabel: string | null;
  readonly version: number;
  readonly createdAt: Date;
}

interface DbRow {
  id: string;
  tenant_id: string;
  kind: RequestRow["kind"];
  generation: number;
  status: RequestStatus;
  attempt: number;
  attempt_floor: number;
  lease_holder: string | null;
  lease_id: string | null;
  lease_expires_at: Date | null;
  not_before: Date | null;
  last_error_class: ErrorClass | null;
  last_reason: string | null;
  site_name: string;
  template_id: string;
  template_version: number;
  connector_registration_id: string | null;
  provisioned_host_label: string | null;
  version: number;
  created_at: Date;
}

const COLS = `id, tenant_id, kind, generation, status, attempt, attempt_floor, lease_holder, lease_id,
  lease_expires_at, not_before, last_error_class, last_reason, site_name, template_id, template_version,
  connector_registration_id, provisioned_host_label, version, created_at`;

function map(r: DbRow): RequestRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    generation: r.generation,
    status: r.status,
    attempt: r.attempt,
    attemptFloor: r.attempt_floor,
    leaseHolder: r.lease_holder,
    leaseId: r.lease_id,
    leaseExpiresAt: r.lease_expires_at,
    notBefore: r.not_before,
    lastErrorClass: r.last_error_class,
    lastReason: r.last_reason,
    siteName: r.site_name,
    templateId: r.template_id,
    templateVersion: r.template_version,
    connectorRegistrationId: r.connector_registration_id,
    provisionedHostLabel: r.provisioned_host_label,
    version: r.version,
    createdAt: r.created_at,
  };
}

const TERMINAL_SQL = `('succeeded','failed_permanent','compensated','cancelled')`;

export async function lockRequest(client: PoolClient, id: string): Promise<RequestRow | null> {
  const r = await client.query<DbRow>(`SELECT ${COLS} FROM erp_provisioning_request WHERE id = $1::uuid FOR UPDATE`, [id]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

/** The one active (non-terminal) `tenant.provision` request of a tenant, if any. */
export async function readActiveTenantRequest(client: PoolClient, tenantId: string): Promise<RequestRow | null> {
  const r = await client.query<DbRow>(
    `SELECT ${COLS} FROM erp_provisioning_request
      WHERE tenant_id = $1::uuid AND kind = 'tenant.provision' AND status NOT IN ${TERMINAL_SQL}
      FOR UPDATE`,
    [tenantId],
  );
  return r.rows[0] ? map(r.rows[0]) : null;
}

export interface NewRequest {
  readonly tenantId: string;
  readonly siteName: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly connectorRegistrationId: string;
}

/** The unlock transaction's insert (platform-admin context): a clean `requested` row. */
export async function insertRequest(client: PoolClient, input: NewRequest): Promise<RequestRow> {
  const r = await client.query<DbRow>(
    `INSERT INTO erp_provisioning_request
       (id, tenant_id, kind, site_name, template_id, template_version, connector_registration_id)
     VALUES ($1, $2, 'tenant.provision', $3, $4, $5, $6)
     RETURNING ${COLS}`,
    [newId(), input.tenantId, input.siteName, input.templateId, input.templateVersion, input.connectorRegistrationId],
  );
  return map(r.rows[0]!);
}

export interface PullPage {
  readonly rows: readonly RequestRow[];
}

/**
 * Offerable requests, oldest first, after the keyset cursor. The predicate is the
 * SQL twin of `isOfferable`; `withholdNewTenants` (the host is at its site
 * ceiling) leaves `tenant.provision` requests that have not started out.
 */
export async function pullOfferable(
  client: PoolClient,
  input: { readonly now: Date; readonly after: { readonly createdAt: Date; readonly id: string } | null; readonly limit: number; readonly withholdNewTenants: boolean },
): Promise<PullPage> {
  const r = await client.query<DbRow>(
    `SELECT ${COLS} FROM erp_provisioning_request
      WHERE status NOT IN ${TERMINAL_SQL} AND status <> 'compensating'
        AND NOT (status = 'verifying' AND lease_id IS NULL)
        AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
        AND (not_before IS NULL OR not_before <= $1)
        AND NOT ($5::boolean AND kind = 'tenant.provision' AND status = 'requested')
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, id
      LIMIT $4`,
    [input.now, input.after?.createdAt ?? null, input.after?.id ?? null, input.limit, input.withholdNewTenants],
  );
  return { rows: r.rows.map(map) };
}

/** Succeeded `tenant.provision` sites this host label has provisioned (the OD-10 ceiling input). */
export async function countSitesForHost(client: PoolClient, host: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erp_provisioning_request
      WHERE kind = 'tenant.provision' AND status = 'succeeded' AND provisioned_host_label = $1`,
    [host],
  );
  return Number(r.rows[0]!.n);
}

/** Another live lease held by this host label (one live lease per host: one site at a time). */
export async function hasOtherLiveLease(client: PoolClient, host: string, exceptRequestId: string, now: Date): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM erp_provisioning_request
      WHERE lease_holder = $1 AND lease_expires_at > $2 AND id <> $3::uuid AND status NOT IN ${TERMINAL_SQL}
      LIMIT 1`,
    [host, now, exceptRequestId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface StepLogRow {
  readonly outcome: StepOutcome;
  readonly leaseId: string | null;
}

export async function findStep(client: PoolClient, requestId: string, step: StepName, attempt: number): Promise<StepLogRow | null> {
  const r = await client.query<{ outcome: StepOutcome; lease_id: string | null }>(
    `SELECT outcome, lease_id FROM erp_provisioning_step_log WHERE request_id = $1::uuid AND step = $2 AND attempt = $3`,
    [requestId, step, attempt],
  );
  return r.rows[0] ? { outcome: r.rows[0].outcome, leaseId: r.rows[0].lease_id } : null;
}

export async function countTransientFailures(client: PoolClient, requestId: string, step: StepName, generation: number): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erp_provisioning_step_log
      WHERE request_id = $1::uuid AND step = $2 AND generation = $3 AND outcome = 'failed_transient'`,
    [requestId, step, generation],
  );
  return Number(r.rows[0]!.n);
}

export async function appendStep(
  client: PoolClient,
  row: RequestRow,
  input: { readonly step: StepName; readonly outcome: StepOutcome; readonly attempt: number; readonly errorClass: ErrorClass | null; readonly reason: string | null; readonly detail: string | null; readonly leaseId: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO erp_provisioning_step_log
       (id, request_id, tenant_id, generation, step, outcome, attempt, error_class, reason, detail, lease_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [newId(), row.id, row.tenantId, row.generation, input.step, input.outcome, input.attempt, input.errorClass, input.reason, input.detail, input.leaseId],
  );
}

export interface RequestWrite {
  readonly status?: RequestStatus;
  readonly attempt?: number;
  readonly attemptFloor?: number;
  readonly lease: "take" | "renew" | "clear" | "end" | "keep";
  readonly host?: string;
  /** Only with `status: "succeeded"`: the host that provisioned the site (the OD-10 count input). */
  readonly provisionedHost?: string;
  readonly notBefore?: Date | null;
  readonly lastErrorClass?: ErrorClass | null;
  readonly lastReason?: string | null;
}

/** Turn a decision patch into a write. */
export function writeFromPatch(patch: RequestPatch, host: string): RequestWrite {
  return {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
    attemptFloor: patch.attemptFloor,
    lease: patch.lease,
    host,
    notBefore: patch.notBefore,
    lastErrorClass: patch.lastErrorClass,
    lastReason: patch.lastReason,
  };
}

const NO_LEASE = { leaseHolder: null, leaseId: null, leaseExpiresAt: null } as const;

/**
 * The lease columns after a write: `take` a new one, `renew` the expiry, `clear` it, `end` it now (holder kept:
 * a `failed_permanent` row's replay key, never a host count), or `keep`.
 */
function nextLease(
  row: RequestRow,
  write: RequestWrite,
  now: Date,
  ttlMs: number,
): { leaseHolder: string | null; leaseId: string | null; leaseExpiresAt: Date | null } {
  const kept = { leaseHolder: row.leaseHolder, leaseId: row.leaseId, leaseExpiresAt: row.leaseExpiresAt };
  switch (write.lease) {
    case "take":
      return { leaseHolder: write.host ?? null, leaseId: randomUUID(), leaseExpiresAt: new Date(now.getTime() + ttlMs) };
    case "renew":
      return { ...kept, leaseExpiresAt: new Date(now.getTime() + ttlMs) };
    case "clear":
      return NO_LEASE;
    case "end":
      return row.leaseId === null ? kept : { ...kept, leaseExpiresAt: now };
    default:
      return kept;
  }
}

/**
 * THE api write. Checks the transition table and the optimistic version, bumps the
 * terminal timestamp, and returns the new row. A `succeeded` write records the
 * provisioning host in `provisioned_host_label` and clears the lease.
 */
export async function writeRequest(client: PoolClient, row: RequestRow, write: RequestWrite, now: Date, leaseTtlMs: number): Promise<RequestRow> {
  const status = write.status ?? row.status;
  if (!transitionAllowed(row.status, status)) {
    throw new Error(`erp_provisioning_request: transition ${row.status} -> ${status} is not allowed`);
  }
  if (write.provisionedHost !== undefined && status !== "succeeded") {
    throw new Error("erp_provisioning_request: a provisioned host is recorded only on succeeded");
  }
  if (status === "succeeded" && write.lease === "end") {
    throw new Error("erp_provisioning_request: a succeeded request keeps no lease (use provisionedHost)");
  }
  const { leaseHolder, leaseId, leaseExpiresAt } = nextLease(row, write, now, leaseTtlMs);
  const terminal = isTerminal(status);
  const r = await client.query<DbRow>(
    `UPDATE erp_provisioning_request
        SET status = $3, attempt = $4, attempt_floor = $5, lease_holder = $6, lease_id = $7,
            lease_expires_at = $8, not_before = $9, last_error_class = $10, last_reason = $11,
            terminal_at = $12, provisioned_host_label = $13
      WHERE id = $1::uuid AND version = $2
      RETURNING ${COLS}`,
    [
      row.id,
      row.version,
      status,
      write.attempt ?? row.attempt,
      write.attemptFloor ?? row.attemptFloor,
      leaseHolder,
      leaseId,
      leaseExpiresAt,
      write.notBefore === undefined ? row.notBefore : write.notBefore,
      write.lastErrorClass === undefined ? row.lastErrorClass : write.lastErrorClass,
      write.lastReason === undefined ? row.lastReason : write.lastReason,
      terminal ? now : null,
      write.provisionedHost ?? row.provisionedHostLabel,
    ],
  );
  if (r.rowCount === 0) throw new Error("erp_provisioning_request: version conflict");
  return map(r.rows[0]!);
}

/** Cancel the open request of a tenant (the manual mark-provisioned path). Platform-admin context. */
export async function cancelOpenRequest(client: PoolClient, row: RequestRow, now: Date): Promise<RequestRow> {
  return await writeRequest(client, row, { status: "cancelled", lease: "clear", lastReason: "cancelled by manual mark-provisioned", lastErrorClass: null }, now, 0);
}
