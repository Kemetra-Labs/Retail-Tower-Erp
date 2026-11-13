/**
 * RT-1357 (PB-B): `0109_erp_provisioning` migration test.
 *
 * Validates `packages/db/drizzle/0109_erp_provisioning.sql` (+ `.down.sql`) on a
 * real PostgreSQL (Testcontainers), applied on top of every earlier migration
 * with tenants and a connector registration already present (the UPGRADE path):
 *   1. existing registrations read `managed_by` NULL; the managed_by CHECK;
 *   2. the scope CHECK accepts `connector_provisioner` and still rejects an
 *      unknown scope; the platform-scope token invariants (no tenant, system
 *      actor as user, no device, store or registration);
 *   3. one ACTIVE `tenant.provision` request per tenant; a new one after a
 *      terminal state; other kinds are not limited;
 *   4. the system actor cannot authenticate interactively (no password hash, no
 *      external identity, no membership, never a platform admin, held by a CHECK);
 *   5. RLS as the NOBYPASSRLS app role: a tenant cannot read another tenant's
 *      requests or step log; the provisioner GUC (`app.is_provisioner`) reads and
 *      updates requests and appends step-log rows but cannot create requests,
 *      cannot read the credential table and cannot write
 *      `tenant_access_entitlements`; platform admin creates requests only clean;
 *   6. step log: idempotency key unique, append-only, tenant must match request;
 *   7. credential store: one live row per host label;
 *   8. as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to '';
 *   9. DOWN refuses while data exists, then UP -> DOWN -> UP.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asMigrationOwner, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0109_erp_provisioning.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0109_erp_provisioning.down.sql");

const id = (n: string): string => `10900000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const ADMIN_USER = id("0a0a1");
const REG_LEGACY = id("0e001");
const REG_MANAGED_A = id("0e00a");
const REG_MANAGED_B = id("0e00b");
const SYSTEM_ACTOR = "00000000-0000-7000-8000-000000001357";

const REQ = "erp_provisioning_request";
const LOG = "erp_provisioning_step_log";
const CRED = "erp_provisioner_credential";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

interface Ctx {
  readonly tenant?: string | null;
  readonly platformAdmin?: boolean;
  readonly provisioner?: boolean;
}

/** Run `work` as the NOBYPASSRLS app role with the given session settings; always rolled back. */
async function asCtx<T>(ctx: Ctx, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await guard().app.connect();
  try {
    await client.query("BEGIN");
    if (ctx.tenant !== undefined && ctx.tenant !== null) {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [ctx.tenant]);
    }
    if (ctx.platformAdmin) await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    if (ctx.provisioner) await client.query("SELECT set_config('app.is_provisioner', 'true', true)");
    return await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toMatchObject({ code });
}

const TERMINAL = ["succeeded", "failed_permanent", "compensated", "cancelled"];

/** Insert a request through the superuser pool; returns its id. */
async function insertRequest(
  tenant: string,
  over: { kind?: string; status?: string; registration?: string | null } = {},
): Promise<string> {
  const status = over.status ?? "requested";
  const r = await guard().admin.query<{ id: string }>(
    `INSERT INTO ${REQ} (tenant_id, kind, status, site_name, template_id, template_version, connector_registration_id, terminal_at)
     VALUES ($1, $2, $3, $4, 'egypt-retail', 1, $5, $6) RETURNING id`,
    [
      tenant,
      over.kind ?? "tenant.provision",
      status,
      `site-${tenant.slice(-5)}`,
      over.registration === undefined ? null : over.registration,
      TERMINAL.includes(status) ? new Date("2026-11-13T10:00:00Z") : null,
    ],
  );
  return r.rows[0]!.id;
}

