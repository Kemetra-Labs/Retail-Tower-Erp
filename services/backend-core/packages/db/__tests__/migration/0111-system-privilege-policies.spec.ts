/**
 * RT-1389 Phase 1: `0111_system_privilege_policies` migration test (owner go-ahead for the
 * gated migration, 2026-11-14, RT-1389 comment 16972).
 *
 * Validates `packages/db/drizzle/0111_system_privilege_policies.sql` (+ `.down.sql`) on a real
 * PostgreSQL (Testcontainers), applied on top of every earlier migration, as the NOBYPASSRLS
 * app role and through the real `runWithSystemPrivilege` helper:
 *   - the helper sets the privilege, forces `app.is_platform_admin = 'false'`, never sets
 *     `app.is_provisioner`, rejects an unknown value and does not leak to the pool;
 *   - NAMED: a session on the signup or the sweep privilege cannot read another tenant's
 *     `tenant_access_entitlements` row (with no tenant: 0 rows; pinned to A: never B's row).
 *     The 0110 platform-wide SELECT stays a platform-admin-only read;
 *   - each privilege reaches only its own tables and commands (signup: pending_signups,
 *     user_consents, one `restricted` entitlement INSERT pinned to its tenant; sweep:
 *     erp_provisioning_request S/U; lookup: erp_provisioner_credential S);
 *   - no 0111 policy names `app.is_platform_admin`, and no platform-admin policy names
 *     `app.system_privilege`;
 *   - a value that is not exactly one of the three matches nothing;
 *   - the down drops only the nine policies, and the up re-applies cleanly.
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
import { SYSTEM_PRIVILEGE_POLICIES } from "../cli/migrations/0111_system_privilege_policies";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0111_system_privilege_policies.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0111_system_privilege_policies.down.sql");

const id = (n: string): string => `11100000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const TENANT_NEW = id("0c001");
const SYSTEM_ACTOR = "00000000-0000-7000-8000-000000001357";
const ENT = "tenant_access_entitlements";

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
  return asApp(guard(), tenant, async (client) => {
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    await client.query("SELECT set_config('app.system_privilege', $1, true)", [value]);
    return await work(client);
  });
}

/** The real helper, on the app pool; `work` throws ROLLBACK to keep the fixtures clean. */
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

