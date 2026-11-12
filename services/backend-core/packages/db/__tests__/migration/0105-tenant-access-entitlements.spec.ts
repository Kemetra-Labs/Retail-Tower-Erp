/**
 * RT-1353: `0105_tenant_access_entitlements` migration test (authority: the
 * owner's "PR and merge authorized after Opus review", 2026-11-12; RT-1001
 * comment 16753).
 *
 * Validates `packages/db/drizzle/0105_tenant_access_entitlements.sql` (+ `.down.sql`)
 * on a real PostgreSQL (Testcontainers), applied on top of every earlier
 * migration with tenants already present (the UPGRADE path):
 *   - existing tenants read `unrestricted` (no row = unrestricted; no backfill):
 *     the table is empty after the migration and the shared reader says so;
 *   - FORCE RLS and the exact policy set (SELECT, INSERT, UPDATE; no DELETE);
 *   - the CHECKs: state set, unlock request pair, the shape of each state;
 *   - the forward-only trigger: tenant fixed, no way back to `restricted`, an
 *     unlock request never cleared, `updated_at` moves;
 *   - RLS as the NOBYPASSRLS app role: own tenant only, an empty GUC sees
 *     nothing (no 22P02), a tenant can never insert or lift its own
 *     restriction, a platform admin only inside the target tenant's context;
 *   - as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to ''
 *     (the empty-GUC cast case);
 *   - UP -> DOWN -> UP, the down dropping ONLY this table and its function.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { readTenantAccessState } from "../../src/helpers/tenant-access";
import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0105_tenant_access_entitlements.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0105_tenant_access_entitlements.down.sql");

const id = (n: string): string => `10400000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const TENANT_C = id("0c001");
const ADMIN_USER = id("0a0a1");
const OTHER_USER = id("0a0a2");

const T = "tenant_access_entitlements";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

async function seedBefore(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'acc-a', 'Access A', 'USD'), ($2, 'acc-b', 'Access B', 'USD'), ($3, 'acc-c', 'Access C', 'USD')`,
    [TENANT_A, TENANT_B, TENANT_C],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'acc-admin@fixture.invalid', NULL), ($2, 'acc-other@fixture.invalid', NULL)`,
    [ADMIN_USER, OTHER_USER],
  );
}

/** A `restricted` row for `tenant`, with an unlock request when `unlocked`. */
function insertRestricted(pgEnv: PgTestEnv, tenant: string, unlocked = false): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO ${T} (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id)
     VALUES ($1, 'restricted', $2, $3)`,
    [tenant, unlocked ? new Date("2026-11-12T10:00:00Z") : null, unlocked ? ADMIN_USER : null],
  );
}

/** Run `work` as the app role with the tenant GUC (and optionally platform admin); rolls back. */
function asTenant<T2>(tenant: string | null, platformAdmin: boolean, work: (c: PoolClient) => Promise<T2>): Promise<T2> {
  return asApp(guard(), tenant, async (client) => {
    if (platformAdmin) await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    return await work(client);
  });
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
    await seedBefore(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0105-tenant-access-entitlements.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0105: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip() || !env) return;
  await env.admin.query(`DELETE FROM ${T}`);
});

describe("0105: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0105: existing tenants read unrestricted", () => {
  it("creates no row for any tenant that existed before the migration", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${T}`);
    expect(r.rows[0]!.n).toBe("0");
  });

  it.each([TENANT_A, TENANT_B, TENANT_C])("the shared reader says unrestricted for existing tenant %s", async (tenant) => {
    if (skip()) return;
    expect(await asTenant(tenant, false, (c) => readTenantAccessState(c, tenant))).toBe("unrestricted");
  });

  it("a restricted row restricts only its own tenant", async () => {
    if (skip()) return;
    await insertRestricted(guard(), TENANT_A);
    expect(await asTenant(TENANT_A, false, (c) => readTenantAccessState(c, TENANT_A))).toBe("restricted");
    expect(await asTenant(TENANT_B, false, (c) => readTenantAccessState(c, TENANT_B))).toBe("unrestricted");
  });
});