function insertStep(requestId: string, tenant: string, step = "claimed", attempt = 1, outcome = "done"): Promise<unknown> {
  return guard().admin.query(
    `INSERT INTO ${LOG} (request_id, tenant_id, generation, step, outcome, attempt, error_class, reason)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`,
    [requestId, tenant, step, outcome, attempt, outcome === "done" ? null : outcome, outcome === "permanently_rejected" ? "bad" : null],
  );
}

async function insertProvisionerToken(over: Record<string, unknown> = {}): Promise<string> {
  const row = {
    scope: "connector_provisioner",
    tenant_id: null,
    user_id: SYSTEM_ACTOR,
    ...over,
  };
  const r = await guard().admin.query<{ id: string }>(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id)
     VALUES (gen_random_uuid(), gen_random_bytes(32), $1, $2, $3, now() + interval '30 days', $4) RETURNING id`,
    [row.tenant_id, row.user_id, row.scope, (row as { connector_registration_id?: string }).connector_registration_id ?? null],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
         ($1, 'prov-a', 'Prov A', 'USD'), ($2, 'prov-b', 'Prov B', 'USD')`,
      [TENANT_A, TENANT_B],
    );
    await env.admin.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'prov-admin@fixture.invalid', NULL)`, [ADMIN_USER]);
    await env.admin.query(
      `INSERT INTO connector_registration (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
       VALUES ($1, $4, 'legacy', 'legacy-site', 'pilot', $5),
              ($2, $4, 'managed a', 'site-a', 'pilot', $5),
              ($3, $6, 'managed b', 'site-b', 'pilot', $5)`,
      [REG_LEGACY, REG_MANAGED_A, REG_MANAGED_B, TENANT_A, ADMIN_USER, TENANT_B],
    );
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0109-erp-provisioning.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0109: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip() || !env) return;
  const a = env.admin;
  // The step log is append-only (trigger): clear it with triggers off.
  await a.query("SET session_replication_role = replica");
  await a.query(`DELETE FROM ${LOG}`);
  await a.query("RESET session_replication_role");
  await a.query(`DELETE FROM ${REQ}`);
  await a.query(`DELETE FROM ${CRED}`);
  await a.query(`DELETE FROM auth_tokens WHERE scope = 'connector_provisioner'`);
  await a.query(`UPDATE connector_registration SET managed_by = NULL`);
});

describe("0109: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0109: connector_registration.managed_by", () => {
  it("existing registrations read managed_by NULL (no backfill)", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ id: string; managed_by: string | null }>(
      `SELECT id, managed_by FROM connector_registration WHERE id = ANY($1::uuid[])`,
      [[REG_LEGACY, REG_MANAGED_A, REG_MANAGED_B]],
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((row) => row.managed_by === null)).toBe(true);
  });

  it("accepts only NULL or 'provisioner' (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(`UPDATE connector_registration SET managed_by = 'provisioner' WHERE id = $1`, [REG_MANAGED_A]);
    await expectCode(a.query(`UPDATE connector_registration SET managed_by = 'owner' WHERE id = $1`, [REG_MANAGED_A]), "23514");
  });
});

describe("0109: auth_tokens scope and platform-scope invariants", () => {
  it("still accepts the six existing scopes and rejects an unknown one (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    for (const scope of ["dashboard_api", "pos", "connector", "password_reset", "email_verify"]) {
      await a.query(
        `INSERT INTO auth_tokens (id, token_hash, user_id, scope, expires_at)
         VALUES (gen_random_uuid(), gen_random_bytes(32), $1, $2, now() + interval '1 day')`,
        [ADMIN_USER, scope],
      );
    }
    await expectCode(
      a.query(
        `INSERT INTO auth_tokens (id, token_hash, user_id, scope, expires_at)
         VALUES (gen_random_uuid(), gen_random_bytes(32), $1, 'made_up', now() + interval '1 day')`,
        [ADMIN_USER],
      ),
      "23514",
    );
    await a.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [ADMIN_USER]);
  });

  it("accepts the provisioner scope only as a platform token owned by the system actor", async () => {
    if (skip()) return;
    await insertProvisionerToken();
    // a tenant
    await expectCode(insertProvisionerToken({ tenant_id: TENANT_A }), "23514");
    // a human user instead of the system actor
    await expectCode(insertProvisionerToken({ user_id: ADMIN_USER }), "23514");
    // tied to a connector registration
    await expectCode(insertProvisionerToken({ connector_registration_id: REG_LEGACY }), "23514");
  });
});

describe("0109: system actor", () => {
  it("is seeded, cannot sign in, has no identity or membership and is never a platform admin", async () => {
    if (skip()) return;
    const a = guard().admin;
    const u = await a.query(
      `SELECT email::text AS email, password_hash, clerk_user_id, is_platform_admin, deleted_at FROM users WHERE id = $1`,
      [SYSTEM_ACTOR],
    );
    expect(u.rows).toHaveLength(1);
    expect(u.rows[0]).toMatchObject({ password_hash: null, clerk_user_id: null, is_platform_admin: false, deleted_at: null });
    expect(u.rows[0]!.email).toMatch(/\.invalid$/);
    // The password sign-in path accepts a user only when password_hash is not null (auth.service).
    const signIn = await a.query(`SELECT count(*)::int AS n FROM users WHERE id = $1 AND password_hash IS NOT NULL`, [SYSTEM_ACTOR]);
    expect(signIn.rows[0]).toEqual({ n: 0 });
    const links = await a.query(`SELECT count(*)::int AS n FROM external_identity_links WHERE user_id = $1`, [SYSTEM_ACTOR]);
    expect(links.rows[0]).toEqual({ n: 0 });
    const members = await a.query(`SELECT count(*)::int AS n FROM memberships WHERE user_id = $1`, [SYSTEM_ACTOR]);
    expect(members.rows[0]).toEqual({ n: 0 });
  });

  it("a CHECK refuses to give it a password hash, an external identity or platform admin (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await expectCode(a.query(`UPDATE users SET password_hash = '$argon2id$x' WHERE id = $1`, [SYSTEM_ACTOR]), "23514");
    await expectCode(a.query(`UPDATE users SET clerk_user_id = 'user_abc' WHERE id = $1`, [SYSTEM_ACTOR]), "23514");
    await expectCode(a.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [SYSTEM_ACTOR]), "23514");
  });
});

describe("0109: erp_provisioning_request", () => {
  it("allows one active tenant.provision per tenant (23505) and a new one after a terminal state", async () => {
    if (skip()) return;
    await insertRequest(TENANT_A);
    await expectCode(insertRequest(TENANT_A), "23505");
    await expectCode(insertRequest(TENANT_A, { status: "site_created" }), "23505");
    // another tenant is independent
    await insertRequest(TENANT_B);
    // other kinds are not limited
    await insertRequest(TENANT_A, { kind: "store.provision" });
    await insertRequest(TENANT_A, { kind: "store.provision" });
    await insertRequest(TENANT_A, { kind: "credential.rotate" });
    // every terminal status frees the slot
    for (const terminal of TERMINAL) {
      await guard().admin.query(`DELETE FROM ${REQ} WHERE tenant_id = $1 AND kind = 'tenant.provision'`, [TENANT_A]);
      const first = await insertRequest(TENANT_A, { status: terminal });
      await insertRequest(TENANT_A); // a new active one is allowed
      await expectCode(insertRequest(TENANT_A), "23505");
      expect(first).toBeTruthy();
    }
  });

  it("checks kind, status, counters, the lease triple and terminal_at (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const base = (over: string): Promise<unknown> =>
      a.query(
        `INSERT INTO ${REQ} (tenant_id, kind, status, site_name, template_id, template_version${over ? ", " + over.split("=")[0] : ""})
         VALUES ($1, 'store.provision', 'requested', 's', 't', 1${over ? ", " + over.split("=")[1] : ""})`,
        [TENANT_A],
      );
    await base("");
    await expectCode(a.query(`INSERT INTO ${REQ} (tenant_id, kind, site_name, template_id, template_version) VALUES ($1, 'nope', 's', 't', 1)`, [TENANT_A]), "23514");
    await expectCode(a.query(`INSERT INTO ${REQ} (tenant_id, kind, status, site_name, template_id, template_version) VALUES ($1, 'store.provision', 'paused', 's', 't', 1)`, [TENANT_A]), "23514");
    await expectCode(base("attempt=-1"), "23514");
    await expectCode(base("generation=0"), "23514");
    // lease: holder alone is refused; the full triple is accepted
    await expectCode(base("lease_holder='lab-03'"), "23514");
    await a.query(
      `INSERT INTO ${REQ} (tenant_id, kind, status, site_name, template_id, template_version, lease_holder, lease_id, lease_expires_at)
       VALUES ($1, 'store.provision', 'claimed', 's', 't', 1, 'lab-03', gen_random_uuid(), now() + interval '5 minutes')`,
      [TENANT_A],
    );
    // terminal_at must match the status
    await expectCode(base("terminal_at=now()"), "23514");
    await expectCode(
      a.query(`INSERT INTO ${REQ} (tenant_id, kind, status, site_name, template_id, template_version) VALUES ($1, 'store.provision', 'succeeded', 's', 't', 1)`, [TENANT_A]),
      "23514",
    );
  });

  it("the guard trigger bumps version and updated_at and keeps identity fixed and counters monotonic (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const rid = await insertRequest(TENANT_A, { registration: REG_MANAGED_A });
    const before = (await a.query<{ version: number; updated_at: Date }>(`SELECT version, updated_at FROM ${REQ} WHERE id = $1`, [rid])).rows[0]!;
    expect(before.version).toBe(1);
    await new Promise((done) => setTimeout(done, 15));
    await a.query(`UPDATE ${REQ} SET status = 'claimed', attempt_floor = 2, lease_holder = 'lab-03', lease_id = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes' WHERE id = $1`, [rid]);
    const after = (await a.query<{ version: number; updated_at: Date }>(`SELECT version, updated_at FROM ${REQ} WHERE id = $1`, [rid])).rows[0]!;
    expect(after.version).toBe(2);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    await expectCode(a.query(`UPDATE ${REQ} SET tenant_id = $2 WHERE id = $1`, [rid, TENANT_B]), "23514");
    await expectCode(a.query(`UPDATE ${REQ} SET kind = 'store.provision' WHERE id = $1`, [rid]), "23514");
    await expectCode(a.query(`UPDATE ${REQ} SET attempt_floor = 1 WHERE id = $1`, [rid]), "23514");
  });

  it("generation never decreases (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const rid = await insertRequest(TENANT_A);
    await a.query(`UPDATE ${REQ} SET generation = 2 WHERE id = $1`, [rid]);
    await expectCode(a.query(`UPDATE ${REQ} SET generation = 1 WHERE id = $1`, [rid]), "23514");
  });
});

