/**
 * RT-1457 / audit A-04 (RT-1389 phase 2): `0120_membership_bootstrap_policies` migration test
 * (`[GATED: migration]`).
 *
 * Validates `packages/db/drizzle/0120_membership_bootstrap_policies.sql` (+ `.down.sql`) on a real
 * PostgreSQL, applied on top of every earlier migration, as the NOBYPASSRLS app role and through
 * the real `runWithSystemPrivilege` helper:
 *   - the five policies exist, are SELECT-only and PERMISSIVE, and name `app.system_privilege`
 *     and never `app.is_platform_admin`;
 *   - under `membership_bootstrap` a session reads memberships, roles, tenants, stores and
 *     store_access ACROSS tenants (nil tenant pin), exactly what the platform-admin bootstrap
 *     read returned (parity of the real bootstrap query);
 *   - it cannot INSERT, UPDATE or DELETE on any of the five tables (the privilege adds no write path);
 *   - it reaches no other table (access state, provisioning, signups, credentials, audit), each
 *     seeded with a row so "0 rows" is not vacuous;
 *   - an unpinned session (empty tenant GUC) still raises 22P02: the pin is mandatory;
 *   - another privilege (`signup`) does not read the membership tables, and a value that is not
 *     exactly `membership_bootstrap` matches nothing;
 *   - the existing platform-admin and tenant policies are unchanged (additive);
 *   - the down drops only the five policies, and the up re-applies cleanly.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1
 * (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { runWithSystemPrivilege, type SystemPrivilege } from "../../src/middleware/system-privilege";
import { applyMigrationsBefore, asApp, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { MEMBERSHIP_BOOTSTRAP_POLICIES } from "../cli/migrations/0120_membership_bootstrap_policies";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0120_membership_bootstrap_policies.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0120_membership_bootstrap_policies.down.sql");

const id = (n: string): string => `12000000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const USER_A = id("0a0c1");
const USER_B = id("0b0c1");
const ROLE_A = id("0a0d1");
const ROLE_B = id("0b0d1");
const STORE_A = id("0a0e1");
const STORE_B = id("0b0e1");
const MEM_A = id("0a0f1");
const MEM_B = id("0b0f1");
const NIL = "00000000-0000-0000-0000-000000000000";
/** The seeded system actor the provisioner token shape requires (as in the 0111 spec). */
const SYSTEM_ACTOR = "00000000-0000-7000-8000-000000001357";
const TABLES = ["memberships", "roles", "tenants", "stores", "store_access"] as const;
/** Rows the fixture holds in each of the five tables (two tenants). */
const FIXTURE_ROWS: Record<(typeof TABLES)[number], number> = { memberships: 2, roles: 2, tenants: 2, stores: 2, store_access: 2 };

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** A rolled-back app-role session carrying `value` as the privilege (any string), never platform admin. */
function asValue<T>(tenant: string | null, value: string, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return asApp(guard(), tenant ?? NIL, async (client) => {
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    await client.query("SELECT set_config('app.system_privilege', $1, true)", [value]);
    return await work(client);
  });
}

/** The real helper on the app pool; `work` throws ROLLBACK to keep the fixtures clean. */
class Rollback extends Error {}
async function asPrivilege<T>(tenant: string | null, privilege: SystemPrivilege, work: (c: PoolClient) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await runWithSystemPrivilege(guard().app, { tenantId: tenant, privilege }, async (client) => {
      out = await work(client);
      throw new Rollback();
    });
  } catch (err: unknown) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out as T;
}

/** The pre-0120 bootstrap read: the platform-admin flag with the nil tenant pin, as the guards did. */
function asPlatformAdminBootstrap<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
  return asApp(guard(), NIL, async (client) => {
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    return await work(client);
  });
}

