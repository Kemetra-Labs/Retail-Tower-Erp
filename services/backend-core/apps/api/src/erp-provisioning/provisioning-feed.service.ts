/**
 * ProvisioningFeedService — RT-1358: the four operations behind
 * `connectorProvisionerBearer` (provisioning-feed.yaml).
 *
 *   pullRequests     oldest first; requested, expired-lease and past-backoff only
 *   acknowledgeStep  takes or renews the lease, records the step, moves the status
 *   issueCredential  the tenant connector secret, once, lease-bound, managed-only
 *   reportOutcome    the terminal outcome; `succeeded` waits for the first heartbeat
 *
 * Every transaction runs in the provisioner context (`runAsProvisioner`), locks
 * the request row FOR UPDATE and writes only through the repository. Tenant
 * scoped tables (auth_tokens, connector_registration, audit, stores) are reached
 * by pointing the transaction at the tenant of the locked request row.
 * Lease ownership is the host label of the credential, never a body field.
 */
import { BadRequestException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/database-pools";
import { resolveDeploymentEnvironment } from "../connector/deployment-environment";
import type { OutcomeBody, ProvisioningRequestItem, PullQuery, StepAckBody } from "./dto/provisioning.dto";
import { AUDIT, insertProvisioningAudit } from "./provisioning-audit";
import { DEFAULT_LANGUAGE, LOCALE_V1, LEASE_TTL_MS, MANAGED_CREDENTIAL_EXPIRY_DAYS, SYSTEM_ACTOR_USER_ID } from "./provisioning.config";
import { pointAtTenant, runAsProvisioner } from "./provisioner-context";
import {
  appendStep,
  countSitesForHost,
  countTransientFailures,
  findStep,
  hasOtherLiveLease,
  lockRequest,
  pullOfferable,
  type RequestRow,
  writeFromPatch,
  writeRequest,
} from "./provisioning-request.repository";
import {
  decideOutcome,
  decideStepAck,
  leaseIsLive,
  SITE_CEILING_PER_HOST,
  type ErrorClass,
} from "./provisioning-state";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** An ERPNext Company name is at most 140 characters; the provisioner appends " - RT" to a store name for its warehouse. */
const MAX_LEGAL_NAME = 140;
const MAX_STORE_DISPLAY_NAME = 135;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const START_CURSOR = { createdAt: new Date(0), id: NIL_UUID };

/** Statuses in which the provisioner may ask for the tenant credential. */
const ISSUE_STATUSES = ["site_created", "erp_configured", "connector_installed", "credential_bound"] as const;

interface TenantDetail {
  readonly legalName: string;
  language: string | null;
  readonly stores: Array<{ storeId: string; displayName: string }>;
}

export interface IssuedCredential {
  readonly credentialId: string;
  readonly registrationId: string;
  readonly secret: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly rotated: boolean;
}

export type Clock = () => Date;

class LeaseLostError extends HttpException {
  constructor() {
    super({ code: "lease_lost", message: "The lease on this request is not held by the caller." }, 409);
  }
}
class KeyConflictError extends HttpException {
  constructor() {
    super({ code: "idempotency_key_conflict", message: "The Idempotency-Key was used with a different body." }, 409);
  }
}

function stepAuditAction(step: string, outcome: string, alert: boolean): (typeof AUDIT)[keyof typeof AUDIT] {
  if (step === "claimed") return AUDIT.claimed;
  if (alert) return AUDIT.failed;
  return outcome === "failed_transient" || outcome === "capacity" ? AUDIT.retryScheduled : AUDIT.stepRecorded;
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: "not_found", message: "Not Found" });
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    const at = typeof v.t === "string" ? new Date(v.t) : null;
    const inRange = at !== null && at.getTime() >= 0 && at.getTime() <= Date.UTC(2200, 0, 1);
    if (at && inRange && typeof v.i === "string" && UUID_RE.test(v.i)) {
      return { createdAt: at, id: v.i };
    }
  } catch {
    // falls through to the validation error
  }
  throw new BadRequestException({ code: "validation_error", message: "The cursor cannot be served; pull again from the start." });
}

