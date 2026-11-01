/**
 * invitations.accept-new-user.spec.ts — RT-937 item 4, real Postgres (Testcontainers).
 *
 * `InvitationsService.acceptInvitation` for a NEW invitee, against the real schema,
 * with only the identity provider faked (the port and its token verifier):
 *
 *   1. user + external identity link + membership + store_access are written in
 *      ONE transaction, the invitation is marked accepted by the NEW user, the
 *      user has NO local password hash, and a session exists for that user only;
 *   2. replaying the same token is the opaque 400 with ZERO writes and no second
 *      provider call;
 *   3. a link that already exists (taken subject) rolls the WHOLE acceptance back:
 *      no user, no membership, the invitation still pending, no session;
 *   4. an EXISTING user gains the membership only: no session, no provider call.
 *
 * Like the existing-user spec this runs on the admin pool, so row-level security and
 * the domain-role grants are NOT exercised here. Those are covered by the API boot
 * grant check (`invitation-acceptance.grants.ts`, verified against the grants script
 * by grant-fragments.spec) and, per environment, by
 * docs/operations/sql/invitation-acceptance-domain-grants.sql.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { EMAIL_JOB_ENQUEUER } from "../../src/auth/email-job.enqueuer";
import { EXTERNAL_CREDENTIAL_PORT } from "../../src/auth/external-credential.port";
import { OPERATOR_TOKEN_VERIFIER } from "../../src/auth/operator-token-verifier";
import type { RedisLike } from "../../src/auth/rate-limit";
import { ContextModule } from "../../src/context/context.module";
import { InvitationsService } from "../../src/memberships/invitations.service";
import { MembershipsModule } from "../../src/memberships/memberships.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

class AlwaysAllowRedis implements RedisLike {
  async incrWindow(): Promise<{ count: number; ttlMs: number }> {
    return { count: 1, ttlMs: -1 };
  }
  async pttl(): Promise<number> {
    return -1;
  }
  async decr(): Promise<number> {
    return 0;
  }
  async del(): Promise<number> {
    return 0;
  }
}

const OWNER_ID = "c1000000-1000-4000-8000-000000000001";
const EXISTING_ID = "c2000000-2000-4000-8000-000000000002";
const OTHER_ID = "c9000000-9000-4000-8000-000000000009";
const ALPHA_ID = "c3000000-3000-4000-8000-000000000003";
const ROLE_ID = "c4000000-4000-4000-8000-000000000004";
// RT-1028: acceptance re-checks the inviter, so the inviter is an active owner.
const OWNER_ROLE_ID = "c5000000-5000-4000-8000-000000000005";
const OWNER_MEMBERSHIP_ID = "c8000000-8000-4000-8000-000000000008";
const STORE_A1 = "c6000000-6000-4000-8000-000000000006";
const STORE_A2 = "c7000000-7000-4000-8000-000000000007";
const NEW_EMAIL = "newhire@accept-new.test";
const EXISTING_EMAIL = "existing@accept-new.test";
const PASSWORD = "Correct-Horse-Battery-9!";
const ISSUER = "https://api.descope.com/v1/apps/PTESTproject";
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let service: InvitationsService | null = null;
let dockerSkipped = false;

const provider = {
  identity: { providerKey: "descope", issuer: ISSUER },
  createUser: jest.fn(),
  loadUser: jest.fn(),
  setActivePassword: jest.fn(),
  passwordSignIn: jest.fn(),
  replacePassword: jest.fn(),
};
const verifier = { verify: jest.fn() };
const noopEnqueuer = {
  enqueueInvitation: jest.fn().mockResolvedValue(undefined),
  enqueuePasswordReset: jest.fn().mockResolvedValue(undefined),
  enqueueEmailVerification: jest.fn().mockResolvedValue(undefined),
};

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'owner@accept-new.test', 'x')`, [OWNER_ID]);
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [EXISTING_ID, EXISTING_EMAIL]);
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'other@accept-new.test', 'x')`, [OTHER_ID]);
    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'alpha-new', 'Alpha New')`, [ALPHA_ID]);
    await pool.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_manager', 'Store Manager')`, [ROLE_ID, ALPHA_ID]);
    await pool.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'a1', 'A1'), ($3, $2, 'a2', 'A2')`, [STORE_A1, ALPHA_ID, STORE_A2]);
    await pool.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'owner', 'Owner')`, [OWNER_ROLE_ID, ALPHA_ID]);
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, 'all')`,
      [OWNER_MEMBERSHIP_ID, ALPHA_ID, OWNER_ID, OWNER_ROLE_ID],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, MembershipsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(noopEnqueuer)
      .overrideProvider(EXTERNAL_CREDENTIAL_PORT)
      .useValue(provider)
      .overrideProvider(OPERATOR_TOKEN_VERIFIER)
      .useValue(verifier)
      .compile();
    service = moduleRef.get(InvitationsService);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[invitations.accept-new-user.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  provider.createUser.mockReset().mockResolvedValue({ kind: "created", userId: "U2newSubject" });
  provider.setActivePassword.mockReset().mockResolvedValue({ kind: "ok" });
  provider.loadUser.mockReset();
  provider.passwordSignIn.mockReset();
});

async function insertInvitation(email: string, rawToken: string, specific: boolean, invitedBy = OWNER_ID): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO invitations
       (id, tenant_id, email, role_id, store_access_kind, invited_store_ids,
        invited_by_user_id, token_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, 'pending', $9)`,
    [id, ALPHA_ID, email, ROLE_ID, specific ? "specific" : "all", specific ? [STORE_A1, STORE_A2] : [], invitedBy, hashToken(rawToken), FUTURE],
  );
  return id;
}

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const r = await pool!.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return (r.rows[0] as { n: number }).n;
}

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, [NEW_EMAIL]);
  await pool.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id IN (SELECT id FROM users WHERE email IN ($2, $3))`, [ALPHA_ID, NEW_EMAIL, EXISTING_EMAIL]);
  await pool.query(`DELETE FROM invitations WHERE tenant_id = $1`, [ALPHA_ID]);
  await pool.query(`DELETE FROM external_identity_links WHERE email = $1 OR subject = 'U2taken'`, [NEW_EMAIL]);
  await pool.query(`DELETE FROM users WHERE email = $1`, [NEW_EMAIL]);
}

describe("acceptInvitation — NEW user, real schema", () => {
  afterEach(cleanup);

  it("writes user, link, membership and store access together; the new user has no local password; one session", async () => {
    if (dockerSkipped) return;
    const rawToken = generateRawToken();
    const invitationId = await insertInvitation(NEW_EMAIL, rawToken, true);

    const result = await service!.acceptInvitation({ token: rawToken, password: PASSWORD, displayName: "New Hire" });

    const user = (await pool!.query(`SELECT id, password_hash, email_verified_at, display_name FROM users WHERE email = $1`, [NEW_EMAIL])).rows[0];
    expect(user).toBeDefined();
    expect(user.password_hash).toBeNull();
    expect(user.email_verified_at).not.toBeNull();
    expect(user.display_name).toBe("New Hire");

    const link = (await pool!.query(`SELECT provider_key, issuer, subject, status, user_id FROM external_identity_links WHERE user_id = $1`, [user.id])).rows;
    expect(link).toEqual([{ provider_key: "descope", issuer: ISSUER, subject: "U2newSubject", status: "active", user_id: user.id }]);

    expect(await count("memberships", "tenant_id = $1 AND user_id = $2 AND role_id = $3", [ALPHA_ID, user.id, ROLE_ID])).toBe(1);
    expect(await count("store_access", "tenant_id = $1", [ALPHA_ID])).toBe(2);

    const inv = (await pool!.query(`SELECT status, accepted_by_user_id, accepted_at FROM invitations WHERE id = $1`, [invitationId])).rows[0];
    expect(inv.status).toBe("accepted");
    expect(inv.accepted_by_user_id).toBe(user.id);
    expect(inv.accepted_at).not.toBeNull();

    expect(await count("sessions", "user_id = $1", [user.id])).toBe(1);
    expect(result.session?.sessionCredential).toBeTruthy();
    expect(result.tenantId).toBe(ALPHA_ID);
    expect(result.membership.user.id).toBe(user.id);
    expect([...result.membership.accessibleStoreIds].sort()).toEqual([STORE_A1, STORE_A2].sort());
  });

  it("replaying the same token is the opaque 400 with zero writes and no second provider call", async () => {
    if (dockerSkipped) return;
    const rawToken = generateRawToken();
    await insertInvitation(NEW_EMAIL, rawToken, false);
    await service!.acceptInvitation({ token: rawToken, password: PASSWORD });

    const before = { users: await count("users"), links: await count("external_identity_links"), memberships: await count("memberships"), sessions: await count("sessions") };
    provider.createUser.mockClear();

    await expect(service!.acceptInvitation({ token: rawToken, password: PASSWORD })).rejects.toBeInstanceOf(BadRequestException);

    expect({ users: await count("users"), links: await count("external_identity_links"), memberships: await count("memberships"), sessions: await count("sessions") }).toEqual(before);
    expect(provider.createUser).not.toHaveBeenCalled();
  });

  it("a taken identity link rolls the WHOLE acceptance back: no user, no membership, no session, invitation still pending", async () => {
    if (dockerSkipped) return;
    provider.createUser.mockResolvedValue({ kind: "created", userId: "U2taken" });
    await pool!.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status) VALUES ('descope', $1, 'U2taken', $2, 'other@accept-new.test', 'active')`,
      [ISSUER, OTHER_ID],
    );
    const rawToken = generateRawToken();
    const invitationId = await insertInvitation(NEW_EMAIL, rawToken, false);
    const sessionsBefore = await count("sessions");

    await expect(service!.acceptInvitation({ token: rawToken, password: PASSWORD })).rejects.toBeInstanceOf(ConflictException);

    expect(await count("users", "email = $1", [NEW_EMAIL])).toBe(0);
    expect(await count("memberships", "tenant_id = $1 AND role_id = $2", [ALPHA_ID, ROLE_ID])).toBe(0);
    expect(await count("sessions")).toBe(sessionsBefore);
    const inv = (await pool!.query(`SELECT status, accepted_by_user_id FROM invitations WHERE id = $1`, [invitationId])).rows[0];
    expect(inv).toEqual({ status: "pending", accepted_by_user_id: null });
  });
});

describe("acceptInvitation — RT-1028 accept-time hierarchy check, NEW user", () => {
  afterEach(cleanup);

  it("an inviter with no active membership: opaque 400 before any provider call; no user, no membership; one audit row", async () => {
    if (dockerSkipped) return;
    const rawToken = generateRawToken();
    const invitationId = await insertInvitation(NEW_EMAIL, rawToken, false, OTHER_ID);
    const before = { users: await count("users"), links: await count("external_identity_links"), memberships: await count("memberships"), sessions: await count("sessions") };

    const err = await service!.acceptInvitation({ token: rawToken, password: PASSWORD }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe("Invalid or expired invitation token");
    expect(provider.createUser).not.toHaveBeenCalled();
    expect(provider.loadUser).not.toHaveBeenCalled();
    expect({ users: await count("users"), links: await count("external_identity_links"), memberships: await count("memberships"), sessions: await count("sessions") }).toEqual(before);
    const inv = (await pool!.query(`SELECT status, accepted_by_user_id FROM invitations WHERE id = $1`, [invitationId])).rows[0];
    expect(inv).toEqual({ status: "pending", accepted_by_user_id: null });

    const audit = (
      await pool!.query(
        `SELECT actor_user_id, tenant_id, target_type, metadata FROM audit_events
          WHERE action = 'membership.change_refused' AND target_id = $1`,
        [invitationId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: null, tenant_id: ALPHA_ID, target_type: "invitation" });
    expect(audit[0].metadata).toMatchObject({ outcome: "refused", operation: "invitation.accept", reason: "actor_not_authorized" });
    expect(JSON.stringify(audit[0])).not.toContain(NEW_EMAIL);
  });
});

describe("acceptInvitation — EXISTING user, real schema", () => {
  afterEach(cleanup);

  it("grants the membership only: no session, no provider call, no new user or link", async () => {
    if (dockerSkipped) return;
    const rawToken = generateRawToken();
    await insertInvitation(EXISTING_EMAIL, rawToken, false);
    const before = { users: await count("users"), links: await count("external_identity_links"), sessions: await count("sessions") };

    const result = await service!.acceptInvitation({ token: rawToken, password: PASSWORD });

    expect(result.session).toBeNull();
    expect(result.membership.user.id).toBe(EXISTING_ID);
    expect(provider.createUser).not.toHaveBeenCalled();
    expect({ users: await count("users"), links: await count("external_identity_links"), sessions: await count("sessions") }).toEqual(before);
    expect(await count("memberships", "tenant_id = $1 AND user_id = $2", [ALPHA_ID, EXISTING_ID])).toBe(1);
  });
});