describe("0105: table and policies", () => {
  it("has RLS enabled + forced and exactly SELECT, INSERT and UPDATE policies", async () => {
    if (skip()) return;
    const a = guard().admin;
    const t = await a.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [T]);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await a.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1`, [T]);
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

describe("0105: constraints", () => {
  it("accepts only restricted / unrestricted (23514)", async () => {
    if (skip()) return;
    await expectCode(
      guard().admin.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'suspended')`, [TENANT_A]),
      "23514",
    );
  });

  it("one row per tenant (23505) and the tenant must exist (23503)", async () => {
    if (skip()) return;
    await insertRestricted(guard(), TENANT_A);
    await expectCode(insertRestricted(guard(), TENANT_A), "23505");
    await expectCode(insertRestricted(guard(), id("0d999")), "23503");
  });

  it("an unlock request names who and when together, or neither (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await expectCode(
      a.query(`INSERT INTO ${T} (tenant_id, state, unlock_requested_at) VALUES ($1, 'restricted', now())`, [TENANT_A]),
      "23514",
    );
    await expectCode(
      a.query(`INSERT INTO ${T} (tenant_id, state, unlock_requested_by_user_id) VALUES ($1, 'restricted', $2)`, [TENANT_A, ADMIN_USER]),
      "23514",
    );
  });

  it("restricted carries no provisioning result (23514)", async () => {
    if (skip()) return;
    await expectCode(
      guard().admin.query(
        `INSERT INTO ${T} (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id, provisioned_at, provisioned_by_user_id, provisioning_source)
         VALUES ($1, 'restricted', now(), $2, now(), $2, 'manual_platform')`,
        [TENANT_A, ADMIN_USER],
      ),
      "23514",
    );
  });

  it("unrestricted needs a prior unlock request and the whole provisioning result (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    // No unlock request.
    await expectCode(
      a.query(
        `INSERT INTO ${T} (tenant_id, state, provisioned_at, provisioned_by_user_id, provisioning_source)
         VALUES ($1, 'unrestricted', now(), $2, 'manual_platform')`,
        [TENANT_A, ADMIN_USER],
      ),
      "23514",
    );
    // No provisioner for a manual provisioning.
    await expectCode(
      a.query(
        `INSERT INTO ${T} (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id, provisioned_at, provisioning_source)
         VALUES ($1, 'unrestricted', now(), $2, now(), 'manual_platform')`,
        [TENANT_A, ADMIN_USER],
      ),
      "23514",
    );
    // An unknown source.
    await expectCode(
      a.query(
        `INSERT INTO ${T} (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id, provisioned_at, provisioned_by_user_id, provisioning_source)
         VALUES ($1, 'unrestricted', now(), $2, now(), $2, 'self')`,
        [TENANT_A, ADMIN_USER],
      ),
      "23514",
    );
    await a.query(
      `INSERT INTO ${T} (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id, provisioned_at, provisioned_by_user_id, provisioning_source)
       VALUES ($1, 'unrestricted', now(), $2, now(), $2, 'manual_platform')`,
      [TENANT_A, ADMIN_USER],
    );
  });
});