async function heartbeatSeen(client: PoolClient, registrationId: string | null): Promise<boolean> {
  if (registrationId === null) return false;
  const r = await client.query(`SELECT 1 FROM connector_health WHERE connector_registration_id = $1::uuid AND last_seen_at IS NOT NULL`, [registrationId]);
  return (r.rowCount ?? 0) > 0;
}

@Injectable()
export class ProvisioningFeedService {
  private clock: Clock = () => new Date();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Test seam: a fixed clock. */
  useClock(clock: Clock): void {
    this.clock = clock;
  }

  async pullRequests(host: string, query: PullQuery): Promise<{ items: ProvisioningRequestItem[]; cursor: string }> {
    const now = this.clock();
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const environment = resolveDeploymentEnvironment();
    const page = await runAsProvisioner(this.pool, async (client) => {
      const sites = await countSitesForHost(client, host);
      return await pullOfferable(client, { now, after, limit: query.limit, withholdNewTenants: sites >= SITE_CEILING_PER_HOST });
    });
    const rows = page.rows.map((row) => ({ row }));
    const details = await this.tenantDetails(rows.map((r) => r.row.tenantId));
    const items = rows.map(({ row }): ProvisioningRequestItem => {
      const detail = details.get(row.tenantId);
      return {
        provisioningRequestId: row.id,
        kind: row.kind,
        tenantId: row.tenantId,
        generation: row.generation,
        siteName: row.siteName,
        template: { templateId: row.templateId, templateVersion: row.templateVersion },
        locale: { ...LOCALE_V1, language: detail?.language ?? DEFAULT_LANGUAGE },
        ...(row.kind === "tenant.provision" && detail?.legalName ? { legalName: detail.legalName.slice(0, MAX_LEGAL_NAME) } : {}),
        connectorRegistrationId: row.connectorRegistrationId ?? NIL_UUID,
        environment: environment ?? "dev",
        attemptFloor: row.attemptFloor,
        stores: detail?.stores ?? [],
      };
    });
    const last = rows[rows.length - 1]?.row;
    const cursor = last ? encodeCursor(last.createdAt, last.id) : encodeCursor((after ?? START_CURSOR).createdAt, (after ?? START_CURSOR).id);
    return { items, cursor };
  }

