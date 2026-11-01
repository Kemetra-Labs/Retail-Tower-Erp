/**
 * RT-473 S2 — `0076_tenant_logo_branding` migration test.
 *
 * Validates `packages/db/drizzle/0076_tenant_logo_branding.sql` (+ `.down.sql`):
 *   - the three tables exist with RLS enabled + FORCED; revisions have SELECT +
 *     INSERT + UPDATE policies and NO DELETE policy; logos and renditions also
 *     have DELETE;
 *   - CHECKs: version shape, known warnings, rendition kind / scale / dpi,
 *     revision >= 1 (23514); one logo per tenant (23505);
 *   - the revision trigger: only +1 on the same tenant;
 *   - fail-closed tenant RLS: another tenant sees and changes nothing, an unset
 *     GUC sees nothing (no 22P02), a tenant cannot insert another tenant's row;
 *   - deleting a logo cascades to its renditions, and leaves the revision;
 *   - UP -> DOWN -> UP round-trips; the down drops ONLY the three tables.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0076_tenant_logo_branding.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0076_tenant_logo_branding.down.sql");

const TENANT_A = "04730000-0000-7000-8000-00000000a001";
const TENANT_B = "04730000-0000-7000-8000-00000000b001";
const VERSION = "a".repeat(64);
const TABLES = ["tenant_branding_revisions", "tenant_logos", "tenant_logo_renditions"];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** Apply every migration with a basename lexically < 0076. */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const guardBasename = basename(UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(guardBasename) < 0)
    .sort();
  for (const name of upFiles) await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(pgEnv);
}

async function seedTenants(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'logo-a', 'Logo A', 'USD'), ($2, 'logo-b', 'Logo B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
}

function insertLogo(pgEnv: PgTestEnv, tenant: string, over: { version?: string; warnings?: string[] } = {}): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO tenant_logos (tenant_id, version, pipeline_version, master_png, master_width, master_height, presentation_card, warnings)
     VALUES ($1, $2, 'rt473-s2.1', '\\x89504e47'::bytea, 10, 10, false, $3::text[])`,
    [tenant, over.version ?? VERSION, over.warnings ?? []],
  );
}

function insertRendition(pgEnv: PgTestEnv, tenant: string, kind: string, scale: number, dpi: number | null): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO tenant_logo_renditions (tenant_id, kind, scale, width_px, height_px, dpi, png)
     VALUES ($1, $2, $3, 10, 10, $4, '\\x89504e47'::bytea)`,
    [tenant, kind, scale, dpi],
  );
}

/** Run `work` as the app role with the tenant GUC set (or unset); rolls back. */
async function asTenant<T>(tenant: string | null, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await guard().app.connect();
  try {
    await client.query("BEGIN");
    if (tenant !== null) await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
    return await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0076-tenant-logo-branding.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0076: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
  await seedTenants(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip() || !env) return;
  await env.admin.query(`DELETE FROM tenant_logos`);
  await env.admin.query(`DELETE FROM tenant_branding_revisions`);
});