describe("0105: the forward-only trigger", () => {
  const PROVISION = `UPDATE ${T} SET state = 'unrestricted', provisioned_at = now(), provisioned_by_user_id = $2, provisioning_source = 'manual_platform' WHERE tenant_id = $1`;

  it("an unlock request can be added once, then never cleared or rewritten (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await insertRestricted(guard(), TENANT_A);
    await a.query(`UPDATE ${T} SET unlock_requested_at = now(), unlock_requested_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_A, ADMIN_USER]);
    await expectCode(
      a.query(`UPDATE ${T} SET unlock_requested_at = NULL, unlock_requested_by_user_id = NULL WHERE tenant_id = $1`, [TENANT_A]),
      "23514",
    );
    await expectCode(a.query(`UPDATE ${T} SET unlock_requested_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_A, OTHER_USER]), "23514");
    await expectCode(a.query(`UPDATE ${T} SET unlock_requested_at = now() + interval '1 hour' WHERE tenant_id = $1`, [TENANT_A]), "23514");
  });

  it("restricted -> unrestricted needs the unlock request, and never goes back (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await insertRestricted(guard(), TENANT_A);
    await expectCode(a.query(PROVISION, [TENANT_A, ADMIN_USER]), "23514");
    await a.query(`UPDATE ${T} SET unlock_requested_at = now(), unlock_requested_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_A, ADMIN_USER]);
    await a.query(PROVISION, [TENANT_A, ADMIN_USER]);
    await expectCode(
      a.query(
        `UPDATE ${T} SET state = 'restricted', provisioned_at = NULL, provisioned_by_user_id = NULL, provisioning_source = NULL WHERE tenant_id = $1`,
        [TENANT_A],
      ),
      "23514",
    );
  });

  it("a single UPDATE cannot set the unlock request and the provisioning result together (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await insertRestricted(guard(), TENANT_A);
    await expectCode(
      a.query(
        `UPDATE ${T} SET state = 'unrestricted', unlock_requested_at = now(), unlock_requested_by_user_id = $2,
                provisioned_at = now(), provisioned_by_user_id = $2, provisioning_source = 'manual_platform'
          WHERE tenant_id = $1`,
        [TENANT_A, ADMIN_USER],
      ),
      "23514",
    );
  });

  it("the provisioning result is never rewritten once unrestricted (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await insertRestricted(guard(), TENANT_A, true);
    await a.query(PROVISION, [TENANT_A, ADMIN_USER]);
    await expectCode(a.query(`UPDATE ${T} SET provisioned_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_A, OTHER_USER]), "23514");
    await expectCode(a.query(`UPDATE ${T} SET provisioned_at = now() + interval '1 hour' WHERE tenant_id = $1`, [TENANT_A]), "23514");
    await expectCode(a.query(`UPDATE ${T} SET provisioning_source = NULL WHERE tenant_id = $1`, [TENANT_A]), "23514");
  });

  it("the tenant never changes (23514) and updated_at moves on every change", async () => {
    if (skip()) return;
    const a = guard().admin;
    await insertRestricted(guard(), TENANT_A);
    await expectCode(a.query(`UPDATE ${T} SET tenant_id = $2 WHERE tenant_id = $1`, [TENANT_A, TENANT_B]), "23514");
    const before = (await a.query<{ updated_at: Date }>(`SELECT updated_at FROM ${T} WHERE tenant_id = $1`, [TENANT_A])).rows[0]!.updated_at;
    await new Promise((done) => setTimeout(done, 15));
    await a.query(`UPDATE ${T} SET unlock_requested_at = now(), unlock_requested_by_user_id = $2 WHERE tenant_id = $1`, [TENANT_A, ADMIN_USER]);
    const after = (await a.query<{ updated_at: Date }>(`SELECT updated_at FROM ${T} WHERE tenant_id = $1`, [TENANT_A])).rows[0]!.updated_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("0105: tenant isolation under FORCE RLS as the app role", () => {
  it("a tenant reads only its own row, and an empty GUC reads nothing (no 22P02)", async () => {
    if (skip()) return;
    await insertRestricted(guard(), TENANT_A);
    await insertRestricted(guard(), TENANT_B);
    const own = await asTenant(TENANT_A, false, (c) => c.query(`SELECT tenant_id FROM ${T}`));
    expect(own.rows).toEqual([{ tenant_id: TENANT_A }]);
    const unset = await asTenant(null, false, (c) => c.query(`SELECT tenant_id FROM ${T}`));
    expect(unset.rows).toEqual([]);
    const empty = await asTenant("", false, (c) => c.query(`SELECT tenant_id FROM ${T}`));
    expect(empty.rows).toEqual([]);
  });

  // The INSERT rule is an RLS WITH CHECK: FORCE RLS binds the table owner too, but a superuser or a
  // BYPASSRLS role bypasses it, as with every RLS rule in this schema (the fixtures above insert
  // through the superuser `admin` pool for that reason).
  it("a platform admin can create only a plain restricted row, never an unrestricted or pre-unlocked one (RLS 42501)", async () => {
    if (skip()) return;
    const unrestricted = `INSERT INTO ${T} (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id, provisioned_at, provisioned_by_user_id, provisioning_source)
       VALUES ($1, 'unrestricted', now(), $2, now(), $2, 'manual_platform')`;
    await expectCode(asTenant(TENANT_A, true, (c) => c.query(unrestricted, [TENANT_A, ADMIN_USER])), "42501");
    await expectCode(
      asTenant(TENANT_A, true, (c) =>
        c.query(`INSERT INTO ${T} (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id) VALUES ($1, 'restricted', now(), $2)`, [TENANT_A, ADMIN_USER]),
      ),
      "42501",
    );
  });

  it("a tenant, even its owner, can never insert a row (RLS 42501)", async () => {
    if (skip()) return;
    await expectCode(
      asTenant(TENANT_A, false, (c) => c.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_A])),
      "42501",
    );
  });

  it("a tenant can never lift its own restriction: the update matches no row", async () => {
    if (skip()) return;
    await insertRestricted(guard(), TENANT_A, true);
    const r = await asTenant(TENANT_A, false, (c) =>
      c.query(
        `UPDATE ${T} SET state = 'unrestricted', provisioned_at = now(), provisioned_by_user_id = $2, provisioning_source = 'manual_platform' WHERE tenant_id = $1`,
        [TENANT_A, ADMIN_USER],
      ),
    );
    expect(r.rowCount).toBe(0);
    const stored = await guard().admin.query<{ state: string }>(`SELECT state FROM ${T} WHERE tenant_id = $1`, [TENANT_A]);
    expect(stored.rows[0]!.state).toBe("restricted");
  });

  it("a platform admin writes only inside the target tenant's context", async () => {
    if (skip()) return;
    await asTenant(TENANT_A, true, (c) => c.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_A]));
    // Rolled back by the helper: insert again for real, then prove the cross-tenant refusals.
    await expectCode(
      asTenant(TENANT_A, true, (c) => c.query(`INSERT INTO ${T} (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_B])),
      "42501",
    );
    await insertRestricted(guard(), TENANT_B, true);
    const crossTenant = await asTenant(TENANT_A, true, (c) =>
      c.query(`UPDATE ${T} SET unlock_requested_at = unlock_requested_at WHERE tenant_id = $1`, [TENANT_B]),
    );
    expect(crossTenant.rowCount).toBe(0);
    const own = await asTenant(TENANT_B, true, (c) =>
      c.query(
        `UPDATE ${T} SET state = 'unrestricted', provisioned_at = now(), provisioned_by_user_id = $2, provisioning_source = 'manual_platform' WHERE tenant_id = $1`,
        [TENANT_B, ADMIN_USER],
      ),
    );
    expect(own.rowCount).toBe(1);
  });

  it("no role can delete a row (no DELETE policy)", async () => {
    if (skip()) return;
    await insertRestricted(guard(), TENANT_A);
    const r = await asTenant(TENANT_A, true, (c) => c.query(`DELETE FROM ${T} WHERE tenant_id = $1`, [TENANT_A]));
    expect(r.rowCount).toBe(0);
  });
});

describe("0105: down and up again", () => {
  it("reads unrestricted as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to ''", async () => {
    if (skip()) return;
    const e = guard();
    await asMigrationOwner(e, { role: "mig_owner_0105", tables: [T], functions: ["tenant_access_entitlements_guard()"] }, async () => {
      const client = await e.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mig_owner_0105");
        await client.query("SELECT set_config('app.current_tenant', '', true)");
        const r = await client.query(`SELECT count(*)::int AS n FROM ${T}`);
        expect(r.rows[0]).toEqual({ n: 0 });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  it("the down drops only this table and its function, and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    const tablesBefore = (await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n;
    await a.query(downSql);
    const gone = await a.query(`SELECT to_regclass($1) AS t, to_regproc('tenant_access_entitlements_guard') AS f`, [T]);
    expect(gone.rows[0]).toEqual({ t: null, f: null });
    const tablesAfter = (await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n;
    expect(Number(tablesAfter)).toBe(Number(tablesBefore) - 1);
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
    const back = await a.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname = $1`, [T]);
    expect(back.rows[0]).toEqual({ relforcerowsecurity: true });
  });
});