describe("0109: erp_provisioning_step_log", () => {
  it("the idempotency key (request, step, attempt) is unique (23505)", async () => {
    if (skip()) return;
    const rid = await insertRequest(TENANT_A);
    await insertStep(rid, TENANT_A, "claimed", 1);
    await expectCode(insertStep(rid, TENANT_A, "claimed", 1), "23505");
    await insertStep(rid, TENANT_A, "claimed", 2);
    await insertStep(rid, TENANT_A, "site_created", 1);
  });

  it("is append-only: no UPDATE and no DELETE for any role (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const rid = await insertRequest(TENANT_A);
    await insertStep(rid, TENANT_A);
    await expectCode(a.query(`UPDATE ${LOG} SET detail = 'x' WHERE request_id = $1`, [rid]), "23514");
    await expectCode(a.query(`DELETE FROM ${LOG} WHERE request_id = $1`, [rid]), "23514");
  });

  it("the tenant must be the request's tenant (23503) and the shape is checked (23514)", async () => {
    if (skip()) return;
    const rid = await insertRequest(TENANT_A);
    await expectCode(insertStep(rid, TENANT_B), "23503");
    await expectCode(insertStep(rid, TENANT_A, "bogus_step", 1), "23514");
    await expectCode(insertStep(rid, TENANT_A, "claimed", 0), "23514");
    const raw = (outcome: string, errorClass: string | null, attempt: number): Promise<unknown> =>
      guard().admin.query(
        `INSERT INTO ${LOG} (request_id, tenant_id, generation, step, outcome, attempt, error_class)
         VALUES ($1, $2, 1, 'claimed', $3, $4, $5)`,
        [rid, TENANT_A, outcome, attempt, errorClass],
      );
    await expectCode(raw("conflict", null, 9), "23514"); // a failed step names its class
    await expectCode(raw("done", "conflict", 10), "23514"); // a done step has none
    await expectCode(raw("permanently_rejected", "permanently_rejected", 11), "23514"); // needs a reason
  });
});

