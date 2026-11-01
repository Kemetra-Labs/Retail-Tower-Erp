/**
 * RT-1028 — membership role hierarchy (RT-132 D1–D5a), real Postgres.
 *
 * Covers PATCH /api/v1/memberships/:id, DELETE /api/v1/memberships/:id and
 * POST /api/v1/memberships/invite end to end, with two owners, two
 * tenant_admins, a store-scoped staff member and a platform admin:
 *
 *   P1  tenant_admin promotes a member to owner → 403, unchanged, audited
 *   P2  tenant_admin changes an owner's store access → 403
 *   P3  tenant_admin changes a tenant_admin peer → 200
 *   P4  owner / tenant_admin self PATCH → 403
 *   P5  owner promotes a 'specific' member to owner without a kind → 403
 *   P6  owner demotes the other owner (two owners) → 200
 *   P7  platform admin demotes the last owner → 403 (D3 binds break-glass)
 *   P8  owner demotes a tenant_admin (valid downward change) → 200
 *   D1  tenant_admin revokes an owner → 403, audited
 *   D2  tenant_admin revokes a tenant_admin peer → 204
 *   D3  self-revoke by a tenant_admin → 204
 *   D4  self-revoke by an owner, then by the last owner → 204, then 403
 *   D5  the two owners revoke themselves at the same time → {204, 403}, one owner left
 *   I1  tenant_admin invites an owner → 403, no invitation, audited without the email
 *   I2  owner invites an owner with 'specific' access → 403
 *   I3  tenant_admin invites a tenant_admin → 201
 *
 * The app runs as the non-superuser app role (`env.app`), so RLS applies to
 * the owner lock, the target lock and the refusal audit INSERT; the admin
 * pool only seeds and asserts. Audit rows are append-only (0034), so each
 * refusal is checked as a delta of `membership.change_refused` rows for its
 * target.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { hashPassword } from "@data-pulse-2/auth";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { EMAIL_JOB_ENQUEUER, NoOpEmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import { ContextModule } from "../../src/context/context.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor, ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { createLogger } from "@data-pulse-2/shared";
import { MembershipsModule } from "../../src/memberships/memberships.module";
import { MEMBERSHIP_REFUSED_AUDIT_ACTION } from "../../src/memberships/membership-hierarchy";
import type { RedisLike } from "../../src/auth/rate-limit";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { SAME_ORIGIN } from "../_helpers/same-origin";

/** Rate limits always pass; the idempotency marker slot is always granted (single caller per key). */
class AlwaysAllowRedis implements RedisLike {
  async incrWindow(): Promise<{ count: number; ttlMs: number }> { return { count: 1, ttlMs: -1 }; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async get(_key: string): Promise<string | null> { return null; }
  async set(
    _key: string,
    _value: string,
    _opts: { px: number } | { nx: true; ex: number },
  ): Promise<"OK" | null> {
    return "OK";
  }
  async del(_key: string): Promise<number> { return 0; }
}

// ---- Fixture IDs (UUIDv4, prefix "c7" to avoid collisions) -----------------

const TENANT = "c7000000-0000-4000-8000-000000000001";
const STORE_1 = "c7000000-0000-4000-8000-000000000002";

const ROLE_OWNER = "c7000000-0000-4000-8000-000000000011";
const ROLE_ADMIN = "c7000000-0000-4000-8000-000000000012";
const ROLE_MANAGER = "c7000000-0000-4000-8000-000000000013";
const ROLE_STAFF = "c7000000-0000-4000-8000-000000000014";

interface Person {
  readonly userId: string;
  readonly membershipId: string;
  readonly email: string;
  readonly password: string;
  readonly roleId: string;
  readonly kind: "all" | "specific";
  readonly platformAdmin?: boolean;
}

function person(n: number, name: string, roleId: string, kind: "all" | "specific", platformAdmin = false): Person {
  const hex = n.toString(16).padStart(2, "0");
  return {
    userId: `c7000000-0000-4000-8000-0000000001${hex}`,
    membershipId: `c7000000-0000-4000-8000-0000000002${hex}`,
    email: `${name}@memberships-hierarchy.test`,
    password: `Hierarchy-${name}-1!`,
    roleId,
    kind,
    platformAdmin,
  };
}

const OWNER_1 = person(1, "owner1", ROLE_OWNER, "all");
const OWNER_2 = person(2, "owner2", ROLE_OWNER, "all");
const ADMIN_1 = person(3, "admin1", ROLE_ADMIN, "all");
const ADMIN_2 = person(4, "admin2", ROLE_ADMIN, "all");
const STAFF = person(5, "staff", ROLE_STAFF, "specific");
// A platform admin with a plain membership, so it can select the tenant.
const PLATFORM = person(6, "platform", ROLE_STAFF, "all", true);
const PEOPLE = [OWNER_1, OWNER_2, ADMIN_1, ADMIN_2, STAFF, PLATFORM];

// ---- Bootstrap -------------------------------------------------------------

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

async function seedBase(): Promise<void> {
  const pg = pool!;
  for (const p of PEOPLE) {
    await pg.query(
      `INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4)`,
      [p.userId, p.email, await hashPassword(p.password), p.platformAdmin === true],
    );
  }
  await pg.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'hierarchy', 'Hierarchy')`, [TENANT]);
  await pg.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'H1', 'Store H1')`, [STORE_1, TENANT]);
  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $5, 'owner', 'Owner'),
       ($2, $5, 'tenant_admin', 'Tenant Admin'),
       ($3, $5, 'store_manager', 'Store Manager'),
       ($4, $5, 'store_staff', 'Store Staff')`,
    [ROLE_OWNER, ROLE_ADMIN, ROLE_MANAGER, ROLE_STAFF, TENANT],
  );
  for (const p of PEOPLE) {
    await pg.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, $5)`,
      [p.membershipId, TENANT, p.userId, p.roleId, p.kind],
    );
  }
}

