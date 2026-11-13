/**
 * RT-1350 slice 6a: `0110_tenant_access_entitlements_platform_select` migration test
 * (authority: the RT-1350 coordinator's approval under the owner's delegation,
 * 2026-11-13, RT-1350 comment 16874).
 *
 * Validates `packages/db/drizzle/0110_tenant_access_entitlements_platform_select.sql`
 * (+ `.down.sql`) on a real PostgreSQL (Testcontainers), applied on top of every earlier
 * migration:
 *   - the policy set is exactly SELECT x2 (tenant, platform), INSERT, UPDATE; no DELETE;
 *   - as the NOBYPASSRLS app role: a platform admin with NO tenant GUC reads every row;
 *     a tenant session still reads only its own row; a non-platform session with no
 *     tenant (unset or '') reads nothing (no 22P02); a flag that is not 'true' reads nothing;
 *   - writes are unchanged: the platform read opens no write (insert and update still need
 *     the target tenant's context; a tenant still cannot insert);
 *   - as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to '';
 *   - the down drops ONLY the new policy, and the up re-applies cleanly.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1
 * (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0110_tenant_access_entitlements_platform_select.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0110_tenant_access_entitlements_platform_select.down.sql");

const id = (n: string): string => `11000000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const TENANT_C = id("0c001");
const ADMIN_USER = id("0a0a1");

const T = "tenant_access_entitlements";
const POLICY = "tenant_access_entitlements_platform_select";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** Run `work` as the app role with the tenant GUC and an optional platform flag value; rolls back. */
function asSession<T2>(
  tenant: string | null,
  platformFlag: string | null,
  work: (c: PoolClient) => Promise<T2>,
): Promise<T2> {
  return asApp(guard(), tenant, async (client) => {
    if (platformFlag !== null) await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [platformFlag]);
    return await work(client);
  });
}

const tenantIds = (rows: { tenant_id: string }[]): string[] => rows.map((r) => r.tenant_id).sort();

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toMatchObject({ code });
}

/** A restricted row for each tenant, through the superuser pool (fixtures bypass RLS). */
async function seedRows(pgEnv: PgTestEnv, tenants: string[]): Promise<void> {
  for (const tenant of tenants) {
    await pgEnv.admin.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [tenant]);
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
         ($1, 'pol-a', 'Policy A', 'USD'), ($2, 'pol-b', 'Policy B', 'USD'), ($3, 'pol-c', 'Policy C', 'USD')`,
      [TENANT_A, TENANT_B, TENANT_C],
    );
    await env.admin.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pol-admin@fixture.invalid', NULL)`, [ADMIN_USER]);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0110-tenant-access-entitlements-platform-select.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER the migrations: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip() || !env) return;
  await env.admin.query(`DELETE FROM ${T}`);
});

