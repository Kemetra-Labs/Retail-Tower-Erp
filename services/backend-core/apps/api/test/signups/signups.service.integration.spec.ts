/**
 * signups.service.integration.spec.ts — RT-1350 slice 3, real Postgres (Testcontainers).
 *
 * The real `SignupsService` + `SignupsRepository` run on the NON-SUPERUSER `app_test`
 * pool, so row-level security is ENFORCED (RT-1389: the service runs on the narrow
 * `signup` privilege, never the platform-admin flag; 0111 lets it reach `pending_signups`
 * and `user_consents`, and insert the `restricted` entitlement only pinned to the new
 * tenant, RT-1350 comment 16773). Only the identity provider, the limiter, the human-proof verifier, the email
 * and audit producers and the session store are fakes. Fixtures and assertions use the
 * superuser pool.
 *
 * Pins: the whole completion is ONE transaction (a late failure leaves nothing behind
 * and the row pending); a signup completes at most once even under concurrency; an
 * existing user keeps their password hash; the restricted row is present and the
 * Console read says `restricted`; an expired-but-pending row is expired and replaced in
 * one transaction (comment 16878); a recent completion suppresses a new link (owner
 * decision B).
 */
import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { AccessEntitlementService } from "../../src/tenant-access-entitlement/access-entitlement.service";
import { linkStateReader } from "../../src/signups/signup-link-state";
import { OwnTokenSignupLinkProvider } from "../../src/signups/own-token-signup-link.provider";
import { SignupsRepository } from "../../src/signups/signups.repository";
import { SignupsService } from "../../src/signups/signups.service";
import type { SignupsStore } from "../../src/signups/signups.store";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import type { RateLimiter } from "../../src/auth/rate-limit";
import type { ExternalCredentialPort } from "../../src/auth/external-credential.port";
import { FakeAudit, FakeEmails, FakeExternal, FakeHumanProof, FakeLimiter, FakeSessions, REQUEST } from "./signups.fakes";

const PASSWORD = "Correct-Horse-Battery-9!";
const TERMS = "2026-11";

let env: PgTestEnv | null = null;
let admin: Pool;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    admin = env.admin;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[signups.service.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface Rig {
  readonly service: SignupsService;
  readonly emails: FakeEmails;
  readonly external: FakeExternal;
  readonly sessions: FakeSessions;
  readonly audit: FakeAudit;
}

function rig(store: SignupsStore = new SignupsRepository()): Rig {
  const emails = new FakeEmails();
  const external = new FakeExternal();
  const sessions = new FakeSessions();
  const audit = new FakeAudit();
  const service = new SignupsService({
    pool: env!.app,
    store,
    humanProof: new FakeHumanProof(),
    limiter: new FakeLimiter() as unknown as RateLimiter,
    links: new OwnTokenSignupLinkProvider(emails),
    audit,
    external: external as unknown as ExternalCredentialPort,
    sessions,
    linkState: linkStateReader(env!.admin, "descope"),
    env: { SIGNUP_CURRENT_TERMS_VERSION: TERMS },
    limiterTimeoutMs: 1000,
  });
  return { service, emails, external, sessions, audit };
}

const CTX = { ip: "198.51.100.7", requestId: null };
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const uniqueEmail = (): string => `owner-${randomUUID().slice(0, 8)}@signups.test`;

async function q<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query(sql, params)).rows as T[];
}

/** A pending signup row with a known token, inserted by the superuser. */
async function seedPending(
  email: string,
  opts: { token?: string; expiresAt?: Date; status?: string; businessName?: string } = {},
): Promise<{ id: string; token: string; businessName: string }> {
  const id = randomUUID();
  const token = opts.token ?? `tok-${randomUUID()}`;
  const businessName = opts.businessName ?? `Biz ${randomUUID().slice(0, 8)}`;
  await q(
    `INSERT INTO pending_signups (id, email_normalized, name, business_name, locale, terms_version, terms_accepted_at, ip_hash, token_hash, status, created_at, expires_at)
     VALUES ($1, $2, 'Mona Hassan', $8, 'ar', $3, now(), $4, $5, $6, now() - interval '1 hour', $7)`,
    [id, email, TERMS, "a".repeat(64), sha256(token), opts.status ?? "pending", opts.expiresAt ?? new Date(Date.now() + 3_600_000), businessName],
  );
  return { id, token, businessName };
}