/** Put every membership back to its seeded role, kind and grants (UPDATE, so FKs never break). */
async function resetMemberships(): Promise<void> {
  if (!pool) return;
  for (const p of PEOPLE) {
    await pool.query(
      `UPDATE memberships SET role_id = $2, store_access_kind = $3, revoked_at = NULL, deleted_at = NULL WHERE id = $1`,
      [p.membershipId, p.roleId, p.kind],
    );
  }
  await pool.query(`DELETE FROM store_access WHERE tenant_id = $1`, [TENANT]);
  await pool.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
    [STAFF.membershipId, STORE_1, TENANT],
  );
  await pool.query(`DELETE FROM invitations WHERE tenant_id = $1`, [TENANT]);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    await seedBase();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, MembershipsModule],
    })
      .overrideProvider(PG_POOL).useValue(env.app)
      .overrideProvider(REDIS_CLIENT).useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER).useValue(new NoOpEmailJobEnqueuer())
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    const logger = createLogger({ service: "api-test", level: "silent" });
    app.useGlobalInterceptors(new RequestIdInterceptor(), new LoggingInterceptor(logger), new ContextInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ZodValidationPipe());
    void ROOT_LOGGER;
    await app.init();
    // Listen up front: supertest otherwise calls listen(0) per request, and
    // D5's two concurrent requests would race on the same server.
    await app.listen(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[memberships.hierarchy.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(resetMemberships);

// ---- Helpers ---------------------------------------------------------------

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[memberships.hierarchy.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

async function signInAs(p: Person): Promise<string> {
  const res = await http().post("/api/v1/auth/signin").send({ email: p.email, password: p.password }).expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="));
  if (!cookie) throw new Error("signIn: no session cookie returned");
  const session = cookie.split(";")[0]!;
  await http()
    .post("/api/v1/context/tenant")
    .set("Cookie", session)
    .set(SAME_ORIGIN)
    .send({ tenant_id: TENANT })
    .expect(200);
  return session;
}

function patch(cookie: string, target: Person, body: object) {
  return http().patch(`/api/v1/memberships/${target.membershipId}`).set("Cookie", cookie).set(SAME_ORIGIN).send(body);
}

function revoke(cookie: string, target: Person) {
  return http().delete(`/api/v1/memberships/${target.membershipId}`).set("Cookie", cookie).set(SAME_ORIGIN);
}

function invite(cookie: string, body: object) {
  return http()
    .post("/api/v1/memberships/invite")
    .set("Cookie", cookie)
    .set(SAME_ORIGIN)
    .set("Idempotency-Key", randomUUID())
    .send(body);
}

async function roleOf(p: Person): Promise<string> {
  const res = await pool!.query(
    `SELECT r.code FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.id = $1`,
    [p.membershipId],
  );
  return res.rows[0]?.code as string;
}

async function isRevoked(p: Person): Promise<boolean> {
  const res = await pool!.query(`SELECT revoked_at FROM memberships WHERE id = $1`, [p.membershipId]);
  return res.rows[0]?.revoked_at !== null;
}

async function activeOwnerCount(): Promise<number> {
  const res = await pool!.query(
    `SELECT count(*)::int AS n FROM memberships
      WHERE tenant_id = $1 AND role_id = $2 AND revoked_at IS NULL AND deleted_at IS NULL`,
    [TENANT, ROLE_OWNER],
  );
  return res.rows[0].n as number;
}

interface AuditRow {
  actor_user_id: string | null;
  tenant_id: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
}

/** Refusal rows for one target (a membership id, or null for invitations), oldest first. */
async function refusalsFor(targetId: string | null): Promise<AuditRow[]> {
  const res = await pool!.query(
    `SELECT actor_user_id, tenant_id, target_type, target_id, metadata
       FROM audit_events
      WHERE tenant_id = $1 AND action = $2 AND target_id IS NOT DISTINCT FROM $3
      ORDER BY occurred_at, id`,
    [TENANT, MEMBERSHIP_REFUSED_AUDIT_ACTION, targetId],
  );
  return res.rows as AuditRow[];
}

/** Run `call`, expect a 403 `forbidden` envelope and exactly one new refusal row; return that row. */
async function expectRefused(
  targetId: string | null,
  call: () => Promise<request.Response>,
): Promise<AuditRow> {
  const before = (await refusalsFor(targetId)).length;
  const res = await call();
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe("forbidden");
  const after = await refusalsFor(targetId);
  expect(after).toHaveLength(before + 1);
  return after[after.length - 1]!;
}

// ===== PATCH ================================================================

describe("PATCH /api/v1/memberships/:id — role hierarchy (RT-1028)", () => {
  it("P1: tenant_admin promoting a member to owner → 403, unchanged, one audit row", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    const row = await expectRefused(ADMIN_2.membershipId, () => patch(cookie, ADMIN_2, { role_code: "owner" }));
    expect(await roleOf(ADMIN_2)).toBe("tenant_admin");
    expect(row.actor_user_id).toBe(ADMIN_1.userId);
    expect(row.target_type).toBe("membership");
    expect(row.metadata).toMatchObject({
      outcome: "refused",
      operation: "membership.update",
      reason: "owner_managed_by_owner_only",
      target_role_code: "tenant_admin",
      requested_role_code: "owner",
    });
  });

  it("P2: tenant_admin changing an owner's store access → 403", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    const row = await expectRefused(OWNER_2.membershipId, () =>
      patch(cookie, OWNER_2, { store_access_kind: "specific", store_ids: [STORE_1] }),
    );
    expect(row.metadata["reason"]).toBe("owner_managed_by_owner_only");
  });

  it("P3: tenant_admin changing a tenant_admin peer → 200", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    const res = await patch(cookie, ADMIN_2, { role_code: "store_manager" });
    expect(res.status).toBe(200);
    expect(await roleOf(ADMIN_2)).toBe("store_manager");
  });

  it("P4: an owner or tenant_admin changing its own membership → 403", async () => {
    if (maybeSkip()) return;
    const ownerCookie = await signInAs(OWNER_1);
    const ownerRow = await expectRefused(OWNER_1.membershipId, () =>
      patch(ownerCookie, OWNER_1, { role_code: "tenant_admin" }),
    );
    expect(ownerRow.metadata["reason"]).toBe("self_change");
    expect(await roleOf(OWNER_1)).toBe("owner");

    const adminCookie = await signInAs(ADMIN_1);
    const adminRow = await expectRefused(ADMIN_1.membershipId, () =>
      patch(adminCookie, ADMIN_1, { store_access_kind: "specific", store_ids: [STORE_1] }),
    );
    expect(adminRow.metadata["reason"]).toBe("self_change");
  });

  it("P5: owner promoting a 'specific' member to owner without a kind → 403", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(OWNER_1);
    const row = await expectRefused(STAFF.membershipId, () => patch(cookie, STAFF, { role_code: "owner" }));
    expect(row.metadata["reason"]).toBe("owner_requires_all_stores");
    expect(await roleOf(STAFF)).toBe("store_staff");
  });

  it("P6: owner demoting the other owner while two exist → 200", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(OWNER_1);
    const res = await patch(cookie, OWNER_2, { role_code: "tenant_admin" });
    expect(res.status).toBe(200);
    expect(await activeOwnerCount()).toBe(1);
  });

  it("P7: a platform admin demoting the last owner → 403 last_owner", async () => {
    if (maybeSkip()) return;
    await pool!.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [OWNER_2.membershipId]);
    const cookie = await signInAs(PLATFORM);
    const row = await expectRefused(OWNER_1.membershipId, () => patch(cookie, OWNER_1, { role_code: "tenant_admin" }));
    expect(row.metadata).toMatchObject({ reason: "last_owner", platform_admin: true });
    expect(await roleOf(OWNER_1)).toBe("owner");
  });

  it("P8: owner demoting a tenant_admin (valid downward change) → 200", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(OWNER_1);
    const res = await patch(cookie, ADMIN_2, { role_code: "store_staff" });
    expect(res.status).toBe(200);
    expect(res.body.role_code).toBe("store_staff");
  });
});

