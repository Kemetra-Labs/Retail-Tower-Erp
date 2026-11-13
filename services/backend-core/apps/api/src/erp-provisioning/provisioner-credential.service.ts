/**
 * ProvisionerCredentialService — RT-1358: the platform admin's issue, rotate and
 * revoke of the provisioner credential, one per ERP host label (OD-12).
 *
 * Each call is ONE platform-admin transaction (`runWithTenantContext`, never the
 * provisioner context) that changes `auth_tokens` (the secret hash, scope
 * `connector_provisioner`, the system actor, no tenant) and
 * `erp_provisioner_credential` together and writes its audit row. The secret is
 * returned once and is in no audit row, log or store. Expiry is set here: 30 days.
 *
 * "Live" = unrevoked AND unexpired. An unrevoked but EXPIRED row would block the
 * one-live-row-per-host index (`uq_erp_provisioner_credential_live_host` has no
 * expiry in its predicate), so issue revokes it first, in the same transaction,
 * and rotate and revoke treat it as not live.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import type { Principal } from "../auth/auth.guard";
import { PG_POOL } from "../auth/database-pools";
import { resolveDeploymentEnvironment } from "../connector/deployment-environment";
import { MembershipRepository } from "../context/membership.repository";
import { requirePlatformAdminSession } from "../auth/require-platform-admin";
import { AUDIT, insertProvisioningAudit } from "./provisioning-audit";
import { PROVISIONER_CREDENTIAL_EXPIRY_DAYS, SYSTEM_ACTOR_USER_ID } from "./provisioning.config";

export interface IssuedProvisionerCredentialBody {
  readonly credentialId: string;
  readonly hostLabel: string;
  readonly secret: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface RevokedProvisionerCredentialBody {
  readonly credentialId: string;
  readonly hostLabel: string;
  readonly revokedAt: string;
  readonly alreadyRevoked: boolean;
}

export interface CredentialActionInput {
  readonly principal: Principal | undefined;
  readonly hostLabel: string;
  readonly requestId: string | null;
}

interface CredentialRow {
  readonly id: string;
  readonly token_id: string;
  readonly revoked_at: Date | null;
  readonly expires_at: Date;
  readonly expired: boolean;
}

const LIVE_UNIQUE = "uq_erp_provisioner_credential_live_host";

function notFound(): NotFoundException {
  return new NotFoundException({ code: "not_found", message: "Not Found" });
}

@Injectable()
export class ProvisionerCredentialService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  async issue(input: CredentialActionInput): Promise<IssuedProvisionerCredentialBody> {
    const actor = await requirePlatformAdminSession(this.memberships, input.principal);
    const environment = this.requireEnvironment();
    return await this.inAdminTx(async (client) => {
      const current = await this.lockUnrevoked(client, input.hostLabel);
      if (current !== undefined) {
        if (!current.expired) throw new ConflictException({ code: "conflict", message: "A live credential already exists for this host label; rotate it." });
        await this.revokeRow(client, current, actor);
        await insertProvisioningAudit(client, {
          actorUserId: actor,
          tenantId: null,
          action: AUDIT.provisionerExpiredRevoked,
          targetType: "erp_provisioner_credential",
          targetId: current.id,
          requestId: input.requestId,
          metadata: { host_label: input.hostLabel },
        });
      }
      const issued = await this.insertCredential(client, input.hostLabel, environment, actor);
      await insertProvisioningAudit(client, {
        actorUserId: actor,
        tenantId: null,
        action: AUDIT.provisionerIssued,
        targetType: "erp_provisioner_credential",
        targetId: issued.credentialId,
        requestId: input.requestId,
        metadata: { host_label: input.hostLabel, credential_id: issued.credentialId },
      });
      return issued;
    });
  }

  async rotate(input: CredentialActionInput): Promise<IssuedProvisionerCredentialBody> {
    const actor = await requirePlatformAdminSession(this.memberships, input.principal);
    const environment = this.requireEnvironment();
    return await this.inAdminTx(async (client) => {
      const current = await this.lockUnrevoked(client, input.hostLabel);
      if (current === undefined || current.expired) throw notFound();
      await this.revokeRow(client, current, actor);
      const issued = await this.insertCredential(client, input.hostLabel, environment, actor);
      await insertProvisioningAudit(client, {
        actorUserId: actor,
        tenantId: null,
        action: AUDIT.provisionerRotated,
        targetType: "erp_provisioner_credential",
        targetId: issued.credentialId,
        requestId: input.requestId,
        metadata: { host_label: input.hostLabel, credential_id: issued.credentialId, revoked_credential_id: current.id },
      });
      return issued;
    });
  }

  async revoke(input: CredentialActionInput): Promise<RevokedProvisionerCredentialBody> {
    const actor = await requirePlatformAdminSession(this.memberships, input.principal);
    return await this.inAdminTx(async (client) => {
      const latest = await client.query<{ id: string; token_id: string; revoked_at: Date | null; expired: boolean }>(
        `SELECT c.id, c.token_id, c.revoked_at, (t.expires_at <= now()) AS expired
           FROM erp_provisioner_credential c JOIN auth_tokens t ON t.id = c.token_id
          WHERE c.host_label = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 1 FOR UPDATE OF c`,
        [input.hostLabel],
      );
      const row = latest.rows[0];
      if (row === undefined) throw notFound();
      const base = { actorUserId: actor, tenantId: null, targetType: "erp_provisioner_credential", targetId: row.id, requestId: input.requestId } as const;
      if (row.revoked_at !== null) {
        await insertProvisioningAudit(client, { ...base, action: AUDIT.provisionerRevokeNoop, metadata: { host_label: input.hostLabel, credential_id: row.id } });
        return { credentialId: row.id, hostLabel: input.hostLabel, revokedAt: row.revoked_at.toISOString(), alreadyRevoked: true };
      }
      const revokedAt = await this.revokeRow(client, { id: row.id, token_id: row.token_id }, actor);
      if (row.expired) {
        // Already unusable by expiry: tidy the row so it frees the host label, report a no-op.
        await insertProvisioningAudit(client, { ...base, action: AUDIT.provisionerRevokeNoop, metadata: { host_label: input.hostLabel, credential_id: row.id, expired: true } });
        return { credentialId: row.id, hostLabel: input.hostLabel, revokedAt: revokedAt.toISOString(), alreadyRevoked: true };
      }
      await insertProvisioningAudit(client, { ...base, action: AUDIT.provisionerRevoked, metadata: { host_label: input.hostLabel, credential_id: row.id } });
      return { credentialId: row.id, hostLabel: input.hostLabel, revokedAt: revokedAt.toISOString(), alreadyRevoked: false };
    });
  }

  private requireEnvironment(): string {
    const environment = resolveDeploymentEnvironment();
    // Fail closed: a credential is bound to the deployment it is issued for.
    if (environment === null) throw new Error("DEPLOYMENT_ENVIRONMENT is not set");
    return environment;
  }

  private async inAdminTx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await runWithTenantContext(this.pool, { tenantId: null, isPlatformAdmin: true }, work);
    } catch (err) {
      const pg = err as { code?: string; constraint?: string };
      if (pg.code === "23505" && pg.constraint === LIVE_UNIQUE) {
        throw new ConflictException({ code: "conflict", message: "A live credential already exists for this host label; rotate it." });
      }
      throw err;
    }
  }

  private async lockUnrevoked(client: PoolClient, hostLabel: string): Promise<CredentialRow | undefined> {
    const r = await client.query<CredentialRow>(
      `SELECT c.id, c.token_id, c.revoked_at, t.expires_at, (t.expires_at <= now()) AS expired
         FROM erp_provisioner_credential c JOIN auth_tokens t ON t.id = c.token_id
        WHERE c.host_label = $1 AND c.revoked_at IS NULL FOR UPDATE OF c`,
      [hostLabel],
    );
    return r.rows[0];
  }

  private async revokeRow(client: PoolClient, row: { id: string; token_id: string }, actor: string): Promise<Date> {
    const r = await client.query<{ revoked_at: Date }>(
      `UPDATE erp_provisioner_credential SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING revoked_at`,
      [row.id, actor],
    );
    await client.query(`UPDATE auth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [row.token_id]);
    return r.rows[0]!.revoked_at;
  }

  private async insertCredential(client: PoolClient, hostLabel: string, environment: string, actor: string): Promise<IssuedProvisionerCredentialBody> {
    const raw = generateRawToken();
    const tokenId = newId();
    const credentialId = newId();
    const token = await client.query<{ issued_at: Date; expires_at: Date }>(
      `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
       VALUES ($1, $2, NULL, $3, 'connector_provisioner', now() + ($4 || ' days')::interval)
       RETURNING issued_at, expires_at`,
      [tokenId, hashToken(raw), SYSTEM_ACTOR_USER_ID, String(PROVISIONER_CREDENTIAL_EXPIRY_DAYS)],
    );
    await client.query(
      `INSERT INTO erp_provisioner_credential (id, host_label, environment, token_id, issued_by) VALUES ($1, $2, $3, $4, $5)`,
      [credentialId, hostLabel, environment, tokenId, actor],
    );
    return {
      credentialId,
      hostLabel,
      secret: raw,
      issuedAt: token.rows[0]!.issued_at.toISOString(),
      expiresAt: token.rows[0]!.expires_at.toISOString(),
    };
  }
}