describe("completeSignup (real schema, RLS enforced)", () => {
  it("a NEW owner: user, link, tenant, roles, owner membership, restricted entitlement, consent, completion and audit land together", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    const { id, token, businessName } = await seedPending(email);
    const r = rig();
    r.external.create = { kind: "created", userId: `sub-${randomUUID()}` };

    const result = await r.service.completeSignup({ token, password: PASSWORD }, CTX);
    if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);

    const [user] = await q<{ id: string; password_hash: string | null; email_verified_at: Date | null; display_name: string }>(
      `SELECT id, password_hash, email_verified_at, display_name FROM users WHERE email = $1`,
      [email],
    );
    expect(user).toBeDefined();
    expect(user!.password_hash).toBeNull();
    expect(user!.email_verified_at).not.toBeNull();
    expect(user!.display_name).toBe("Mona Hassan");

    expect(await q(`SELECT provider_key, status FROM external_identity_links WHERE user_id = $1`, [user!.id])).toEqual([
      { provider_key: "descope", status: "active" },
    ]);

    const [tenant] = await q<{ id: string; slug: string; name: string; status: string }>(`SELECT id, slug, name, status FROM tenants WHERE id = $1`, [result.tenantId]);
    expect(tenant).toMatchObject({ name: businessName, status: "active" });
    expect(tenant!.slug).toMatch(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/);
    expect((await q(`SELECT code FROM roles WHERE tenant_id = $1 ORDER BY code`, [result.tenantId])).map((x) => (x as { code: string }).code)).toEqual([
      "owner",
      "store_manager",
      "store_staff",
      "tenant_admin",
    ]);
    expect(
      await q(
        `SELECT r.code, m.store_access_kind, m.revoked_at FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.tenant_id = $1 AND m.user_id = $2`,
        [result.tenantId, user!.id],
      ),
    ).toEqual([{ code: "owner", store_access_kind: "all", revoked_at: null }]);
    expect(await q(`SELECT count(*)::int AS n FROM stores WHERE tenant_id = $1`, [result.tenantId])).toEqual([{ n: 0 }]);

    // The restricted row is present, plain (no unlock request), and the Console read says so.
    expect(await q(`SELECT state, unlock_requested_at, provisioned_at FROM tenant_access_entitlements WHERE tenant_id = $1`, [result.tenantId])).toEqual([
      { state: "restricted", unlock_requested_at: null, provisioned_at: null },
    ]);
    const read = await new AccessEntitlementService(env!.app, {} as never).read(result.tenantId);
    expect(read.state).toBe("restricted");

    expect(await q(`SELECT user_id, terms_version, source, pending_signup_id FROM user_consents WHERE user_id = $1`, [user!.id])).toEqual([
      { user_id: user!.id, terms_version: TERMS, source: "self_signup", pending_signup_id: id },
    ]);
    expect(await q(`SELECT status, tenant_id FROM pending_signups WHERE id = $1`, [id])).toEqual([{ status: "completed", tenant_id: result.tenantId }]);
    expect((await q(`SELECT action FROM audit_events WHERE tenant_id = $1 ORDER BY action`, [result.tenantId])).map((a) => (a as { action: string }).action)).toEqual([
      "signup.completed",
      "tenant.self_service_created",
    ]);
    expect(r.sessions.started).toEqual([user!.id]);
  });

  it("a late failure rolls EVERYTHING back (no user, tenant, membership, entitlement, consent) and the row stays pending", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    const { id, token, businessName } = await seedPending(email);
    class FailingConsent extends SignupsRepository {
      override insertConsent(): Promise<void> {
        return Promise.reject(new Error("late failure"));
      }
    }
    const r = rig(new FailingConsent());
    r.external.create = { kind: "created", userId: `sub-${randomUUID()}` };

    await expect(r.service.completeSignup({ token, password: PASSWORD }, CTX)).rejects.toThrow("late failure");

    expect(await q(`SELECT 1 FROM users WHERE email = $1`, [email])).toEqual([]);
    expect(await q(`SELECT 1 FROM tenants WHERE name = $1`, [businessName])).toEqual([]);
    expect(await q(`SELECT status, tenant_id FROM pending_signups WHERE id = $1`, [id])).toEqual([{ status: "pending", tenant_id: null }]);
    expect(r.sessions.started).toEqual([]);

    // The row is still completable: a clean retry converges on one user and one tenant.
    const retry = rig();
    retry.external.create = { kind: "rejected" };
    retry.external.load = { kind: "found", userId: `sub-${randomUUID()}`, passwordSet: true };
    expect((await retry.service.completeSignup({ token, password: PASSWORD }, CTX)).kind).toBe("created");
    expect(await q(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [email])).toEqual([{ n: 1 }]);
  });

  it("completes at most once, even for two concurrent requests with the same token", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    const { id, token } = await seedPending(email);
    const a = rig();
    const b = rig();
    a.external.create = { kind: "created", userId: `sub-${randomUUID()}` };
    b.external.create = { kind: "created", userId: `sub-${randomUUID()}` };

    const results = await Promise.all([a.service.completeSignup({ token, password: PASSWORD }, CTX), b.service.completeSignup({ token, password: PASSWORD }, CTX)]);

    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "invalid")).toHaveLength(1);
    expect(await q(`SELECT count(*)::int AS n FROM pending_signups WHERE id = $1 AND status = 'completed'`, [id])).toEqual([{ n: 1 }]);
    expect(await q(`SELECT count(*)::int AS n FROM tenants WHERE id = (SELECT tenant_id FROM pending_signups WHERE id = $1)`, [id])).toEqual([{ n: 1 }]);
    expect(await q(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [email])).toEqual([{ n: 1 }]);
  });

  it("a replay of a completed token is the generic invalid and creates no second tenant (the lost-201 case)", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    const { token } = await seedPending(email);
    const r = rig();
    r.external.create = { kind: "created", userId: `sub-${randomUUID()}` };
    expect((await r.service.completeSignup({ token, password: PASSWORD }, CTX)).kind).toBe("created");

    expect(await r.service.completeSignup({ token, password: PASSWORD }, CTX)).toEqual({ kind: "invalid" });
    expect(await q(`SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`, [email])).toEqual([{ n: 1 }]);
  });

  it("an EXISTING user gets the tenant, keeps their password hash, and no provider call is made", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    const userId = randomUUID();
    await q(`INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'existing-hash', 'Old Name')`, [userId, email]);
    const { token } = await seedPending(email);
    const r = rig();

    const result = await r.service.completeSignup({ token, password: "A-Different-Password-1!" }, CTX);
    if (result.kind !== "created") throw new Error("expected created");

    expect(await q(`SELECT password_hash, display_name FROM users WHERE id = $1`, [userId])).toEqual([{ password_hash: "existing-hash", display_name: "Old Name" }]);
    expect(r.external.calls).toEqual([]);
    expect(await q(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [result.tenantId, userId])).toHaveLength(1);
    expect((await q(`SELECT action FROM audit_events WHERE tenant_id = $1 ORDER BY action`, [result.tenantId])).map((a) => (a as { action: string }).action)).toEqual([
      "signup.completed",
      "signup.existing_user_completed",
      "tenant.self_service_created",
    ]);
    expect(r.sessions.started).toEqual([userId]);
  });

  it("a platform admin's email completes to the generic invalid: no tenant, no session", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    await q(`INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, $2, 'h', true)`, [randomUUID(), email]);
    const { id, token } = await seedPending(email);
    const r = rig();

    expect(await r.service.completeSignup({ token, password: PASSWORD }, CTX)).toEqual({ kind: "invalid" });
    expect(await q(`SELECT status FROM pending_signups WHERE id = $1`, [id])).toEqual([{ status: "pending" }]);
    expect(r.sessions.started).toEqual([]);
  });

  it("an expired token and an unknown token are the generic invalid", async () => {
    if (dockerSkipped) return;
    const { token } = await seedPending(uniqueEmail(), { expiresAt: new Date(Date.now() - 1000) });
    const r = rig();
    expect(await r.service.completeSignup({ token, password: PASSWORD }, CTX)).toEqual({ kind: "invalid" });
    expect(await r.service.completeSignup({ token: "no-such-token", password: PASSWORD }, CTX)).toEqual({ kind: "invalid" });
  });
});