describe("0076: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0076: tables and policies", () => {
  it.each(TABLES)("%s has RLS enabled + forced", async (table) => {
    if (skip()) return;
    const t = await guard().admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each([
    ["tenant_branding_revisions", ["INSERT", "SELECT", "UPDATE"]],
    ["tenant_logos", ["DELETE", "INSERT", "SELECT", "UPDATE"]],
    ["tenant_logo_renditions", ["DELETE", "INSERT", "SELECT", "UPDATE"]],
  ])("%s has exactly the %j policies", async (table, cmds) => {
    if (skip()) return;
    const pol = await guard().admin.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1`, [table]);
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(cmds);
  });
});

describe("0076: constraints", () => {
  it("one logo per tenant (23505), a version shape and known warnings (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await insertLogo(e, TENANT_A);
    await expectCode(insertLogo(e, TENANT_A), "23505");
    await expectCode(insertLogo(e, TENANT_B, { version: "ABC" }), "23514");
    await expectCode(insertLogo(e, TENANT_B, { warnings: ["something_else"] }), "23514");
    await insertLogo(e, TENANT_B, { warnings: ["low_contrast", "receipt_thin_strokes"] });
  });

  it("rendition kind, scale and dpi (receipt only, scale 1, 100..600)", async () => {
    if (skip()) return;
    const e = guard();
    await insertLogo(e, TENANT_A);
    await insertRendition(e, TENANT_A, "boot", 2, null);
    await insertRendition(e, TENANT_A, "receipt", 1, 203);
    await expectCode(insertRendition(e, TENANT_A, "splash", 1, null), "23514");
    await expectCode(insertRendition(e, TENANT_A, "lock", 3, null), "23514");
    await expectCode(insertRendition(e, TENANT_A, "lock", 1, 203), "23514");
    await expectCode(insertRendition(e, TENANT_A, "pairing", 1, null).then(() => insertRendition(e, TENANT_A, "pairing", 1, null)), "23505");
    await e.admin.query(`DELETE FROM tenant_logo_renditions WHERE kind = 'receipt'`);
    await expectCode(insertRendition(e, TENANT_A, "receipt", 2, 203), "23514");
    await expectCode(insertRendition(e, TENANT_A, "receipt", 1, 50), "23514");
    await expectCode(insertRendition(e, TENANT_B, "boot", 1, null), "23503");
  });

  it("the revision starts at >= 1 and only ever moves up by one", async () => {
    if (skip()) return;
    const a = guard().admin;
    await expectCode(a.query(`INSERT INTO tenant_branding_revisions (tenant_id, revision) VALUES ($1, 0)`, [TENANT_A]), "23514");
    await a.query(`INSERT INTO tenant_branding_revisions (tenant_id, revision) VALUES ($1, 1)`, [TENANT_A]);
    await a.query(`UPDATE tenant_branding_revisions SET revision = 2 WHERE tenant_id = $1`, [TENANT_A]);
    await expectCode(a.query(`UPDATE tenant_branding_revisions SET revision = 4 WHERE tenant_id = $1`, [TENANT_A]), "23514");
    await expectCode(a.query(`UPDATE tenant_branding_revisions SET revision = 1 WHERE tenant_id = $1`, [TENANT_A]), "23514");
    await expectCode(a.query(`UPDATE tenant_branding_revisions SET revision = revision WHERE tenant_id = $1`, [TENANT_A]), "23514");
  });

  it("deleting a logo cascades to its renditions and keeps the revision", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`INSERT INTO tenant_branding_revisions (tenant_id, revision) VALUES ($1, 1)`, [TENANT_A]);
    await insertLogo(e, TENANT_A);
    await insertRendition(e, TENANT_A, "boot", 1, null);
    await insertRendition(e, TENANT_A, "receipt", 1, 203);
    // As the NOBYPASSRLS app role in the tenant context, committed.
    const client = await e.app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_A]);
      await client.query(`DELETE FROM tenant_logos WHERE tenant_id = $1`, [TENANT_A]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const n = await e.admin.query(`SELECT count(*)::int AS n FROM tenant_logo_renditions`);
    expect(n.rows[0]).toEqual({ n: 0 });
    const r = await e.admin.query(`SELECT revision::int AS revision FROM tenant_branding_revisions WHERE tenant_id = $1`, [TENANT_A]);
    expect(r.rows[0]).toEqual({ revision: 1 });
  });
});

describe("0076: tenant RLS (fail closed)", () => {
  beforeEach(async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`INSERT INTO tenant_branding_revisions (tenant_id, revision) VALUES ($1, 1), ($2, 1)`, [TENANT_A, TENANT_B]);
    await insertLogo(e, TENANT_A);
    await insertRendition(e, TENANT_A, "boot", 1, null);
  });

  it.each(TABLES)("%s: tenant B sees none of tenant A's rows; an unset GUC sees nothing", async (table) => {
    if (skip()) return;
    const countA = `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${TENANT_A}'`;
    expect((await asTenant(TENANT_B, (c) => c.query(countA))).rows[0]).toEqual({ n: 0 });
    expect((await asTenant(null, (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`))).rows[0]).toEqual({ n: 0 });
    expect((await asTenant(TENANT_A, (c) => c.query(countA))).rows[0]).toEqual({ n: 1 });
  });

  it("tenant B cannot update or delete tenant A's rows", async () => {
    if (skip()) return;
    await asTenant(TENANT_B, async (c) => {
      expect((await c.query(`UPDATE tenant_logos SET presentation_card = true WHERE tenant_id = $1`, [TENANT_A])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM tenant_logos WHERE tenant_id = $1`, [TENANT_A])).rowCount).toBe(0);
      expect((await c.query(`UPDATE tenant_branding_revisions SET revision = 2 WHERE tenant_id = $1`, [TENANT_A])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM tenant_logo_renditions WHERE tenant_id = $1`, [TENANT_A])).rowCount).toBe(0);
    });
  });

  it("a tenant cannot insert a row for another tenant (42501)", async () => {
    if (skip()) return;
    await expectCode(
      asTenant(TENANT_B, (c) =>
        c.query(
          `INSERT INTO tenant_logos (tenant_id, version, pipeline_version, master_png, master_width, master_height, presentation_card)
           VALUES ($1, $2, 'rt473-s2.1', '\\x00'::bytea, 1, 1, false)`,
          [TENANT_A, VERSION],
        ),
      ),
      "42501",
    );
  });

  it("the revisions table has no DELETE policy: the app role deletes nothing", async () => {
    if (skip()) return;
    const n = await asTenant(TENANT_A, (c) => c.query(`DELETE FROM tenant_branding_revisions WHERE tenant_id = $1`, [TENANT_A]));
    expect(n.rowCount).toBe(0);
  });
});

describe("0076: down and up again", () => {
  it("the down drops only the three tables and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    const before = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    await a.query(downSql);
    const after = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    expect(before.rows[0]!.n - after.rows[0]!.n).toBe(3);
    const fn = await a.query(`SELECT 1 FROM pg_proc WHERE proname = 'tenant_branding_revisions_monotonic'`);
    expect(fn.rowCount).toBe(0);
    await a.query(upSql);
    await ensureAppRole(guard());
    const t = await a.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1::text[])`, [TABLES]);
    expect(t.rows[0]).toEqual({ n: 3 });
  });
});
