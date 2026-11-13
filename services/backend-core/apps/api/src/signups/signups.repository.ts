/**
 * SignupsRepository — plain SQL of the self-signup service (RT-1350 slice 3).
 * Every method runs on the caller's `PoolClient` inside a platform-admin transaction.
 *
 * Plain SQL, not Drizzle table inserts, where the domain role holds column grants only
 * (RT-1249: `users` is INSERTed with four named columns). Tenant, role and membership
 * rows reuse the existing repositories so the signup tenant is created exactly like a
 * platform-admin one (`TenantsRepository`) and an owner membership exactly like an
 * accepted invitation (`InvitationsRepository`).
 *
 * The `restricted` entitlement is inserted in the SAME transaction, whose context is
 * pinned to the new tenant as a platform admin: the 0105 INSERT policy requires both
 * (`app.is_platform_admin = 'true'` and `tenant_id` = the pinned tenant), so the row can
 * neither be refused nor skipped (RT-1350 comment 16773).
 */
import { Injectable } from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { InvitationsRepository } from "../memberships/invitations.repository";
import { TenantsRepository } from "../tenants/tenants.repository";
import type {
  NewPendingSignup,
  PendingSignupRecord,
  RestrictedTenantInput,
  SignupAuditRow,
  SignupLocale,
  SignupUserRecord,
  SignupsStore,
} from "./signups.store";

interface PendingRow {
  id: string;
  email_normalized: string;
  name: string;
  business_name: string;
  locale: SignupLocale | null;
  terms_version: string;
  terms_accepted_at: Date;
  ip_hash: string;
  status: PendingSignupRecord["status"];
  expires_at: Date;
}

const PENDING_COLUMNS = `id, email_normalized, name, business_name, locale, terms_version,
                         terms_accepted_at, ip_hash, status, expires_at`;

function toPending(r: PendingRow): PendingSignupRecord {
  return {
    id: r.id,
    emailNormalized: r.email_normalized,
    name: r.name,
    businessName: r.business_name,
    locale: r.locale,
    termsVersion: r.terms_version,
    termsAcceptedAt: r.terms_accepted_at,
    ipHash: r.ip_hash,
    status: r.status,
    expiresAt: r.expires_at,
  };
}

@Injectable()
export class SignupsRepository implements SignupsStore {
  private readonly tenants = new TenantsRepository();
  private readonly invitations = new InvitationsRepository();

  async findUserByEmail(client: PoolClient, email: string): Promise<SignupUserRecord | null> {
    // Includes a soft-deleted user (so it can be refused); never `password_hash`.
    const r = await client.query<{ id: string; is_platform_admin: boolean; deleted_at: Date | null }>(
      `SELECT id, is_platform_admin, deleted_at FROM users WHERE email = $1 ORDER BY (deleted_at IS NULL) DESC LIMIT 1`,
      [email],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, isPlatformAdmin: row.is_platform_admin, blocked: row.deleted_at !== null };
  }

  async hasCompletedSignupSince(client: PoolClient, email: string, since: Date): Promise<boolean> {
    const r = await client.query(
      `SELECT 1 FROM pending_signups WHERE email_normalized = $1 AND status = 'completed' AND completed_at >= $2 LIMIT 1`,
      [email, since],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async expirePendingByEmail(client: PoolClient, email: string): Promise<void> {
    await client.query(`UPDATE pending_signups SET status = 'expired' WHERE email_normalized = $1 AND status = 'pending'`, [email]);
  }

  async insertPending(client: PoolClient, row: NewPendingSignup): Promise<void> {
    await client.query(
      `INSERT INTO pending_signups
         (id, email_normalized, name, business_name, locale, terms_version, terms_accepted_at,
          ip_hash, token_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $7, $10)`,
      [
        row.id,
        row.emailNormalized,
        row.name,
        row.businessName,
        row.locale,
        row.termsVersion,
        row.termsAcceptedAt,
        row.ipHash,
        row.tokenHash,
        row.expiresAt,
      ],
    );
  }

  async findPendingByTokenHash(client: PoolClient, tokenHash: string): Promise<PendingSignupRecord | null> {
    const r = await client.query<PendingRow>(`SELECT ${PENDING_COLUMNS} FROM pending_signups WHERE token_hash = $1`, [tokenHash]);
    return r.rows[0] ? toPending(r.rows[0]) : null;
  }

  async lockPending(client: PoolClient, id: string): Promise<PendingSignupRecord | null> {
    const r = await client.query<PendingRow>(`SELECT ${PENDING_COLUMNS} FROM pending_signups WHERE id = $1 FOR UPDATE`, [id]);
    return r.rows[0] ? toPending(r.rows[0]) : null;
  }

  async insertUser(client: PoolClient, row: { id: string; email: string; displayName: string }): Promise<void> {
    await this.invitations.insertUser(client, row);
  }

  async insertIdentityLink(
    client: PoolClient,
    row: { providerKey: string; issuer: string; subject: string; userId: string; email: string },
  ): Promise<void> {
    await this.invitations.insertExternalIdentityLink(client, row);
  }

  async createRestrictedTenant(client: PoolClient, input: RestrictedTenantInput): Promise<void> {
    await this.tenants.create(client, { id: input.tenantId, slug: input.slug, name: input.name });
    await this.tenants.seedDefaultRoles(client, input.tenantId);
    const ownerRoleId = await this.invitations.findRoleId(client, input.tenantId, "owner");
    if (ownerRoleId === null) throw new Error("createRestrictedTenant: the owner role was not seeded");
    await this.invitations.createMembership(client, {
      id: input.membershipId,
      tenantId: input.tenantId,
      userId: input.ownerUserId,
      roleId: ownerRoleId,
      storeAccessKind: "all",
    });
    await client.query(
      `INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1::uuid, 'restricted')`,
      [input.tenantId],
    );
  }

  async insertConsent(
    client: PoolClient,
    row: { userId: string; termsVersion: string; acceptedAt: Date; ipHash: string; pendingSignupId: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO user_consents (id, user_id, terms_version, accepted_at, ip_hash, source, pending_signup_id)
       VALUES ($1, $2, $3, $4, $5, 'self_signup', $6)`,
      [newId(), row.userId, row.termsVersion, row.acceptedAt, row.ipHash, row.pendingSignupId],
    );
  }

  async markCompleted(client: PoolClient, id: string, tenantId: string): Promise<void> {
    const r = await client.query(
      `UPDATE pending_signups SET status = 'completed', tenant_id = $2, completed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [id, tenantId],
    );
    if (r.rowCount !== 1) throw new Error("markCompleted: the pending signup was not pending");
  }

  async insertAudit(client: PoolClient, row: SignupAuditRow): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
         (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
       VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6, $7, $8::jsonb)`,
      [newId(), row.actorUserId, row.tenantId, row.action, row.targetType, row.targetId, row.requestId, JSON.stringify(row.metadata)],
    );
  }
}