const count = async (c: PoolClient, table: string): Promise<number> =>
  (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

const ids = async (c: PoolClient, sql: string): Promise<string[]> => (await c.query<{ id: string }>(sql)).rows.map((r) => r.id).sort();

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
    const a = env.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
         ($1, 'sp-a', 'SP A', 'USD'), ($2, 'sp-b', 'SP B', 'USD'), ($3, 'sp-new', 'SP New', 'USD')`,
      [TENANT_A, TENANT_B, TENANT_NEW],
    );
    await a.query(`INSERT INTO ${ENT} (tenant_id, state) VALUES ($1, 'restricted'), ($2, 'restricted')`, [TENANT_A, TENANT_B]);
    await a.query(
      `INSERT INTO pending_signups (id, email_normalized, name, business_name, terms_version, terms_accepted_at, ip_hash, expires_at)
       VALUES (gen_random_uuid(), 'sp@fixture.invalid', 'N', 'B', 'v1', now(), 'h', now() + interval '1 day')`,
    );
    for (const tenant of [TENANT_A, TENANT_B]) {
      await a.query(
        `INSERT INTO erp_provisioning_request (tenant_id, kind, site_name, template_id, template_version)
         VALUES ($1, 'tenant.provision', 'site-' || substr($1::text, 1, 8), 'egypt-retail', 1)`,
        [tenant],
      );
    }
    const tok = await a.query<{ id: string }>(
      `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
       VALUES (gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), NULL, $1, 'connector_provisioner', now() + interval '30 days') RETURNING id`,
      [SYSTEM_ACTOR],
    );
    await a.query(`INSERT INTO erp_provisioner_credential (host_label, environment, token_id, issued_by) VALUES ('lab-03', 'dev', $1, $2)`, [
      tok.rows[0]!.id,
      SYSTEM_ACTOR,
    ]);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0111-system-privilege-policies.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
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

describe("0111: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0111: policy texts", () => {
  it("adds the nine named policies", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ policyname: string }>(`SELECT policyname FROM pg_policies WHERE policyname = ANY($1::text[])`, [
      SYSTEM_PRIVILEGE_POLICIES,
    ]);
    expect(r.rows.map((x) => x.policyname).sort()).toEqual([...SYSTEM_PRIVILEGE_POLICIES].sort());
  });

  it("no policy names both app.system_privilege and app.is_platform_admin; every system_privilege policy is a 0111 one", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ policyname: string; text: string }>(
      `SELECT policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS text FROM pg_policies WHERE schemaname = 'public'`,
    );
    const priv = r.rows.filter((p) => p.text.includes("app.system_privilege"));
    expect(priv.filter((p) => p.text.includes("app.is_platform_admin"))).toEqual([]);
    expect(priv.map((p) => p.policyname).sort()).toEqual([...SYSTEM_PRIVILEGE_POLICIES].sort());
  });
});

describe("0111: runWithSystemPrivilege", () => {
  it("sets the privilege, forces platform admin off and never sets the provisioner flag", async () => {
    if (skip()) return;
    const seen = await asPrivilege(null, "signup", async (c) => {
      const r = await c.query(
        `SELECT current_setting('app.system_privilege', true) AS priv, current_setting('app.is_platform_admin', true) AS admin,
                coalesce(current_setting('app.is_provisioner', true), '') AS prov`,
      );
      return r.rows[0];
    });
    expect(seen).toEqual({ priv: "signup", admin: "false", prov: "" });
  });

  it("rejects an unknown privilege and does not leak to the next use of the pool", async () => {
    if (skip()) return;
    await expect(runWithSystemPrivilege(guard().app, { tenantId: null, privilege: "admin" as SystemPrivilege }, async () => 1)).rejects.toThrow(
      "unknown privilege",
    );
    await runWithSystemPrivilege(guard().app, { tenantId: null, privilege: "provisioning_sweep" }, async () => undefined);
    const r = await guard().app.query(`SELECT coalesce(current_setting('app.system_privilege', true), '') AS priv`);
    expect(r.rows[0].priv).toBe("");
  });
});

describe("0111: a signup or sweep session cannot read another tenant's access state (named)", () => {
  it.each<SystemPrivilege>(["signup", "provisioning_sweep", "provisioner_lookup"])("%s with no tenant reads 0 entitlement rows", async (privilege) => {
    if (skip()) return;
    expect(await asPrivilege(null, privilege, (c) => count(c, ENT))).toBe(0);
  });

  it.each<SystemPrivilege>(["signup", "provisioning_sweep"])("%s pinned to tenant A never reads tenant B's entitlement row", async (privilege) => {
    if (skip()) return;
    const seen = await asPrivilege(TENANT_A, privilege, (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${ENT}`));
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
  });

  it("a genuine platform-admin session still reads every row (0110 unchanged)", async () => {
    if (skip()) return;
    const r = await asApp(guard(), null, async (c) => {
      await c.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      return await count(c, ENT);
    });
    expect(r).toBe(2);
  });
});

