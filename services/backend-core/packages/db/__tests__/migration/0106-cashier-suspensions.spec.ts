/**
 * RT-1138: `0106_cashier_suspensions` migration test (RT-1138; contract shape
 * confirmed by the owner in chat, 2026-11-12).
 *
 * Validates `packages/db/drizzle/0106_cashier_suspensions.sql` (+ `.down.sql`) on
 * a real PostgreSQL (Testcontainers), applied on top of every earlier migration
 * with tenants, stores and users already present (the UPGRADE path):
 *   - existing cashiers are not suspended (no row = not suspended; no backfill):
 *     the table is empty after the migration;
 *   - FORCE RLS and the exact policy set (SELECT, INSERT, UPDATE; no DELETE);
 *   - the CHECK on `status`, the primary key (one row per tenant, store, user) and
 *     the same-tenant store foreign key (a row can never point at another
 *     tenant's store);
 *   - RLS as the NOBYPASSRLS app role: own tenant only for read, insert and
 *     update; an empty GUC sees nothing (no 22P02); no DELETE;
 *   - as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to '' (the
 *     empty-GUC cast case);
 *   - the down refuses while a cashier is suspended (it would fail open), drops
 *     only this table otherwise, and the up re-applies cleanly.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0106_cashier_suspensions.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0106_cashier_suspensions.down.sql");

const id = (n: string): string => `11380000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a101");
const STORE_B = id("0b101");
const CASHIER_A = id("0a0c1");
const CASHIER_B = id("0b0c1");
const ADMIN_A = id("0a0a1");
const ADMIN_B = id("0b0a1");

const T = "cashier_suspensions";

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
       ($1, 'susp-a', 'Suspension A', 'USD'), ($2, 'susp-b', 'Suspension B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'a1', 'A1'), ($2, $4, 'b1', 'B1')`,
    [STORE_A, STORE_B, TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, 'susp-cashier-a@fixture.invalid', NULL), ($2, 'susp-cashier-b@fixture.invalid', NULL),
       ($3, 'susp-admin-a@fixture.invalid', NULL),   ($4, 'susp-admin-b@fixture.invalid', NULL)`,
    [CASHIER_A, CASHIER_B, ADMIN_A, ADMIN_B],
  );
}

/** A row for (tenant, store, user) with `status`, written as the superuser (fixtures). */
function insertRow(pgEnv: PgTestEnv, tenant: string, store: string, user: string, status = "suspended"): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO ${T} (tenant_id, store_id, user_id, status, changed_by_user_id) VALUES ($1, $2, $3, $4, $5)`,
    [tenant, store, user, status, tenant === TENANT_A ? ADMIN_A : ADMIN_B],
  );
}

/** Run `work` as the app role with the tenant GUC; rolls back. */
function asTenant<T2>(tenant: string | null, work: (c: PoolClient) => Promise<T2>): Promise<T2> {
  return asApp(guard(), tenant, work);
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
      console.warn(`\n[0106-cashier-suspensions.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0106: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip() || !env) return;
  await env.admin.query(`DELETE FROM ${T}`);
});

describe("0106: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0106: existing cashiers are not suspended", () => {
  it("creates no row for anything that existed before the migration (no backfill)", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${T}`);
    expect(r.rows[0]!.n).toBe("0");
  });
});

describe("0106: table and policies", () => {
  it("has RLS enabled + forced and exactly SELECT, INSERT and UPDATE policies", async () => {
    if (skip()) return;
    const a = guard().admin;
    const t = await a.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [T]);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await a.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1`, [T]);
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

describe("0106: constraints", () => {
  it("accepts only suspended / active (23514)", async () => {
    if (skip()) return;
    await expectCode(insertRow(guard(), TENANT_A, STORE_A, CASHIER_A, "banned"), "23514");
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A, "active");
  });

  it("one row per tenant, store and user (23505)", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A);
    await expectCode(insertRow(guard(), TENANT_A, STORE_A, CASHIER_A), "23505");
  });

  it("the store must belong to the row's own tenant (23503)", async () => {
    if (skip()) return;
    await expectCode(insertRow(guard(), TENANT_A, STORE_B, CASHIER_A), "23503");
  });

  it("the tenant, the user and the actor must exist (23503)", async () => {
    if (skip()) return;
    await expectCode(insertRow(guard(), id("0d999"), STORE_A, CASHIER_A), "23503");
    await expectCode(insertRow(guard(), TENANT_A, STORE_A, id("0d998")), "23503");
    await expectCode(
      guard().admin.query(
        `INSERT INTO ${T} (tenant_id, store_id, user_id, status, changed_by_user_id) VALUES ($1, $2, $3, 'suspended', $4)`,
        [TENANT_A, STORE_A, CASHIER_A, id("0d997")],
      ),
      "23503",
    );
  });

  it("the actor is required (23502)", async () => {
    if (skip()) return;
    await expectCode(
      guard().admin.query(`INSERT INTO ${T} (tenant_id, store_id, user_id, status) VALUES ($1, $2, $3, 'suspended')`, [
        TENANT_A,
        STORE_A,
        CASHIER_A,
      ]),
      "23502",
    );
  });
});