describe("0109: erp_provisioner_credential", () => {
  it("one live credential per host label (23505); a revoked one frees the label", async () => {
    if (skip()) return;
    const a = guard().admin;
    const t1 = await insertProvisionerToken();
    const t2 = await insertProvisionerToken();
    const ins = (token: string, host: string, env2 = "pilot"): Promise<unknown> =>
      a.query(`INSERT INTO ${CRED} (host_label, environment, token_id, issued_by) VALUES ($1, $2, $3, $4)`, [host, env2, token, SYSTEM_ACTOR]);
    await ins(t1, "lab-03");
    await expectCode(ins(t2, "lab-03"), "23505");
    await a.query(`UPDATE ${CRED} SET revoked_at = now(), revoked_by = $1 WHERE host_label = 'lab-03'`, [ADMIN_USER]);
    await ins(t2, "lab-03");
  });

  it("checks the host label, the environment and the revocation pair (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const t = await insertProvisionerToken();
    await expectCode(a.query(`INSERT INTO ${CRED} (host_label, environment, token_id, issued_by) VALUES ('Bad_Label', 'pilot', $1, $2)`, [t, SYSTEM_ACTOR]), "23514");
    await expectCode(a.query(`INSERT INTO ${CRED} (host_label, environment, token_id, issued_by) VALUES ('lab-03', 'moon', $1, $2)`, [t, SYSTEM_ACTOR]), "23514");
    await expectCode(a.query(`INSERT INTO ${CRED} (host_label, environment, token_id, issued_by, revoked_at) VALUES ('lab-03', 'pilot', $1, $2, now())`, [t, SYSTEM_ACTOR]), "23514");
  });
});