// ===== DELETE ===============================================================

describe("DELETE /api/v1/memberships/:id — role hierarchy (RT-1028)", () => {
  it("D1: tenant_admin revoking an owner → 403, not revoked, one audit row", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    const row = await expectRefused(OWNER_2.membershipId, () => revoke(cookie, OWNER_2));
    expect(await isRevoked(OWNER_2)).toBe(false);
    expect(row.metadata).toMatchObject({ operation: "membership.revoke", reason: "owner_managed_by_owner_only" });
  });

  it("D2: tenant_admin revoking a tenant_admin peer → 204", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    await revoke(cookie, ADMIN_2).expect(204);
    expect(await isRevoked(ADMIN_2)).toBe(true);
  });

  it("D3: a tenant_admin revoking itself → 204", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    await revoke(cookie, ADMIN_1).expect(204);
    expect(await isRevoked(ADMIN_1)).toBe(true);
  });

  it("D4: an owner self-revokes (204); then the last owner's self-revoke is refused (403)", async () => {
    if (maybeSkip()) return;
    const first = await signInAs(OWNER_1);
    const second = await signInAs(OWNER_2);
    await revoke(first, OWNER_1).expect(204);

    const row = await expectRefused(OWNER_2.membershipId, () => revoke(second, OWNER_2));
    expect(row.metadata["reason"]).toBe("last_owner");
    expect(await activeOwnerCount()).toBe(1);
  });

  it("D5: both owners revoking themselves at once → exactly one 204 and one 403; one owner left", async () => {
    if (maybeSkip()) return;
    const [first, second] = await Promise.all([signInAs(OWNER_1), signInAs(OWNER_2)]);
    const results = await Promise.all([revoke(first, OWNER_1), revoke(second, OWNER_2)]);

    expect(results.map((r) => r.status).sort()).toEqual([204, 403]);
    expect(await activeOwnerCount()).toBe(1);
  });
});

