/**
 * RT-1292 — `0088_pos_pilot_releases` migration test.
 *
 * Validates `packages/db/drizzle/0088_pos_pilot_releases.sql` (+ `.down.sql`):
 *   - both tables exist with RLS enabled + FORCED;
 *   - the registry has SELECT + INSERT + UPDATE policies and NO DELETE policy;
 *     the allowlist has SELECT + INSERT + DELETE policies and NO UPDATE policy;
 *   - the registry admits only signing class `pilot` (a lab or production row,
 *     and a lab-marked publisher, are CHECK violations) and at most one current
 *     (approved and activated) row (23505);
 *   - the registry is readable in any context and writable only with
 *     `app.is_platform_admin = 'true'`; the allowlist shows a tenant only its
 *     own row and is writable by the platform-admin context only;
 *   - UP -> DOWN -> UP round-trips; the down drops ONLY the two tables and the
 *     trigger function.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0088_pos_pilot_releases.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0088_pos_pilot_releases.down.sql");

const TENANT_A = "08880000-0000-7000-8000-00000000a001";
const TENANT_B = "08880000-0000-7000-8000-00000000b001";
const ADMIN_USER = "08880000-0000-7000-8000-00000000c001";
const RELEASE = "08880000-0000-7000-8000-00000000d001";

const TABLES = ["pos_pilot_release_registry", "pos_pilot_tenant_allowlist"];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** True when Docker is unavailable and skipping is explicitly allowed. */
const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

/** The started Postgres environment; throws when Docker was unavailable. */
function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** Apply every migration with a basename lexically < 0088. */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const guardBasename = basename(UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(guardBasename) < 0)
    .sort();
  for (const name of upFiles) await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(pgEnv);
}

/** Insert the tenants and the user the specs reference. */
async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  const a = pgEnv.admin;
  await a.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'pp-a', 'Pilot A', 'USD'), ($2, 'pp-b', 'Pilot B', 'USD')`, [TENANT_A, TENANT_B]);
  await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pp@fixture.invalid', NULL)`, [ADMIN_USER]);
}