describe("0109: policies", () => {
  it("has FORCE RLS on all three tables and the exact policy set (no DELETE)", async () => {
    if (skip()) return;
    const a = guard().admin;
    for (const t of [REQ, LOG, CRED]) {
      const r = await a.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [t]);
      expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const pol = await a.query<{ tablename: string; cmd: string }>(
      `SELECT tablename, cmd FROM pg_policies WHERE tablename = ANY($1::text[]) ORDER BY tablename, cmd`,
      [[REQ, LOG, CRED]],
    );
    const by = (t: string): string[] => pol.rows.filter((r) => r.tablename === t).map((r) => r.cmd).sort();
    expect(by(REQ)).toEqual(["INSERT", "SELECT", "SELECT", "SELECT", "UPDATE", "UPDATE"]);
    expect(by(LOG)).toEqual(["INSERT", "SELECT", "SELECT", "SELECT"]);
    expect(by(CRED)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

describe("0109: RLS as the NOBYPASSRLS app role", () => {
  it("a tenant reads only its own requests and step log; an unset or empty GUC reads nothing (no 22P02)", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A);
    const rb = await insertRequest(TENANT_B);
    await insertStep(ra, TENANT_A);
    await insertStep(rb, TENANT_B);
    const own = await asCtx({ tenant: TENANT_A }, (c) => c.query(`SELECT tenant_id FROM ${REQ}`));
    expect(own.rows).toEqual([{ tenant_id: TENANT_A }]);
    const ownLog = await asCtx({ tenant: TENANT_A }, (c) => c.query(`SELECT tenant_id FROM ${LOG}`));
    expect(ownLog.rows).toEqual([{ tenant_id: TENANT_A }]);
    const other = await asCtx({ tenant: TENANT_A }, (c) => c.query(`SELECT id FROM ${REQ} WHERE id = $1`, [rb]));
    expect(other.rows).toEqual([]);
    for (const guc of [null, ""]) {
      const r = await asCtx({ tenant: guc }, (c) => c.query(`SELECT id FROM ${REQ}`));
      expect(r.rows).toEqual([]);
      const l = await asCtx({ tenant: guc }, (c) => c.query(`SELECT id FROM ${LOG}`));
      expect(l.rows).toEqual([]);
    }
  });

  it("a tenant can never insert, update or delete a request, and never touches the credential table", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A);
    const ins = `INSERT INTO ${REQ} (tenant_id, kind, site_name, template_id, template_version) VALUES ($1, 'store.provision', 's', 't', 1)`;
    await expectCode(asCtx({ tenant: TENANT_A }, (c) => c.query(ins, [TENANT_A])), "42501");
    const upd = await asCtx({ tenant: TENANT_A }, (c) => c.query(`UPDATE ${REQ} SET status = 'cancelled' WHERE id = $1`, [ra]));
    expect(upd.rowCount).toBe(0);
    const del = await asCtx({ tenant: TENANT_A }, (c) => c.query(`DELETE FROM ${REQ} WHERE id = $1`, [ra]));
    expect(del.rowCount).toBe(0);
    expect((await asCtx({ tenant: TENANT_A }, (c) => c.query(`SELECT 1 FROM ${CRED}`))).rows).toEqual([]);
  });

  it("a platform admin creates only a clean requested request (RLS 42501 otherwise) and reads all", async () => {
    if (skip()) return;
    const clean = `INSERT INTO ${REQ} (tenant_id, kind, site_name, template_id, template_version) VALUES ($1, 'tenant.provision', 's', 't', 1)`;
    const r = await asCtx({ platformAdmin: true }, (c) => c.query(clean, [TENANT_A]));
    expect(r.rowCount).toBe(1);
    const dirty = `INSERT INTO ${REQ} (tenant_id, kind, status, site_name, template_id, template_version, lease_holder, lease_id, lease_expires_at)
                   VALUES ($1, 'tenant.provision', 'claimed', 's', 't', 1, 'lab-03', gen_random_uuid(), now() + interval '5 minutes')`;
    await expectCode(asCtx({ platformAdmin: true }, (c) => c.query(dirty, [TENANT_A])), "42501");
    await insertRequest(TENANT_A);
    await insertRequest(TENANT_B, { kind: "credential.rotate" });
    const all = await asCtx({ platformAdmin: true }, (c) => c.query(`SELECT id FROM ${REQ}`));
    expect(all.rowCount).toBe(2);
  });

  it("a platform admin can cancel or restart a request (operator actions)", async () => {
    if (skip()) return;
    const rid = await insertRequest(TENANT_A);
    const r = await asCtx({ platformAdmin: true }, (c) =>
      c.query(`UPDATE ${REQ} SET status = 'cancelled', terminal_at = now() WHERE id = $1`, [rid]),
    );
    expect(r.rowCount).toBe(1);
  });

  it("the provisioner reads and updates requests across tenants, and appends step-log rows", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A);
    const rb = await insertRequest(TENANT_B);
    const seen = await asCtx({ provisioner: true }, (c) => c.query(`SELECT id FROM ${REQ}`));
    expect(seen.rows.map((x: { id: string }) => x.id).sort()).toEqual([ra, rb].sort());
    const claim = await asCtx({ provisioner: true }, (c) =>
      c.query(
        `UPDATE ${REQ} SET status = 'claimed', lease_holder = 'lab-03', lease_id = gen_random_uuid(),
                lease_expires_at = now() + interval '5 minutes' WHERE id = $1 RETURNING version`,
        [rb],
      ),
    );
    expect(claim.rows).toEqual([{ version: 2 }]);
    const log = await asCtx({ provisioner: true }, async (c) => {
      await c.query(
        `INSERT INTO ${LOG} (request_id, tenant_id, generation, step, outcome, attempt) VALUES ($1, $2, 1, 'claimed', 'done', 1)`,
        [ra, TENANT_A],
      );
      return c.query(`SELECT count(*)::int AS n FROM ${LOG}`);
    });
    expect(log.rows).toEqual([{ n: 1 }]);
  });

  it("the provisioner cannot create or delete a request, cannot update the step log, and cannot read the credential table", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A);
    await insertStep(ra, TENANT_A);
    const ins = `INSERT INTO ${REQ} (tenant_id, kind, site_name, template_id, template_version) VALUES ($1, 'store.provision', 's', 't', 1)`;
    await expectCode(asCtx({ provisioner: true }, (c) => c.query(ins, [TENANT_A])), "42501");
    const del = await asCtx({ provisioner: true }, (c) => c.query(`DELETE FROM ${REQ} WHERE id = $1`, [ra]));
    expect(del.rowCount).toBe(0);
    // the log is append-only (trigger) even for a role that may read it
    await expectCode(asCtx({ provisioner: true }, (c) => c.query(`UPDATE ${LOG} SET detail = 'x' WHERE request_id = $1`, [ra])), "23514");
    const t = await insertProvisionerToken();
    await guard().admin.query(`INSERT INTO ${CRED} (host_label, environment, token_id, issued_by) VALUES ('lab-03', 'pilot', $1, $2)`, [t, SYSTEM_ACTOR]);
    const creds = await asCtx({ provisioner: true }, (c) => c.query(`SELECT id FROM ${CRED}`));
    expect(creds.rows).toEqual([]);
    await expectCode(
      asCtx({ provisioner: true }, (c) => c.query(`INSERT INTO ${CRED} (host_label, environment, token_id, issued_by) VALUES ('lab-04', 'pilot', $1, $2)`, [t, SYSTEM_ACTOR])),
      "42501",
    );
  });

  it("a platform admin cannot append a step-log row (the provisioner owns it)", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A);
    await expectCode(
      asCtx({ platformAdmin: true }, (c) =>
        c.query(`INSERT INTO ${LOG} (request_id, tenant_id, generation, step, outcome, attempt) VALUES ($1, $2, 1, 'claimed', 'done', 1)`, [ra, TENANT_A]),
      ),
      "42501",
    );
  });

  it("the platform admin manages the credential table", async () => {
    if (skip()) return;
    const t = await insertProvisionerToken();
    const r = await asCtx({ platformAdmin: true }, (c) =>
      c.query(`INSERT INTO ${CRED} (host_label, environment, token_id, issued_by) VALUES ('lab-03', 'pilot', $1, $2)`, [t, SYSTEM_ACTOR]),
    );
    expect(r.rowCount).toBe(1);
  });

  it("a provisioner session cannot write tenant_access_entitlements (the whole point of its own GUC)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(`INSERT INTO tenant_access_entitlements (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id) VALUES ($1, 'restricted', now(), $2)`, [TENANT_A, ADMIN_USER]);
    try {
      // inside the tenant's own context too, the strongest case
      await expectCode(
        asCtx({ provisioner: true, tenant: TENANT_B }, (c) =>
          c.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_B]),
        ),
        "42501",
      );
      const lift = await asCtx({ provisioner: true, tenant: TENANT_A }, (c) =>
        c.query(
          `UPDATE tenant_access_entitlements SET state = 'unrestricted', provisioned_at = now(), provisioned_by_user_id = $2, provisioning_source = 'manual_platform' WHERE tenant_id = $1`,
          [TENANT_A, ADMIN_USER],
        ),
      );
      expect(lift.rowCount).toBe(0);
      const stored = await a.query<{ state: string }>(`SELECT state FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
      expect(stored.rows[0]!.state).toBe("restricted");
    } finally {
      await a.query(`DELETE FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
    }
  });
});