// ===== Invite ===============================================================

describe("POST /api/v1/memberships/invite — role hierarchy (RT-1028)", () => {
  it("I1: tenant_admin inviting an owner → 403, no invitation, audited without the email", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    const row = await expectRefused(null, () =>
      invite(cookie, { email: "Would-Be-Owner@Example.com", role_code: "owner", store_access_kind: "all" }),
    );
    expect(row.target_type).toBe("invitation");
    expect(row.metadata).toMatchObject({ operation: "invitation.create", reason: "owner_managed_by_owner_only" });
    expect(JSON.stringify(row.metadata)).not.toMatch(/example\.com/i);
    const invitations = await pool!.query(`SELECT 1 FROM invitations WHERE tenant_id = $1`, [TENANT]);
    expect(invitations.rowCount).toBe(0);
  });

  it("I2: owner inviting an owner with 'specific' access → 403", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(OWNER_1);
    const row = await expectRefused(null, () =>
      invite(cookie, { email: "x@example.com", role_code: "owner", store_access_kind: "specific", store_ids: [STORE_1] }),
    );
    expect(row.metadata["reason"]).toBe("owner_requires_all_stores");
  });

  it("I3: tenant_admin inviting a tenant_admin → 201", async () => {
    if (maybeSkip()) return;
    const cookie = await signInAs(ADMIN_1);
    const res = await invite(cookie, { email: "peer@example.com", role_code: "tenant_admin", store_access_kind: "all" });
    expect(res.status).toBe(201);
  });
});