const count = async (c: PoolClient, table: string): Promise<number> =>
  (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

/** The bootstrap query of `findRoleCodeForUserInTenant` (memberships + tenants + roles). */
const ROLE_CODE_SQL = `
  SELECT r.code FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    JOIN roles r ON r.id = m.role_id
   WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.revoked_at IS NULL AND m.deleted_at IS NULL
     AND t.status = 'active' AND t.deleted_at IS NULL
   LIMIT 1`;
/** The sign-in / context list (`activeMembershipRows`) for one user. */
const MEMBERSHIP_LIST_SQL = `
  SELECT m.tenant_id, t.name, r.code, m.store_access_kind FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    JOIN roles r ON r.id = m.role_id
   WHERE m.user_id = $1 AND m.revoked_at IS NULL AND m.deleted_at IS NULL AND t.status = 'active' AND t.deleted_at IS NULL
   ORDER BY m.tenant_id`;
/** The POS stuck-shift lookup. */
const POS_LOOKUP_SQL = `
  SELECT m.id, m.tenant_id, m.store_access_kind, r.code AS role_code FROM memberships m
    JOIN roles r ON r.id = m.role_id
    JOIN stores s ON s.tenant_id = m.tenant_id AND s.id = $1
   WHERE m.user_id = $2 AND m.revoked_at IS NULL AND m.deleted_at IS NULL LIMIT 1`;
const STORE_ACCESS_SQL = `
  SELECT sa.store_id FROM store_access sa JOIN stores s ON s.id = sa.store_id
   WHERE sa.membership_id = $1 AND sa.tenant_id = $2 AND s.tenant_id = $2 AND s.deleted_at IS NULL`;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
    const a = env.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'mb-a', 'MB A', 'USD'), ($2, 'mb-b', 'MB B', 'USD')`,
      [TENANT_A, TENANT_B],
    );
    await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'mb-a@fixture.invalid', 'x'), ($2, 'mb-b@fixture.invalid', 'x')`, [USER_A, USER_B]);
    await a.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'cashier', 'Cashier A'), ($3, $4, 'tenant_admin', 'Admin B')`, [
      ROLE_A,
      TENANT_A,
      ROLE_B,
      TENANT_B,
    ]);
    await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'mb-a-1', 'Store A'), ($3, $4, 'mb-b-1', 'Store B')`, [
      STORE_A,
      TENANT_A,
      STORE_B,
      TENANT_B,
    ]);
    await a.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, 'specific'), ($5, $6, $7, $8, 'specific')`,
      [MEM_A, TENANT_A, USER_A, ROLE_A, MEM_B, TENANT_B, USER_B, ROLE_B],
    );
    await a.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      MEM_A,
      STORE_A,
      TENANT_A,
      MEM_B,
      STORE_B,
      TENANT_B,
    ]);
    await a.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted'), ($2, 'restricted')`, [TENANT_A, TENANT_B]);
    await a.query(
      `INSERT INTO erp_provisioning_request (tenant_id, kind, site_name, template_id, template_version)
       VALUES ($1, 'tenant.provision', 'mb-site', 'egypt-retail', 1)`,
      [TENANT_A],
    );
    await a.query(
      `INSERT INTO pending_signups (id, email_normalized, name, business_name, terms_version, terms_accepted_at, ip_hash, expires_at)
       VALUES (gen_random_uuid(), 'mb@fixture.invalid', 'N', 'B', 'v1', now(), 'h', now() + interval '1 day')`,
    );
    await a.query(`INSERT INTO audit_events (id, tenant_id, action) VALUES (gen_random_uuid(), $1, 'mb.fixture')`, [TENANT_A]);
    const tok = await a.query<{ id: string }>(
      `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
       VALUES (gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), NULL, $1, 'connector_provisioner', now() + interval '30 days') RETURNING id`,
      [SYSTEM_ACTOR],
    );
    await a.query(`INSERT INTO erp_provisioner_credential (host_label, environment, token_id, issued_by) VALUES ('lab-mb', 'dev', $1, $2)`, [tok.rows[0]!.id, SYSTEM_ACTOR]);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0120-membership-bootstrap-policies.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0120: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0120: policy texts", () => {
  it("adds exactly the five named policies, each SELECT-only and PERMISSIVE", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ policyname: string; tablename: string; cmd: string; permissive: string }>(
      `SELECT policyname, tablename, cmd, permissive FROM pg_policies WHERE policyname = ANY($1::text[]) ORDER BY policyname`,
      [MEMBERSHIP_BOOTSTRAP_POLICIES],
    );
    expect(r.rows.map((x) => x.policyname).sort()).toEqual([...MEMBERSHIP_BOOTSTRAP_POLICIES].sort());
    expect(r.rows.map((x) => x.tablename).sort()).toEqual([...TABLES].sort());
    expect(r.rows.every((x) => x.cmd === "SELECT" && x.permissive === "PERMISSIVE")).toBe(true);
  });

  it("every policy on `membership_bootstrap` names app.system_privilege, never app.is_platform_admin, and no platform-admin policy names app.system_privilege", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ policyname: string; text: string }>(
      `SELECT policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS text FROM pg_policies WHERE schemaname = 'public'`,
    );
    const mine = r.rows.filter((p) => MEMBERSHIP_BOOTSTRAP_POLICIES.includes(p.policyname));
    expect(mine).toHaveLength(5);
    for (const p of mine) {
      expect(p.text).toContain("app.system_privilege");
      expect(p.text).toContain("membership_bootstrap");
      expect(p.text).not.toContain("app.is_platform_admin");
    }
    const priv = r.rows.filter((p) => p.text.includes("app.system_privilege"));
    expect(priv.filter((p) => p.text.includes("app.is_platform_admin"))).toEqual([]);
  });

  it("leaves the existing isolation policies on the five tables as they were (additive)", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE tablename = ANY($1::text[]) AND policyname <> ALL($2::text[]) ORDER BY policyname`,
      [[...TABLES], MEMBERSHIP_BOOTSTRAP_POLICIES],
    );
    expect(r.rows.map((x) => x.policyname)).toEqual([
      "memberships_tenant_isolation",
      "roles_tenant_isolation",
      "store_access_tenant_isolation",
      "stores_tenant_isolation",
      "tenants_tenant_isolation",
    ]);
  });
});

describe("0120: runWithSystemPrivilege accepts the new value", () => {
  it("sets membership_bootstrap, forces platform admin off and never sets the provisioner flag", async () => {
    if (skip()) return;
    const seen = await asPrivilege(null, "membership_bootstrap", async (c) => {
      const r = await c.query(
        `SELECT current_setting('app.system_privilege', true) AS priv, current_setting('app.is_platform_admin', true) AS admin,
                coalesce(current_setting('app.is_provisioner', true), '') AS prov`,
      );
      return r.rows[0];
    });
    expect(seen).toEqual({ priv: "membership_bootstrap", admin: "false", prov: "" });
  });
});

describe("0120: membership_bootstrap reads across tenants", () => {
  it.each(TABLES)("reads every tenant's rows of %s with no tenant pin", async (table) => {
    if (skip()) return;
    expect(await asPrivilege(null, "membership_bootstrap", (c) => count(c, table))).toBe(FIXTURE_ROWS[table]);
  });

  it("returns the same rows as the platform-admin bootstrap for the real bootstrap queries (behaviour unchanged)", async () => {
    if (skip()) return;
    const run = async (c: PoolClient): Promise<unknown> => ({
      role_a: (await c.query(ROLE_CODE_SQL, [USER_A, TENANT_A])).rows,
      role_b: (await c.query(ROLE_CODE_SQL, [USER_B, TENANT_B])).rows,
      role_cross: (await c.query(ROLE_CODE_SQL, [USER_A, TENANT_B])).rows,
      list_a: (await c.query(MEMBERSHIP_LIST_SQL, [USER_A])).rows,
      list_b: (await c.query(MEMBERSHIP_LIST_SQL, [USER_B])).rows,
      pos: (await c.query(POS_LOOKUP_SQL, [STORE_B, USER_B])).rows,
      pos_wrong_store: (await c.query(POS_LOOKUP_SQL, [STORE_A, USER_B])).rows,
      grants: (await c.query(STORE_ACCESS_SQL, [MEM_A, TENANT_A])).rows,
    });
    const viaPrivilege = await asPrivilege(null, "membership_bootstrap", run);
    const viaAdmin = await asPlatformAdminBootstrap(run);
    expect(viaPrivilege).toEqual(viaAdmin);
    const seen = viaPrivilege as { role_a: { code: string }[]; role_b: { code: string }[]; role_cross: unknown[]; list_a: unknown[]; pos_wrong_store: unknown[]; grants: unknown[] };
    expect(seen.role_a).toEqual([{ code: "cashier" }]);
    expect(seen.role_b).toEqual([{ code: "tenant_admin" }]);
    expect(seen.role_cross).toEqual([]); // the query's own predicates still decide, RLS only lets it read
    expect(seen.list_a).toHaveLength(1);
    expect(seen.pos_wrong_store).toEqual([]);
    expect(seen.grants).toEqual([{ store_id: STORE_A }]);
  });

  it("also reads when the transaction is pinned to a tenant (the policy is not tied to the pin)", async () => {
    if (skip()) return;
    expect(await asPrivilege(TENANT_A, "membership_bootstrap", (c) => count(c, "memberships"))).toBe(2);
  });
});

describe("0120: membership_bootstrap cannot write", () => {
  it.each([
    ["memberships", `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES (gen_random_uuid(), '${TENANT_A}', '${USER_B}', '${ROLE_A}', 'all')`],
    ["roles", `INSERT INTO roles (id, tenant_id, code, name) VALUES (gen_random_uuid(), '${TENANT_A}', 'extra', 'Extra')`],
    ["tenants", `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES (gen_random_uuid(), 'mb-new', 'MB New', 'USD')`],
    ["stores", `INSERT INTO stores (id, tenant_id, code, name) VALUES (gen_random_uuid(), '${TENANT_A}', 'extra', 'Extra')`],
    ["store_access", `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ('${MEM_A}', '${STORE_A}', '${TENANT_A}')`],
  ])("INSERT into %s is denied by row-level security", async (_table, sql) => {
    if (skip()) return;
    expect(await errorCode(() => asPrivilege(null, "membership_bootstrap", (c) => c.query(sql)))).toBe("42501");
  });

  it("pinned to tenant A it still cannot write another tenant's rows (the privilege adds no write, the pin only grants A's own)", async () => {
    if (skip()) return;
    const pinned = (sql: string): Promise<string | null> => errorCode(() => asPrivilege(TENANT_A, "membership_bootstrap", (c) => c.query(sql)));
    expect(await pinned(`INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES (gen_random_uuid(), '${TENANT_B}', '${USER_A}', '${ROLE_B}', 'all')`)).toBe("42501");
    expect(await pinned(`INSERT INTO roles (id, tenant_id, code, name) VALUES (gen_random_uuid(), '${TENANT_B}', 'extra', 'Extra')`)).toBe("42501");
    expect(await pinned(`INSERT INTO stores (id, tenant_id, code, name) VALUES (gen_random_uuid(), '${TENANT_B}', 'extra', 'Extra')`)).toBe("42501");
    const upd = await asPrivilege(TENANT_A, "membership_bootstrap", (c) => c.query(`UPDATE roles SET name = 'x' WHERE tenant_id = '${TENANT_B}'`));
    expect(upd.rowCount).toBe(0);
  });

  it.each([
    ["memberships", `UPDATE memberships SET store_access_kind = 'all'`],
    ["roles", `UPDATE roles SET name = 'x'`],
    ["tenants", `UPDATE tenants SET name = 'x'`],
    ["stores", `UPDATE stores SET name = 'x'`],
    ["store_access", `UPDATE store_access SET store_id = store_id`],
  ])("UPDATE of %s affects no row", async (_table, sql) => {
    if (skip()) return;
    const r = await asPrivilege(null, "membership_bootstrap", (c) => c.query(sql));
    expect(r.rowCount).toBe(0);
  });

  it.each(TABLES)("DELETE from %s affects no row, and the rows are still there", async (table) => {
    if (skip()) return;
    const r = await asPrivilege(null, "membership_bootstrap", (c) => c.query(`DELETE FROM ${table}`));
    expect(r.rowCount).toBe(0);
    expect((await guard().admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === "tenants" ? "id" : "tenant_id"} = ANY($1::uuid[])`, [[TENANT_A, TENANT_B]])).rows[0]!.n).toBe(
      FIXTURE_ROWS[table],
    );
  });
});