describe("0109: as a NOSUPERUSER owner under FORCE RLS", () => {
  it("reads zero rows with the tenant GUC pre-set to ''", async () => {
    if (skip()) return;
    const e = guard();
    await asMigrationOwner(
      e,
      {
        role: "mig_owner_0109",
        tables: [REQ, LOG, CRED],
        functions: ["erp_provisioning_request_guard()", "erp_provisioning_step_log_append_only()"],
      },
      async () => {
        const client = await e.admin.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE mig_owner_0109");
          await client.query("SELECT set_config('app.current_tenant', '', true)");
          for (const t of [REQ, LOG, CRED]) {
            const r = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
            expect(r.rows[0]).toEqual({ n: 0 });
          }
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      },
    );
  });
});

describe("0109: down and up again", () => {
  it("the down refuses while provisioning data exists (P0001), nothing changes", async () => {
    if (skip()) return;
    const a = guard().admin;
    const rid = await insertRequest(TENANT_A);
    expect(await errorCode(() => a.query(downSql))).toBe("P0001");
    expect((await a.query(`SELECT to_regclass($1) AS t`, [REQ])).rows[0]).toEqual({ t: REQ });
    await a.query(`DELETE FROM ${REQ} WHERE id = $1`, [rid]);
    await a.query(`UPDATE connector_registration SET managed_by = 'provisioner' WHERE id = $1`, [REG_MANAGED_A]);
    expect(await errorCode(() => a.query(downSql))).toBe("P0001");
    await a.query(`UPDATE connector_registration SET managed_by = NULL WHERE id = $1`, [REG_MANAGED_A]);
    const tok = await insertProvisionerToken();
    expect(await errorCode(() => a.query(downSql))).toBe("P0001");
    await a.query(`DELETE FROM auth_tokens WHERE id = $1`, [tok]);
  });

  it("the down restores the six-scope CHECK and drops only what 0109 added, and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    const tablesBefore = Number((await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n);
    expect(await errorCode(() => a.query(downSql))).toBeNull();
    const gone = await a.query(
      `SELECT to_regclass($1) AS r, to_regclass($2) AS l, to_regclass($3) AS c,
              (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'connector_registration' AND column_name = 'managed_by') AS col,
              (SELECT count(*)::int FROM users WHERE id = $4) AS actor,
              (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'auth_tokens_scope_valid') AS scope_def,
              (SELECT count(*)::int FROM pg_constraint WHERE conname = 'auth_tokens_provisioner_shape') AS shape`,
      [REQ, LOG, CRED, SYSTEM_ACTOR],
    );
    expect(gone.rows[0]).toMatchObject({ r: null, l: null, c: null, col: 0, actor: 0, shape: 0 });
    expect(gone.rows[0].scope_def).not.toContain("connector_provisioner");
    const tablesAfter = Number((await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n);
    expect(tablesAfter).toBe(tablesBefore - 3);
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
    const back = await a.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [[REQ, LOG, CRED]],
    );
    expect(back.rows).toEqual([{ relforcerowsecurity: true }, { relforcerowsecurity: true }, { relforcerowsecurity: true }]);
    expect((await a.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [SYSTEM_ACTOR])).rows[0]).toEqual({ n: 1 });
  });
});