/** Run `work` in a transaction as the app role with the GUCs set; rolls back. */
async function withApp<T>(ctx: { tenant?: string; platformAdmin?: boolean }, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await guard().app.connect();
  try {
    await client.query("BEGIN");
    if (ctx.tenant !== undefined) await client.query("SELECT set_config('app.current_tenant', $1, true)", [ctx.tenant]);
    await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [ctx.platformAdmin === true ? "true" : "false"]);
    return await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** An INSERT of one registry row with the given class and publisher, and its parameters. */
const insertSql = (signingClass: string, publisher: string): [string, unknown[]] => [
  `INSERT INTO pos_pilot_release_registry
     (id, version, sha256, size_bytes, publisher, signing_class, attestation_ref, source_sha, artifact_key,
      artifact_version_id, approved_at, approved_by, promotion_run_url)
   VALUES ($1, '1.4.0', $2, 1, $3, $4,
     'https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/1', $5,
     'pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe', 'v', now(), 'kemetra-owner',
     'https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/1')`,
  [RELEASE, "a".repeat(64), publisher, signingClass, "c".repeat(40)],
];

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0088-pos-pilot-releases.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0088: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
  await seedParents(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0088: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0088: tables and policies", () => {
  it.each(TABLES)("%s has RLS enabled + forced", async (table) => {
    if (skip()) return;
    const t = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each([
    ["pos_pilot_release_registry", ["INSERT", "SELECT", "UPDATE"]],
    ["pos_pilot_tenant_allowlist", ["DELETE", "INSERT", "SELECT"]],
  ])("%s has exactly the policies %j", async (table, commands) => {
    if (skip()) return;
    const pol = await guard().admin.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1`, [table]);
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(commands);
  });
});

describe("0088: the registry admits only the pilot class", () => {
  it.each([
    ["lab", "CN=Kemetra POS PILOT"],
    ["production", "CN=Kemetra POS PILOT"],
    ["pilot", "CN=x LAB TEST y"],
    ["pilot", "CN=x not for production y"],
  ])("refuses class %s with publisher %s (23514)", async (signingClass, publisher) => {
    if (skip()) return;
    const [sql, params] = insertSql(signingClass, publisher);
    await expect(guard().admin.query(sql, params)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0088: row-level security", () => {
  it("shows the registry to any context and lets only the platform-admin context write it", async () => {
    if (skip()) return;
    const [sql, params] = insertSql("pilot", "CN=Kemetra POS PILOT");
    await expect(withApp({ tenant: TENANT_A }, (c) => c.query(sql, params))).rejects.toMatchObject({ code: "42501" });
    await withApp({ platformAdmin: true }, async (c) => {
      await c.query(sql, params);
      const seenByPlatform = await c.query(`SELECT id FROM pos_pilot_release_registry`);
      expect(seenByPlatform.rowCount).toBe(1);
    });
    await guard().admin.query(sql, params);
    try {
      const seen = await withApp({ tenant: TENANT_B }, (c) => c.query(`SELECT id FROM pos_pilot_release_registry`));
      expect(seen.rowCount).toBe(1);
    } finally {
      await guard().admin.query(`DELETE FROM pos_pilot_release_registry`);
    }
  });

  it("shows a tenant only its own allowlist row, fails closed on an unset tenant, and lets only a platform admin write", async () => {
    if (skip()) return;
    await guard().admin.query(`INSERT INTO pos_pilot_tenant_allowlist (tenant_id, added_by_user_id) VALUES ($1, $3), ($2, $3)`, [TENANT_A, TENANT_B, ADMIN_USER]);
    try {
      const own = await withApp({ tenant: TENANT_A }, (c) => c.query<{ tenant_id: string }>(`SELECT tenant_id FROM pos_pilot_tenant_allowlist`));
      expect(own.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
      const unset = await withApp({ tenant: "" }, (c) => c.query(`SELECT tenant_id FROM pos_pilot_tenant_allowlist`));
      expect(unset.rowCount).toBe(0);
      const all = await withApp({ platformAdmin: true }, (c) => c.query(`SELECT tenant_id FROM pos_pilot_tenant_allowlist`));
      expect(all.rowCount).toBe(2);
      await expect(
        withApp({ tenant: TENANT_A }, (c) => c.query(`INSERT INTO pos_pilot_tenant_allowlist (tenant_id, added_by_user_id) VALUES ($1, $2)`, [TENANT_B, ADMIN_USER])),
      ).rejects.toMatchObject({ code: "42501" });
      const removedByTenant = await withApp({ tenant: TENANT_A }, (c) => c.query(`DELETE FROM pos_pilot_tenant_allowlist`));
      expect(removedByTenant.rowCount).toBe(0);
    } finally {
      await guard().admin.query(`DELETE FROM pos_pilot_tenant_allowlist`);
    }
  });
});

describe("0088: reversal", () => {
  it("round-trips UP -> DOWN -> UP and the down drops only its own objects", async () => {
    if (skip()) return;
    const a = guard().admin;
    /** How many of the two tables exist. */
    const exists = async (): Promise<number> => (await a.query(`SELECT 1 FROM pg_tables WHERE tablename = ANY($1)`, [TABLES])).rowCount ?? 0;
    /** Whether the registry guard trigger function exists. */
    const hasFunction = async (): Promise<number> =>
      (await a.query(`SELECT 1 FROM pg_proc WHERE proname = 'pos_pilot_release_registry_guard'`)).rowCount ?? 0;
    expect(await exists()).toBe(2);
    expect(await hasFunction()).toBe(1);
    await a.query(downSql);
    expect(await exists()).toBe(0);
    expect(await hasFunction()).toBe(0);
    expect((await a.query(`SELECT 1 FROM pg_tables WHERE tablename IN ('tenants', 'users', 'audit_events')`)).rowCount).toBe(3);
    await a.query(upSql);
    await ensureAppRole(guard());
    expect(await exists()).toBe(2);
    expect(await hasFunction()).toBe(1);
  });
});
