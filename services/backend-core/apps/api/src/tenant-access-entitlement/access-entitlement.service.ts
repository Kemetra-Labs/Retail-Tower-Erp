/**
 * AccessEntitlementService — RT-1353: the tenant access state
 * (`restricted` / `unrestricted`, `tenant_access_entitlements`, 0105).
 *
 *   - `read`: the Console banner read. No row = `unrestricted`.
 *   - `requestUnlock` / `markProvisioned`: the platform-admin actions of
 *     `tenant-access-entitlement.openapi.yaml`. Each runs in ONE transaction in
 *     the target tenant's context as a platform admin (the RLS write policy),
 *     locks the row, decides, writes and audits. A replay and a no-op change
 *     nothing and audit nothing.
 *
 * The unlock request is the durable provisioning trigger RT-1352 will consume;
 * it does NOT lift the restriction. Only `markProvisioned` (the manual stand-in
 * for the provisioning-success signal) moves the tenant to `unrestricted`.
 *
 * Audit rows hold ids and a source label only (§XIV): the actor, the tenant.
 */
import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runWithTenantContext, type TenantAccessState } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import type { Principal } from "../auth/auth.guard";
import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";

const UNLOCK_REQUESTED_ACTION = "tenant.access.unlock_requested";
const PROVISIONED_ACTION = "tenant.access.provisioned";
const AUDIT_TARGET = "tenant_access_entitlement";

/** The wire projection (snake_case, never a DB row). */
export interface TenantAccessEntitlementBody {
  readonly tenant_id: string;
  readonly state: TenantAccessState;
  readonly unlock_requested_at: string | null;
  readonly provisioned_at: string | null;
}

type AccessChangeOutcome = "requested" | "already_requested" | "provisioned" | "already_unrestricted";

export interface TenantAccessChangeBody {
  readonly outcome: AccessChangeOutcome;
  readonly entitlement: TenantAccessEntitlementBody;
}

interface AccessRow {
  readonly state: TenantAccessState;
  readonly unlock_requested_at: Date | null;
  readonly provisioned_at: Date | null;
}

function bodyOf(tenantId: string, row: AccessRow | null): TenantAccessEntitlementBody {
  return {
    tenant_id: tenantId,
    state: row?.state ?? "unrestricted",
    unlock_requested_at: row?.unlock_requested_at?.toISOString() ?? null,
    provisioned_at: row?.provisioned_at?.toISOString() ?? null,
  };
}

const SELECT_LOCKED = `SELECT state, unlock_requested_at, provisioned_at
                         FROM tenant_access_entitlements WHERE tenant_id = $1::uuid FOR UPDATE`;

/** Mark provisioned without a prior unlock request, or for a tenant with no restriction (409). */
class UnlockNotRequestedError extends HttpException {
  constructor() {
    super({ code: "unlock_not_requested", message: "An unlock must be requested before provisioning is recorded." }, 409);
  }
}

export interface PlatformActionInput {
  readonly principal: Principal | undefined;
  readonly tenantId: string;
  readonly requestId: string | null;
}

@Injectable()
export class AccessEntitlementService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** The tenant's state inside its own context; no row = `unrestricted`. */
  async read(tenantId: string): Promise<TenantAccessEntitlementBody> {
    return await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const r = await client.query<AccessRow>(
        `SELECT state, unlock_requested_at, provisioned_at FROM tenant_access_entitlements WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      return bodyOf(tenantId, r.rows[0] ?? null);
    });
  }

  /** Record the unlock request (does NOT lift the restriction). */
  async requestUnlock(input: PlatformActionInput): Promise<TenantAccessChangeBody> {
    const actorUserId = await this.requirePlatformAdmin(input.principal);
    return await this.inPlatformTx(input.tenantId, async (client) => {
      const row = await lockRow(client, input.tenantId);
      if (row === null || row.state === "unrestricted") {
        return { outcome: "already_unrestricted", entitlement: bodyOf(input.tenantId, row) };
      }
      if (row.unlock_requested_at !== null) {
        return { outcome: "already_requested", entitlement: bodyOf(input.tenantId, row) };
      }
      const updated = await client.query<AccessRow>(
        `UPDATE tenant_access_entitlements
            SET unlock_requested_at = now(), unlock_requested_by_user_id = $2::uuid
          WHERE tenant_id = $1::uuid
          RETURNING state, unlock_requested_at, provisioned_at`,
        [input.tenantId, actorUserId],
      );
      await insertAudit(client, input, actorUserId, UNLOCK_REQUESTED_ACTION, {});
      return { outcome: "requested", entitlement: bodyOf(input.tenantId, updated.rows[0]!) };
    });
  }

  /** Record the provisioning result by hand: the only transition to `unrestricted`. */
  async markProvisioned(input: PlatformActionInput): Promise<TenantAccessChangeBody> {
    const actorUserId = await this.requirePlatformAdmin(input.principal);
    return await this.inPlatformTx(input.tenantId, async (client) => {
      const row = await lockRow(client, input.tenantId);
      if (row === null) throw new UnlockNotRequestedError();
      if (row.state === "unrestricted") {
        return { outcome: "already_unrestricted", entitlement: bodyOf(input.tenantId, row) };
      }
      if (row.unlock_requested_at === null) throw new UnlockNotRequestedError();
      const updated = await client.query<AccessRow>(
        `UPDATE tenant_access_entitlements
            SET state = 'unrestricted', provisioned_at = now(), provisioned_by_user_id = $2::uuid,
                provisioning_source = 'manual_platform'
          WHERE tenant_id = $1::uuid
          RETURNING state, unlock_requested_at, provisioned_at`,
        [input.tenantId, actorUserId],
      );
      await insertAudit(client, input, actorUserId, PROVISIONED_ACTION, { source: "manual_platform" });
      return { outcome: "provisioned", entitlement: bodyOf(input.tenantId, updated.rows[0]!) };
    });
  }

  private async requirePlatformAdmin(principal: Principal | undefined): Promise<string> {
    if (principal?.kind !== "session") throw new ForbiddenException({ code: "forbidden", message: "Platform admin required" });
    if (!(await this.memberships.isPlatformAdmin(principal.userId))) {
      throw new ForbiddenException({ code: "forbidden", message: "Platform admin required" });
    }
    return principal.userId;
  }

  /** The target tenant's context as a platform admin; an unknown tenant is the 404. */
  private async inPlatformTx<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: true }, async (client) => {
      const tenant = await client.query(`SELECT 1 FROM tenants WHERE id = $1::uuid`, [tenantId]);
      if (tenant.rowCount === 0) throw new NotFoundException({ code: "not_found", message: "Not Found" });
      return await work(client);
    });
  }
}

async function lockRow(client: PoolClient, tenantId: string): Promise<AccessRow | null> {
  const r = await client.query<AccessRow>(SELECT_LOCKED, [tenantId]);
  return r.rows[0] ?? null;
}

async function insertAudit(
  client: PoolClient,
  input: PlatformActionInput,
  actorUserId: string,
  action: string,
  metadata: Record<string, string>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, NULL, $4, $5, $3, $6, $7::jsonb)`,
    [newId(), actorUserId, input.tenantId, action, AUDIT_TARGET, input.requestId, JSON.stringify(metadata)],
  );
}