describe("0111: signup", () => {
  it("reads, inserts and updates pending_signups and reads/inserts user_consents", async () => {
    if (skip()) return;
    await asPrivilege(null, "signup", async (c) => {
      expect(await count(c, "pending_signups")).toBe(1);
      const p = await c.query<{ id: string }>(
        `INSERT INTO pending_signups (id, email_normalized, name, business_name, terms_version, terms_accepted_at, ip_hash, expires_at)
         VALUES (gen_random_uuid(), 'sp2@fixture.invalid', 'N', 'B', 'v1', now(), 'h', now() + interval '1 day') RETURNING id`,
      );
      const up = await c.query(`UPDATE pending_signups SET status = 'expired' WHERE id = $1`, [p.rows[0]!.id]);
      expect(up.rowCount).toBe(1);
      await c.query(
        `INSERT INTO user_consents (id, user_id, terms_version, accepted_at, ip_hash, source) VALUES (gen_random_uuid(), $1, 'v1', now(), 'h', 'self_signup')`,
        [SYSTEM_ACTOR],
      );
      expect(await count(c, "user_consents")).toBe(1);
    });
  });

  it("inserts the restricted entitlement only for its pinned tenant, never another, never unrestricted; it cannot update one", async () => {
    if (skip()) return;
    await asPrivilege(TENANT_NEW, "signup", (c) => c.query(`INSERT INTO ${ENT} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_NEW]));
    expect(
      await errorCode(() => asPrivilege(TENANT_NEW, "signup", (c) => c.query(`INSERT INTO ${ENT} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_B]))),
    ).toBe("42501");
    expect(
      await errorCode(() => asPrivilege(TENANT_NEW, "signup", (c) => c.query(`INSERT INTO ${ENT} (tenant_id, state) VALUES ($1, 'unrestricted')`, [TENANT_NEW]))),
    ).toBe("42501");
    expect(
      await errorCode(() => asPrivilege(null, "signup", (c) => c.query(`INSERT INTO ${ENT} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_NEW]))),
    ).toBe("42501");
    const upd = await asPrivilege(TENANT_A, "signup", (c) => c.query(`UPDATE ${ENT} SET state = 'unrestricted' WHERE tenant_id = $1`, [TENANT_A]));
    expect(upd.rowCount).toBe(0);
  });

  it("reaches no provisioning table", async () => {
    if (skip()) return;
    await asPrivilege(null, "signup", async (c) => {
      expect(await count(c, "erp_provisioning_request")).toBe(0);
      expect(await count(c, "erp_provisioner_credential")).toBe(0);
    });
  });
});

describe("0111: provisioning_sweep", () => {
  it("reads and updates every tenant's request, and nothing else of its tables", async () => {
    if (skip()) return;
    await asPrivilege(null, "provisioning_sweep", async (c) => {
      expect(await count(c, "erp_provisioning_request")).toBe(2);
      const up = await c.query(`UPDATE erp_provisioning_request SET not_before = now()`);
      expect(up.rowCount).toBe(2);
      expect(await count(c, "erp_provisioner_credential")).toBe(0);
      expect(await count(c, "pending_signups")).toBe(0);
      expect(await count(c, "erp_provisioning_step_log")).toBe(0);
    });
  });

  it("cannot create a request", async () => {
    if (skip()) return;
    expect(
      await errorCode(() =>
        asPrivilege(TENANT_A, "provisioning_sweep", (c) =>
          c.query(`INSERT INTO erp_provisioning_request (tenant_id, kind, site_name, template_id, template_version) VALUES ($1, 'store.provision', 's', 't', 1)`, [TENANT_A]),
        ),
      ),
    ).toBe("42501");
  });
});

describe("0111: provisioner_lookup", () => {
  it("reads the credential store only, and cannot write it", async () => {
    if (skip()) return;
    await asPrivilege(null, "provisioner_lookup", async (c) => {
      expect(await count(c, "erp_provisioner_credential")).toBe(1);
      expect(await count(c, "erp_provisioning_request")).toBe(0);
      expect(await count(c, "pending_signups")).toBe(0);
      const up = await c.query(`UPDATE erp_provisioner_credential SET revoked_at = now(), revoked_by = $1`, [SYSTEM_ACTOR]);
      expect(up.rowCount).toBe(0);
    });
  });
});

describe("0111: values that are not a privilege", () => {
  it.each(["", "SIGNUP", "true", "signup ", "platform_admin"])("%j matches nothing", async (value) => {
    if (skip()) return;
    await asValue(null, value, async (c) => {
      expect(await count(c, "pending_signups")).toBe(0);
      expect(await count(c, "erp_provisioning_request")).toBe(0);
      expect(await count(c, "erp_provisioner_credential")).toBe(0);
    });
  });
});

describe("0111: down and up again", () => {
  it("the down drops only the nine policies (the sessions see nothing) and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    const before = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
    await a.query(downSql);
    const after = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
    expect(before.rows[0]!.n - after.rows[0]!.n).toBe(SYSTEM_PRIVILEGE_POLICIES.length);
    expect(await asPrivilege(null, "provisioning_sweep", (c) => ids(c, `SELECT id FROM erp_provisioning_request`))).toEqual([]);
    expect(await errorCode(() => a.query(downSql))).toBeNull();
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
    expect((await asPrivilege(null, "provisioning_sweep", (c) => ids(c, `SELECT id FROM erp_provisioning_request`))).length).toBe(2);
  });
});