describe("0106: tenant isolation under FORCE RLS as the app role", () => {
  const INSERT_A = `INSERT INTO ${T} (tenant_id, store_id, user_id, status, changed_by_user_id) VALUES ($1, $2, $3, 'suspended', $4)`;

  it("a tenant reads only its own rows, and an unset or empty GUC reads nothing (no 22P02)", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A);
    await insertRow(guard(), TENANT_B, STORE_B, CASHIER_B);
    const own = await asTenant(TENANT_A, (c) => c.query(`SELECT tenant_id, user_id FROM ${T}`));
    expect(own.rows).toEqual([{ tenant_id: TENANT_A, user_id: CASHIER_A }]);
    expect((await asTenant(null, (c) => c.query(`SELECT 1 FROM ${T}`))).rows).toEqual([]);
    expect((await asTenant("", (c) => c.query(`SELECT 1 FROM ${T}`))).rows).toEqual([]);
  });

  it("a tenant can suspend its own cashier but never write a row for another tenant (RLS 42501)", async () => {
    if (skip()) return;
    const own = await asTenant(TENANT_A, (c) => c.query(INSERT_A, [TENANT_A, STORE_A, CASHIER_A, ADMIN_A]));
    expect(own.rowCount).toBe(1);
    // Tenant A's context writing a row stamped with tenant B (and B's own store, so only RLS can refuse it).
    await expectCode(asTenant(TENANT_A, (c) => c.query(INSERT_A, [TENANT_B, STORE_B, CASHIER_B, ADMIN_B])), "42501");
    // An empty GUC writes nothing.
    await expectCode(asTenant("", (c) => c.query(INSERT_A, [TENANT_A, STORE_A, CASHIER_A, ADMIN_A])), "42501");
  });

  it("a tenant can never reactivate or change another tenant's cashier: the update matches no row", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_B, STORE_B, CASHIER_B);
    const r = await asTenant(TENANT_A, (c) =>
      c.query(`UPDATE ${T} SET status = 'active' WHERE tenant_id = $1 AND user_id = $2`, [TENANT_B, CASHIER_B]),
    );
    expect(r.rowCount).toBe(0);
    const stored = await guard().admin.query<{ status: string }>(`SELECT status FROM ${T} WHERE tenant_id = $1`, [TENANT_B]);
    expect(stored.rows[0]!.status).toBe("suspended");
  });

  it("a tenant cannot move its own row to another tenant (RLS WITH CHECK)", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A);
    await expectCode(
      asTenant(TENANT_A, (c) =>
        c.query(`UPDATE ${T} SET tenant_id = $2, store_id = $3 WHERE tenant_id = $1`, [TENANT_A, TENANT_B, STORE_B]),
      ),
      "42501",
    );
  });

  it("a tenant reactivates its own cashier and the row is kept", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A);
    const r = await asTenant(TENANT_A, (c) =>
      c.query(`UPDATE ${T} SET status = 'active', changed_at = now() WHERE tenant_id = $1 AND user_id = $2`, [TENANT_A, CASHIER_A]),
    );
    expect(r.rowCount).toBe(1);
  });

  it("no role can delete a row (no DELETE policy)", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A);
    const r = await asTenant(TENANT_A, (c) => c.query(`DELETE FROM ${T} WHERE tenant_id = $1`, [TENANT_A]));
    expect(r.rowCount).toBe(0);
  });
});

describe("0106: down and up again", () => {
  it("reads as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to ''", async () => {
    if (skip()) return;
    const e = guard();
    await asMigrationOwner(e, { role: "mig_owner_0106", tables: [T], functions: [] }, async () => {
      const client = await e.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mig_owner_0106");
        await client.query("SELECT set_config('app.current_tenant', '', true)");
        const r = await client.query(`SELECT count(*)::int AS n FROM ${T}`);
        expect(r.rows[0]).toEqual({ n: 0 });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  it("the down refuses while a cashier is suspended, so a rollback never fails open (23514)", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A);
    await expectCode(guard().admin.query(downSql), "23514");
    const still = await guard().admin.query(`SELECT to_regclass($1) AS t`, [T]);
    expect(still.rows[0]).toEqual({ t: T });
  });

  it("the down refuses as a NOSUPERUSER owner under FORCE RLS too (a bare count would see no rows and fail open)", async () => {
    if (skip()) return;
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A);
    const e = guard();
    const owner = { role: "rt1138_migration_owner", tables: [T, "tenants"], functions: [] };
    const code = await asMigrationOwner(e, owner, async () => {
      const client = await e.admin.connect();
      try {
        await client.query(`SET ROLE ${owner.role}`);
        return await errorCode(() => client.query(downSql));
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });
    expect(code).toBe("23514");
    const still = await e.admin.query(`SELECT to_regclass($1) AS t`, [T]);
    expect(still.rows[0]).toEqual({ t: T });
  });

  it("with nobody suspended the down drops only this table, and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    // Reactivated rows do not block the down: nobody would become admissible by dropping them.
    await insertRow(guard(), TENANT_A, STORE_A, CASHIER_A, "active");
    const tablesBefore = (await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n;
    await a.query(downSql);
    const gone = await a.query(`SELECT to_regclass($1) AS t`, [T]);
    expect(gone.rows[0]).toEqual({ t: null });
    const tablesAfter = (await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n;
    expect(Number(tablesAfter)).toBe(Number(tablesBefore) - 1);
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
    const back = await a.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname = $1`, [T]);
    expect(back.rows[0]).toEqual({ relforcerowsecurity: true });
  });

  it("the down can be run again once the table is gone", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(downSql);
    expect(await errorCode(() => a.query(downSql))).toBeNull();
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
  });
});