describe("0120: membership_bootstrap reaches nothing else", () => {
  it.each(["tenant_access_entitlements", "erp_provisioning_request", "pending_signups", "erp_provisioner_credential", "audit_events"])(
    "reads 0 rows of %s, which holds a row",
    async (table) => {
      if (skip()) return;
      // Control: the table is not empty (the admin connection bypasses RLS).
      expect((await guard().admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBeGreaterThan(0);
      expect(await asPrivilege(null, "membership_bootstrap", (c) => count(c, table))).toBe(0);
    },
  );

  it("another privilege (signup, provisioning_sweep, provisioner_lookup) does not read the membership tables", async () => {
    if (skip()) return;
    for (const privilege of ["signup", "provisioning_sweep", "provisioner_lookup"] as const) {
      for (const table of TABLES) expect(await asPrivilege(null, privilege, (c) => count(c, table))).toBe(0);
    }
  });
});

describe("0120: the tenant pin stays mandatory", () => {
  it("a membership_bootstrap session with an empty tenant GUC raises 22P02 (the existing isolation policies still cast)", async () => {
    if (skip()) return;
    const code = await errorCode(() =>
      asApp(guard(), "", async (c) => {
        await c.query("SELECT set_config('app.is_platform_admin', 'false', true)");
        await c.query("SELECT set_config('app.system_privilege', 'membership_bootstrap', true)");
        return await count(c, "memberships");
      }),
    );
    expect(code).toBe("22P02");
  });
});

describe("0120: values that are not the privilege", () => {
  it.each(["", "MEMBERSHIP_BOOTSTRAP", "membership_bootstrap ", "true", "platform_admin", "signup"])("%j matches nothing", async (value) => {
    if (skip()) return;
    await asValue(null, value, async (c) => {
      for (const table of TABLES) expect(await count(c, table)).toBe(0);
    });
  });

  it("a session with no privilege and no admin flag reads nothing across tenants (tenant isolation unchanged)", async () => {
    if (skip()) return;
    const seen = await asApp(guard(), TENANT_A, (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM memberships`));
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
  });
});

describe("0120: platform admin is unchanged (additive)", () => {
  it("a genuine platform-admin session still reads and writes every tenant's rows", async () => {
    if (skip()) return;
    await asPlatformAdminBootstrap(async (c) => {
      for (const table of TABLES) expect(await count(c, table)).toBe(FIXTURE_ROWS[table]);
      const up = await c.query(`UPDATE roles SET name = name`);
      expect(up.rowCount).toBe(2);
    });
  });
});

describe("0120: down and up again", () => {
  it("the down drops only the five policies (the session sees nothing) and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    const before = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
    await a.query(downSql);
    const after = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
    expect(before.rows[0]!.n - after.rows[0]!.n).toBe(MEMBERSHIP_BOOTSTRAP_POLICIES.length);
    expect(await asPrivilege(null, "membership_bootstrap", (c) => count(c, "memberships"))).toBe(0);
    expect(await asPlatformAdminBootstrap((c) => count(c, "memberships"))).toBe(2);
    expect(await errorCode(() => a.query(downSql))).toBeNull();
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
    expect(await asPrivilege(null, "membership_bootstrap", (c) => count(c, "memberships"))).toBe(2);
  });
});