describe("requestSignup (real schema, RLS enforced)", () => {
  it("records a pending row with a token HASH, a hashed IP and the consent columns, and sends the link", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    const r = rig();

    expect(await r.service.requestSignup({ ...REQUEST, email, termsVersion: TERMS }, CTX)).toBe("accepted");
    await r.service.settleWork();

    const [row] = await q<{ token_hash: string; ip_hash: string; status: string; terms_version: string; expires_at: Date; created_at: Date }>(
      `SELECT token_hash, ip_hash, status, terms_version, expires_at, created_at FROM pending_signups WHERE email_normalized = $1`,
      [email],
    );
    expect(row).toMatchObject({ status: "pending", terms_version: TERMS });
    expect(row!.token_hash).toBe(sha256(r.emails.sent[0]!.rawToken));
    expect(row!.ip_hash).not.toContain(CTX.ip);
    expect(row!.expires_at.getTime() - row!.created_at.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("a second request supersedes the first (old row expired, one pending), and a STALE pending row is expired and replaced in one transaction", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    await seedPending(email, { expiresAt: new Date(Date.now() - 60_000) }); // past expiry, still `pending`
    const r = rig();

    await r.service.requestSignup({ ...REQUEST, email, termsVersion: TERMS }, CTX);
    await r.service.settleWork();
    await r.service.requestSignup({ ...REQUEST, email, termsVersion: TERMS }, CTX);
    await r.service.settleWork();

    expect(await q(`SELECT status, count(*)::int AS n FROM pending_signups WHERE email_normalized = $1 GROUP BY status ORDER BY status`, [email])).toEqual([
      { status: "expired", n: 2 },
      { status: "pending", n: 1 },
    ]);
    expect(r.emails.sent).toHaveLength(2);
  });

  it("sends no link for an address that completed a signup in the last 24 h (owner decision B)", async () => {
    if (dockerSkipped) return;
    const email = uniqueEmail();
    const { token } = await seedPending(email);
    const r = rig();
    r.external.create = { kind: "created", userId: `sub-${randomUUID()}` };
    expect((await r.service.completeSignup({ token, password: PASSWORD }, CTX)).kind).toBe("created");

    expect(await r.service.requestSignup({ ...REQUEST, email, termsVersion: TERMS }, CTX)).toBe("accepted");
    await r.service.settleWork();

    expect(r.emails.sent).toEqual([]);
    expect(await q(`SELECT count(*)::int AS n FROM pending_signups WHERE email_normalized = $1 AND status = 'pending'`, [email])).toEqual([{ n: 0 }]);
    expect(await q(`SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`, [email])).toEqual([{ n: 1 }]);
  });

  it("sends no link for a platform admin, a soft-deleted user, or a user whose identity link is disabled", async () => {
    if (dockerSkipped) return;
    const admin1 = uniqueEmail();
    const deleted = uniqueEmail();
    const disabled = uniqueEmail();
    await q(`INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, $2, 'h', true)`, [randomUUID(), admin1]);
    await q(`INSERT INTO users (id, email, password_hash, deleted_at) VALUES ($1, $2, 'h', now())`, [randomUUID(), deleted]);
    const disabledId = randomUUID();
    await q(`INSERT INTO users (id, email) VALUES ($1, $2)`, [disabledId, disabled]);
    await q(`INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status, disabled_at) VALUES ('descope', 'iss', $1, $2, $3, 'disabled', now())`, [
      `sub-${randomUUID()}`,
      disabledId,
      disabled,
    ]);
    const r = rig();

    for (const email of [admin1, deleted, disabled]) {
      expect(await r.service.requestSignup({ ...REQUEST, email, termsVersion: TERMS }, CTX)).toBe("accepted");
    }
    await r.service.settleWork();
    expect(r.emails.sent).toEqual([]);
  });
});

describe("linkStateReader", () => {
  it("reports none, active and disabled for the configured provider only", async () => {
    if (dockerSkipped) return;
    const read = linkStateReader(env!.admin, "descope");
    const none = randomUUID();
    const active = randomUUID();
    const off = randomUUID();
    for (const [id, status] of [[active, "active"], [off, "disabled"]] as const) {
      const email = uniqueEmail();
      await q(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, email]);
      await q(`INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status, disabled_at)
         VALUES ('descope', 'iss', $1, $2, $3, $4, CASE WHEN $4 = 'disabled' THEN now() END)`, [`sub-${randomUUID()}`, id, email, status]);
    }
    expect(await read(none)).toBe("none");
    expect(await read(active)).toBe("active");
    expect(await read(off)).toBe("disabled");
    expect(await linkStateReader(env!.admin, "other-provider")(off)).toBe("none");
    expect(await linkStateReader(env!.admin, null)(off)).toBe("none");
  });
});