describe("0110: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0110: policy set", () => {
  it("adds one SELECT policy; the set is SELECT x2, INSERT, UPDATE and no DELETE; RLS stays forced", async () => {
    if (skip()) return;
    const a = guard().admin;
    const pol = await a.query<{ cmd: string; policyname: string }>(`SELECT cmd, policyname FROM pg_policies WHERE tablename = $1`, [T]);
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "SELECT", "UPDATE"]);
    expect(pol.rows.some((r) => r.policyname === POLICY && r.cmd === "SELECT")).toBe(true);
    const t = await a.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [T]);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

describe("0110: who reads what as the NOBYPASSRLS app role", () => {
  beforeEach(async () => {
    if (skip()) return;
    await seedRows(guard(), [TENANT_A, TENANT_B, TENANT_C]);
  });

  it("a platform admin with NO tenant GUC reads every row", async () => {
    if (skip()) return;
    const r = await asSession(null, "true", (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${T}`));
    expect(tenantIds(r.rows)).toEqual([TENANT_A, TENANT_B, TENANT_C].sort());
  });

  it("a platform admin with an empty tenant GUC reads every row (no 22P02)", async () => {
    if (skip()) return;
    const r = await asSession("", "true", (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${T}`));
    expect(tenantIds(r.rows)).toEqual([TENANT_A, TENANT_B, TENANT_C].sort());
  });

  it("a platform admin inside one tenant's context reads every row too", async () => {
    if (skip()) return;
    const r = await asSession(TENANT_A, "true", (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${T}`));
    expect(tenantIds(r.rows)).toEqual([TENANT_A, TENANT_B, TENANT_C].sort());
  });

  it("a tenant session still reads only its own row", async () => {
    if (skip()) return;
    const r = await asSession(TENANT_A, null, (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${T}`));
    expect(r.rows).toEqual([{ tenant_id: TENANT_A }]);
    const flagged = await asSession(TENANT_B, "false", (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${T}`));
    expect(flagged.rows).toEqual([{ tenant_id: TENANT_B }]);
  });

  it("a non-platform session with no tenant (unset or empty) reads 0 rows", async () => {
    if (skip()) return;
    for (const tenant of [null, ""]) {
      const none = await asSession(tenant, null, (c) => c.query(`SELECT tenant_id FROM ${T}`));
      expect(none.rows).toEqual([]);
    }
  });

  it.each(["false", "", "TRUE", "1", "yes"])("a platform flag of %j is not a platform admin: 0 rows with no tenant", async (flag) => {
    if (skip()) return;
    const none = await asSession(null, flag, (c) => c.query(`SELECT tenant_id FROM ${T}`));
    expect(none.rows).toEqual([]);
  });
});

describe("0110: writes are unchanged", () => {
  it("a platform admin with no tenant context cannot insert (RLS 42501)", async () => {
    if (skip()) return;
    await expectCode(
      asSession(null, "true", (c) => c.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_A])),
      "42501",
    );
  });

  it("a platform admin still inserts only inside the target tenant's context", async () => {
    if (skip()) return;
    await asSession(TENANT_A, "true", (c) => c.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_A]));
    await expectCode(
      asSession(TENANT_A, "true", (c) => c.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_B])),
      "42501",
    );
  });

  it("a platform admin cannot update another tenant's row from outside its context: no row matches", async () => {
    if (skip()) return;
    await seedRows(guard(), [TENANT_B]);
    const noTenant = await asSession(null, "true", (c) =>
      c.query(`UPDATE ${T} SET unlock_requested_at = now(), unlock_requested_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_B, ADMIN_USER]),
    );
    expect(noTenant.rowCount).toBe(0);
    const otherTenant = await asSession(TENANT_A, "true", (c) =>
      c.query(`UPDATE ${T} SET unlock_requested_at = now(), unlock_requested_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_B, ADMIN_USER]),
    );
    expect(otherTenant.rowCount).toBe(0);
    const own = await asSession(TENANT_B, "true", (c) =>
      c.query(`UPDATE ${T} SET unlock_requested_at = now(), unlock_requested_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_B, ADMIN_USER]),
    );
    expect(own.rowCount).toBe(1);
  });

  it("a tenant, even with the platform flag false, still cannot insert or lift a restriction; no role deletes", async () => {
    if (skip()) return;
    await expectCode(
      asSession(TENANT_A, "false", (c) => c.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_A])),
      "42501",
    );
    await seedRows(guard(), [TENANT_A]);
    const del = await asSession(TENANT_A, "true", (c) => c.query(`DELETE FROM ${T} WHERE tenant_id = $1`, [TENANT_A]));
    expect(del.rowCount).toBe(0);
  });
});

describe("0110: down and up again", () => {
  it("reads as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to ''", async () => {
    if (skip()) return;
    const e = guard();
    await seedRows(e, [TENANT_A]);
    await asMigrationOwner(e, { role: "mig_owner_0110", tables: [T], functions: ["tenant_access_entitlements_guard()"] }, async () => {
      const client = await e.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mig_owner_0110");
        await client.query("SELECT set_config('app.current_tenant', '', true)");
        const r = await client.query(`SELECT count(*)::int AS n FROM ${T}`);
        expect(r.rows[0]).toEqual({ n: 0 });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  it("the down drops only the new policy (the platform read goes away) and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    await seedRows(guard(), [TENANT_A, TENANT_B]);
    await a.query(downSql);
    const after = await a.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1`, [T]);
    expect(after.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const blind = await asSession(null, "true", (c) => c.query(`SELECT tenant_id FROM ${T}`));
    expect(blind.rows).toEqual([]);
    // Idempotent down, then up again.
    expect(await errorCode(() => a.query(downSql))).toBeNull();
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
    const seen = await asSession(null, "true", (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${T}`));
    expect(tenantIds(seen.rows)).toEqual([TENANT_A, TENANT_B].sort());
    const count = await a.query(`SELECT count(*)::int AS n FROM ${T}`);
    expect(count.rows[0]).toEqual({ n: 2 });
  });
});