  /**
   * The business name, the stores that exist now and the completed signup's locale of each tenant, in ONE
   * read-only platform-admin transaction with three batched queries (never the provisioner context, and no
   * round trip per request).
   */
  private async tenantDetails(tenantIds: readonly string[]): Promise<Map<string, TenantDetail>> {
    const out = new Map<string, TenantDetail>();
    if (tenantIds.length === 0) return out;
    const ids = [...new Set(tenantIds)];
    await runWithTenantContext(this.pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
      const names = await client.query<{ id: string; name: string }>(`SELECT id, name FROM tenants WHERE id = ANY($1::uuid[])`, [ids]);
      for (const t of names.rows) out.set(t.id, { legalName: t.name, language: null, stores: [] });
      const stores = await client.query<{ tenant_id: string; id: string; name: string }>(
        `SELECT tenant_id, id, name FROM stores WHERE tenant_id = ANY($1::uuid[]) AND deleted_at IS NULL AND is_active ORDER BY created_at, id`,
        [ids],
      );
      for (const st of stores.rows) {
        const d = out.get(st.tenant_id);
        if (d && d.stores.length < 500) d.stores.push({ storeId: st.id, displayName: st.name.slice(0, MAX_STORE_DISPLAY_NAME) });
      }
      const locales = await client.query<{ tenant_id: string; locale: string | null }>(
        `SELECT tenant_id, locale FROM pending_signups WHERE tenant_id = ANY($1::uuid[]) AND status = 'completed' AND locale IS NOT NULL`,
        [ids],
      );
      for (const l of locales.rows) {
        const d = out.get(l.tenant_id);
        if (d && (l.locale === "ar" || l.locale === "en")) d.language = l.locale;
      }
    });
    return out;
  }

  async acknowledgeStep(host: string, requestId: string, body: StepAckBody): Promise<{ result: { requestId: string; step: string; leaseExpiresAt: string }; replayed: boolean }> {
    const now = this.clock();
    return await runAsProvisioner(this.pool, async (client) => {
      const row = await lockRequest(client, requestId);
      if (row === null) throw notFound();

      const existing = await findStep(client, requestId, body.step, body.attempt);
      if (existing !== null) {
        if (existing.outcome !== body.outcome) throw new KeyConflictError();
        // A replay is the same caller's: the stored step belongs to this request's current lease (or the
        // lease is gone). Another host never learns a step outcome or a lease expiry.
        const sameLease = row.leaseId === null || existing.leaseId === row.leaseId;
        if (!sameLease || (row.leaseHolder !== null && row.leaseHolder !== host)) throw new LeaseLostError();
        return { result: { requestId, step: body.step, leaseExpiresAt: (row.leaseExpiresAt ?? now).toISOString() }, replayed: true };
      }

      if (body.step === "claimed" && !(leaseIsLive(row, now) && row.leaseHolder === host)) {
        await this.assertMayClaim(client, host, row, now);
      }

      return await this.applyStep(client, row, host, body, now);
    });
  }

  /** Decide the acknowledgement against the locked row, then write the request, the step log and the audit row. */
  private async applyStep(
    client: PoolClient,
    row: RequestRow,
    host: string,
    body: StepAckBody,
    now: Date,
  ): Promise<{ result: { requestId: string; step: string; leaseExpiresAt: string }; replayed: boolean }> {
    const requestId = row.id;
    await pointAtTenant(client, row.tenantId);
    const credentialIssued = await this.credentialIssued(client, row.connectorRegistrationId);
    const priorTransientFailures = body.outcome === "failed_transient" ? await countTransientFailures(client, row.id, body.step, row.generation) : 0;
    const decision = decideStepAck(row, {
      host,
      step: body.step,
      outcome: body.outcome,
      attempt: body.attempt,
      reason: body.reason ?? null,
      now,
      priorTransientFailures,
      credentialIssued,
    });
    if (decision.kind === "lease_lost") throw new LeaseLostError();
    if (decision.kind === "idempotency_key_conflict") throw new KeyConflictError();
    if (decision.kind === "invalid_transition") {
      throw new BadRequestException({ code: "validation_error", message: "This step is not allowed in the request's current state." });
    }

    const next = await writeRequest(client, row, writeFromPatch(decision.patch, host), now, LEASE_TTL_MS);
    await appendStep(client, row, {
      step: body.step,
      outcome: body.outcome,
      attempt: body.attempt,
      errorClass: (body.errorClass ?? null) as ErrorClass | null,
      reason: body.reason ?? null,
      detail: body.detail ?? null,
      leaseId: next.leaseId,
    });
    await insertProvisioningAudit(client, {
      actorUserId: SYSTEM_ACTOR_USER_ID,
      actorLabel: `provisioner:${host}`,
      tenantId: row.tenantId,
      action: stepAuditAction(body.step, body.outcome, decision.patch.alert),
      targetType: "erp_provisioning_request",
      targetId: row.id,
      metadata: { step: body.step, outcome: body.outcome, attempt: body.attempt, status: next.status },
    });
    return { result: { requestId, step: body.step, leaseExpiresAt: (next.leaseExpiresAt ?? now).toISOString() }, replayed: false };
  }

  /** One live lease per host label, and the site ceiling as defense in depth for the pull-side one (OD-10). */
  private async assertMayClaim(client: PoolClient, host: string, row: RequestRow, now: Date): Promise<void> {
    if (await hasOtherLiveLease(client, host, row.id, now)) throw new LeaseLostError();
    const startsNewSite = row.kind === "tenant.provision" && row.status === "requested";
    if (startsNewSite && (await countSitesForHost(client, host)) >= SITE_CEILING_PER_HOST) throw new LeaseLostError();
  }

  /**
   * The tenant connector credential, once. Any call that is not for a managed
   * registration under the caller's live lease is the same `null` (a 404), with
   * no side effect.
   */
  async issueCredential(host: string, requestId: string, httpRequestId: string | null): Promise<IssuedCredential | null> {
    const now = this.clock();
    return await runAsProvisioner(this.pool, async (client) => {
      const row = await lockRequest(client, requestId);
      if (
        row === null ||
        row.connectorRegistrationId === null ||
        !leaseIsLive(row, now) ||
        row.leaseHolder !== host ||
        row.leaseId === null ||
        !(ISSUE_STATUSES as readonly string[]).includes(row.status)
      ) {
        return null;
      }
      await pointAtTenant(client, row.tenantId);
      const reg = await client.query<{ managed_by: string | null; disabled_at: Date | null }>(
        `SELECT managed_by, disabled_at FROM connector_registration WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
        [row.connectorRegistrationId, row.tenantId],
      );
      const registration = reg.rows[0];
      if (!registration || registration.managed_by !== "provisioner" || registration.disabled_at !== null) return null;

      const live = await client.query<{ id: string }>(
        `SELECT id FROM auth_tokens
          WHERE connector_registration_id = $1::uuid AND scope = 'connector' AND revoked_at IS NULL FOR UPDATE`,
        [row.connectorRegistrationId],
      );
      let rotated = false;
      if (live.rows.length > 0) {
        // A repeat is a rotation only while the registration has never been presented.
        if (await heartbeatSeen(client, row.connectorRegistrationId)) return null;
        await client.query(
          `UPDATE auth_tokens SET revoked_at = now() WHERE connector_registration_id = $1::uuid AND scope = 'connector' AND revoked_at IS NULL`,
          [row.connectorRegistrationId],
        );
        rotated = true;
      }

      const raw = generateRawToken();
      const credentialId = newId();
      const ins = await client.query<{ issued_at: Date; expires_at: Date }>(
        `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id)
         VALUES ($1, $2, $3, $4, 'connector', now() + ($5 || ' days')::interval, $6)
         RETURNING issued_at, expires_at`,
        [credentialId, hashToken(raw), row.tenantId, SYSTEM_ACTOR_USER_ID, String(MANAGED_CREDENTIAL_EXPIRY_DAYS), row.connectorRegistrationId],
      );
      await insertProvisioningAudit(client, {
        actorUserId: SYSTEM_ACTOR_USER_ID,
        actorLabel: `provisioner:${host}`,
        tenantId: row.tenantId,
        action: AUDIT.credentialIssued,
        targetType: "connector_registration",
        targetId: row.connectorRegistrationId,
        requestId: httpRequestId,
        metadata: { provisioning_request_id: row.id, lease_id: row.leaseId, credential_id: credentialId, rotated },
      });
      return {
        credentialId,
        registrationId: row.connectorRegistrationId,
        secret: raw,
        issuedAt: ins.rows[0]!.issued_at.toISOString(),
        expiresAt: ins.rows[0]!.expires_at.toISOString(),
        rotated,
      };
    });
  }

  async reportOutcome(host: string, requestId: string, body: OutcomeBody): Promise<{ requestId: string; outcome: string; replayed: boolean }> {
    const now = this.clock();
    return await runAsProvisioner(this.pool, async (client) => {
      const row = await lockRequest(client, requestId);
      if (row === null) throw notFound();
      await pointAtTenant(client, row.tenantId);
      const seen = await heartbeatSeen(client, row.connectorRegistrationId);
      const reportedBy = row.leaseHolder === null ? await this.reportedBy(client, row.id) : null;
      const decision = decideOutcome(row, { host, outcome: body.outcome, reason: body.reason ?? null, now, heartbeatSeen: seen, reportedBy });
      const done = (replayed: boolean): { requestId: string; outcome: string; replayed: boolean } => ({ requestId, outcome: body.outcome, replayed });
      const base = { actorUserId: SYSTEM_ACTOR_USER_ID, actorLabel: `provisioner:${host}`, tenantId: row.tenantId, targetType: "erp_provisioning_request", targetId: row.id } as const;

      switch (decision.kind) {
        case "replay":
          return done(true);
        case "lease_lost":
          throw new LeaseLostError();
        case "invalid_transition":
          throw new BadRequestException({ code: "validation_error", message: "This outcome is not allowed in the request's current state." });
        case "fail_permanent": {
          await writeRequest(client, row, { status: "failed_permanent", lease: "end", lastErrorClass: decision.errorClass, lastReason: decision.reason }, now, 0);
          await insertProvisioningAudit(client, { ...base, action: AUDIT.failed, metadata: { outcome: decision.errorClass } });
          return done(false);
        }
        case "hold_for_heartbeat":
        case "finish_succeeded": {
          await this.assertResult(client, row, body);
          if (decision.kind === "hold_for_heartbeat") {
            // The request keeps no holder while it waits: the host stays in the audit row.
            await writeRequest(client, row, { lease: "clear", lastErrorClass: null, lastReason: null }, now, 0);
            await insertProvisioningAudit(client, { ...base, action: AUDIT.stepRecorded, metadata: { outcome: "succeeded_reported", heartbeat: false, host } });
          } else {
            await writeRequest(client, row, { status: "succeeded", lease: "clear", provisionedHost: host, lastErrorClass: null, lastReason: null }, now, 0);
            await insertProvisioningAudit(client, { ...base, action: AUDIT.succeeded, metadata: { heartbeat: true, host } });
          }
          return done(false);
        }
      }
    });
  }

  /** The host that reported `succeeded` while the request waits for its heartbeat (audit trail, no holder on the row). */
  private async reportedBy(client: PoolClient, requestId: string): Promise<string | null> {
    const r = await client.query<{ host: string | null }>(
      `SELECT metadata->>'host' AS host FROM audit_events
        WHERE target_id = $1::uuid AND action = 'erp.provisioning.step_recorded' AND metadata->>'outcome' = 'succeeded_reported'
        ORDER BY occurred_at DESC LIMIT 1`,
      [requestId],
    );
    return r.rows[0]?.host ?? null;
  }

  /** `result` must describe this request: its site, its template, and only stores of this tenant. */
  private async assertResult(client: PoolClient, row: RequestRow, body: OutcomeBody): Promise<void> {
    const result = body.result;
    if (!result || result.siteName !== row.siteName || result.templateVersion !== row.templateVersion) {
      throw new BadRequestException({ code: "validation_error", message: "The result does not match this request." });
    }
    if (result.stores.length === 0) return;
    const ids = result.stores.map((s) => s.storeId);
    const known = await client.query<{ id: string }>(`SELECT id FROM stores WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`, [row.tenantId, ids]);
    if (known.rowCount !== new Set(ids).size) {
      throw new BadRequestException({ code: "validation_error", message: "The result names a store that is not this tenant's." });
    }
  }

  private async credentialIssued(client: PoolClient, registrationId: string | null): Promise<boolean> {
    if (registrationId === null) return false;
    const r = await client.query(
      `SELECT 1 FROM auth_tokens WHERE connector_registration_id = $1::uuid AND scope = 'connector' AND revoked_at IS NULL LIMIT 1`,
      [registrationId],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
