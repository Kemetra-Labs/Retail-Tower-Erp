/**
 * Postgres side of the lab-fixture provisioner — RT-1309.
 *
 * Writes go through the domain pool inside the fixture tenant's context
 * (`isPlatformAdmin: false`), using the same `InvitationsRepository` inserts
 * the invitation-acceptance path uses, so the domain role's existing grants
 * and RLS apply unchanged. Identity links are read through the auth-lookup
 * pool, the role that reads `external_identity_links` in production.
 */
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { CASHIER_ROLE_CODE } from "../../pos-cashier-admissions/cashier-eligibility";
import { InvitationsRepository } from "../../memberships/invitations.repository";
import { assertDatabaseGuards, assertLabDatabase } from "./guards";
import type { FixtureIdentity } from "./identity";
import type { FixtureAction, FixtureDbState, LinkRow, ProviderSubject } from "./plan";

/** The seam the provisioner depends on (faked in unit tests). */
export interface FixtureStore {
  assertGuards(): Promise<void>;
  readState(identity: FixtureIdentity, subject: string | null): Promise<FixtureDbState>;
  apply(identity: FixtureIdentity, subject: ProviderSubject, actions: readonly FixtureAction[]): Promise<void>;
}

export interface PgFixtureStoreOptions {
  readonly domain: Pool;
  readonly lookup: Pool;
  readonly tenantId: string;
  readonly storeId: string;
  readonly providerKey: string;
  readonly issuer: string;
}

export class PgFixtureStore implements FixtureStore {
  private readonly repo = new InvitationsRepository();

  constructor(private readonly options: PgFixtureStoreOptions) {}

  async assertGuards(): Promise<void> {
    const { tenantId, storeId } = this.options;
    await this.inTenant((client) => assertDatabaseGuards(client, tenantId, storeId));
    await assertLabDatabase(this.options.lookup);
  }

  async readState(identity: FixtureIdentity, subject: string | null): Promise<FixtureDbState> {
    const tenantPart = await this.inTenant((client) => this.readTenantPart(client, identity));
    const links = await this.readLinks(tenantPart.user?.id ?? null, subject);
    return { ...tenantPart, links };
  }

  async apply(
    identity: FixtureIdentity,
    subject: ProviderSubject,
    actions: readonly FixtureAction[],
  ): Promise<void> {
    if (actions.length === 0) return;
    await this.inTenant(async (client) => {
      const userId = await this.ensureUser(client, identity, actions);
      if (actions.includes("create_link")) {
        await this.repo.insertExternalIdentityLink(client, { ...subject, userId, email: identity.email });
      }
      await this.ensureMembership(client, userId, actions);
    });
  }

  // -------------------------------------------------------------------------

  private inTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.options.domain, { tenantId: this.options.tenantId, isPlatformAdmin: false }, work);
  }

  private async readTenantPart(
    client: PoolClient,
    identity: FixtureIdentity,
  ): Promise<Omit<FixtureDbState, "links">> {
    const users = await client.query<{ id: string; display_name: string | null }>(
      "SELECT id, display_name FROM users WHERE email = $1 AND deleted_at IS NULL",
      [identity.email],
    );
    const row = users.rows[0];
    if (!row) return { user: null, membership: null };
    const user = { id: row.id, displayName: row.display_name };
    return { user, membership: await this.readMembership(client, row.id) };
  }

  private async readMembership(client: PoolClient, userId: string): Promise<FixtureDbState["membership"]> {
    const r = await client.query<{ id: string; code: string; store_access_kind: string; has_store: boolean }>(
      `SELECT m.id, r.code, m.store_access_kind,
              EXISTS (SELECT 1 FROM store_access sa WHERE sa.membership_id = m.id AND sa.store_id = $3) AS has_store
         FROM memberships m
         JOIN roles r ON r.id = m.role_id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL AND m.deleted_at IS NULL`,
      [this.options.tenantId, userId, this.options.storeId],
    );
    const m = r.rows[0];
    if (!m) return null;
    return { id: m.id, roleCode: m.code, storeAccessKind: m.store_access_kind, hasStore: m.has_store };
  }

  private async readLinks(userId: string | null, subject: string | null): Promise<LinkRow[]> {
    const r = await this.options.lookup.query<{
      user_id: string;
      provider_key: string;
      issuer: string;
      subject: string;
      status: string;
    }>(
      `SELECT user_id, provider_key, issuer, subject, status
         FROM external_identity_links
        WHERE user_id = $1::uuid
           OR (provider_key = $2 AND issuer = $3 AND subject = $4)`,
      [userId, this.options.providerKey, this.options.issuer, subject],
    );
    return r.rows.map((l) => ({
      userId: l.user_id,
      providerKey: l.provider_key,
      issuer: l.issuer,
      subject: l.subject,
      status: l.status,
    }));
  }

  private async ensureUser(
    client: PoolClient,
    identity: FixtureIdentity,
    actions: readonly FixtureAction[],
  ): Promise<string> {
    if (actions.includes("create_user")) {
      const id = newId();
      await this.repo.insertUser(client, { id, email: identity.email, displayName: identity.displayName });
      return id;
    }
    const existing = await this.repo.findUserByEmail(client, identity.email);
    if (!existing) throw new Error("fixture user disappeared between read and write");
    return existing.id;
  }

  private async ensureMembership(client: PoolClient, userId: string, actions: readonly FixtureAction[]): Promise<void> {
    const { tenantId, storeId } = this.options;
    if (actions.includes("create_membership")) {
      const roleId = await this.repo.findRoleId(client, tenantId, CASHIER_ROLE_CODE);
      if (!roleId) throw new Error(`the tenant has no ${CASHIER_ROLE_CODE} role`);
      const id = newId();
      await this.repo.createMembership(client, { id, tenantId, userId, roleId, storeAccessKind: "specific" });
      await this.repo.insertStoreAccessRows(client, id, tenantId, [storeId]);
      return;
    }
    if (actions.includes("grant_store_access")) {
      const membership = await this.readMembership(client, userId);
      if (!membership) throw new Error("fixture membership disappeared between read and write");
      await this.repo.insertStoreAccessRows(client, membership.id, tenantId, [storeId]);
    }
  }
}
