/**
 * RT-1485 (spec 044 PR-16a-1): `0132_pricing_authority_freeze` migration test.
 *
 * Validates `packages/db/drizzle/0132_pricing_authority_freeze.sql` (+ `.down.sql`) on a real
 * PostgreSQL 16, applied on top of every earlier migration with tenants, stores, products and
 * overrides already present (the UPGRADE path):
 *   - shape: the three tables match the Drizzle schema; FORCE RLS and the exact policy set;
 *   - seed: one `legacy` row per existing tenant; a new tenant gets its row from the tenants
 *     trigger; deleting a tenant takes its row with it;
 *   - RLS matrix as the app role (production grant: SELECT on the authority table): own rows only,
 *     none with an empty GUC, cross-tenant INSERT refused, no UPDATE / DELETE of the authority row,
 *     run rows never deleted;
 *   - the freeze, every case of spec 044 §6.2, under `cutover_in_progress` and `pricing`, and the
 *     same writes allowed under `legacy` (inert); tenant A frozen does not freeze tenant B;
 *   - the bypass: a frozen write succeeds only through pricing_reverse_project run by a member of
 *     pricing_projection_writer; the runtime role is refused whatever session variable it sets,
 *     cannot SET ROLE to the bypass role, cannot set session_replication_role, cannot execute the
 *     function or the locked-read helper;
 *   - the share lock: a priced write waits on a cutover's FOR UPDATE (55P03 under lock_timeout),
 *     a non-price write does not;
 *   - a tenant without an authority row fails closed;
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS with the tenant GUC
 *     pre-set to '' (the empty-GUC cast case); the down REFUSES with a non-`legacy` row or a run
 *     row (§8.2 R3) and succeeds on the seeded all-`legacy` rows.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT
 * set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableColumns, getTableName } from "drizzle-orm";
import type { PoolClient } from "pg";

import * as schema from "../../src/schema";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, inRolledBackTx, runSqlFile } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0132_pricing_authority_freeze.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0132_pricing_authority_freeze.down.sql");

const id = (n: string): string => `01320000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A1 = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B1 = id("0b011");
/** Priced product with a price-only override at A1. */
const PROD_A1 = id("0a031");
/** Unpriced product with an is_active-only override at A1 and a retired priced override at A2. */
const PROD_A2 = id("0a032");
/** Priced product with no reference: deletable. */
const PROD_A3 = id("0a033");
const PROD_B1 = id("0b031");
const OVR_A1_PRICED = id("0a041");
const OVR_A2_FLAG = id("0a042");
const OVR_A2_RETIRED = id("0a043");
const ACTOR = id("0a0a1");
const CORR = id("0acc1");

const TABLES = ["tenant_pricing_authority", "pricing_import_runs", "pricing_cutover_runs"] as const;
const WRITER = "pricing_projection_writer";
const REVERSE = "pricing_reverse_project(uuid, uuid, uuid, numeric, char, uuid, uuid)";
const FREEZE_FN = "pricing_legacy_freeze()";
const FROZEN = "55000";
const STATES = ["cutover_in_progress", "pricing"] as const;

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type Q = Pick<PoolClient, "query">;

/** Runs `fn` under a savepoint so the transaction survives an expected error; returns its code or null. */
async function sp(c: Q, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query("SAVEPOINT expect_error");
  const code = await errorCode(fn);
  await c.query(code === null ? "RELEASE SAVEPOINT expect_error" : "ROLLBACK TO SAVEPOINT expect_error");
  return code;
}

async function exists(name: string): Promise<boolean> {
  const r = await guard().admin.query<{ x: string | null }>(`SELECT to_regclass($1)::text AS x`, [name]);
  return r.rows[0]!.x !== null;
}

async function tenantCount(): Promise<number> {
  const r = await guard().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM tenants`);
  return Number(r.rows[0]!.n);
}

/** Commits a tenant's authority state as the superuser (tests only; production uses the PR-16b CLI). */
async function setAuthority(tenant: string, state: string): Promise<void> {
  await guard().admin.query(`UPDATE tenant_pricing_authority SET authority = $2, changed_at = now() WHERE tenant_id = $1`, [
    tenant,
    state,
  ]);
}

/** Runs `fn` with tenant A in `state`, then puts it back to `legacy` whatever happens. */
async function withAuthority<T>(tenant: string, state: string, fn: () => Promise<T>): Promise<T> {
  await setAuthority(tenant, state);
  try {
    return await fn();
  } finally {
    await setAuthority(tenant, "legacy");
  }
}

/** As the app role in tenant A's context (and store `store` for override writes); always rolled back. */
async function asAppA<T>(store: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return asApp(guard(), TENANT_A, async (c) => {
    await c.query(`SELECT set_config('app.current_store', $1, true)`, [store]);
    return fn(c);
  });
}

/** The error code of one app-role write in tenant A (store A1 unless given), rolled back. */
function appWrite(sql: string, params: unknown[] = [], store = STORE_A1): Promise<string | null> {
  return asAppA(store, (c) => errorCode(() => c.query(sql, params)));
}

/** Removes run rows as the superuser with the no-delete triggers off (test cleanup only). */
async function clearRuns(): Promise<void> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`DELETE FROM pricing_import_runs`);
    await client.query(`DELETE FROM pricing_cutover_runs`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// The §6.2 writes, each as one statement in tenant A's context.
const W = {
  productPrice: `UPDATE tenant_products SET default_price = 13 WHERE id = '${PROD_A1}'`,
  productCurrency: `UPDATE tenant_products SET default_currency_code = 'USD' WHERE id = '${PROD_A1}'`,
  productClearPrice: `UPDATE tenant_products SET default_price = NULL, default_currency_code = NULL WHERE id = '${PROD_A1}'`,
  productInsertPriced: `INSERT INTO tenant_products (tenant_id, name, tax_category, created_by, updated_by, default_price, default_currency_code)
                        VALUES ('${TENANT_A}', 'new', 'std', '${ACTOR}', '${ACTOR}', 5, 'EGP')`,
  productInsertUnpriced: `INSERT INTO tenant_products (tenant_id, name, tax_category, created_by, updated_by)
                          VALUES ('${TENANT_A}', 'new', 'std', '${ACTOR}', '${ACTOR}')`,
  productDeletePriced: `DELETE FROM tenant_products WHERE id = '${PROD_A3}'`,
  productNonPrice: `UPDATE tenant_products SET name = 'renamed', is_active = false, tax_category = 'zero' WHERE id = '${PROD_A1}'`,
  overridePrice: `UPDATE store_product_overrides SET price = 8 WHERE id = '${OVR_A1_PRICED}'`,
  overrideCurrency: `UPDATE store_product_overrides SET currency_code = 'USD' WHERE id = '${OVR_A1_PRICED}'`,
  overrideInsertPriced: `INSERT INTO store_product_overrides (tenant_id, store_id, product_id, price, currency_code, created_by, updated_by)
                         VALUES ('${TENANT_A}', '${STORE_A1}', '${PROD_A3}', 4, 'EGP', '${ACTOR}', '${ACTOR}')`,
  overrideInsertUnpriced: `INSERT INTO store_product_overrides (tenant_id, store_id, product_id, is_active, created_by, updated_by)
                           VALUES ('${TENANT_A}', '${STORE_A1}', '${PROD_A3}', false, '${ACTOR}', '${ACTOR}')`,
  overrideDeletePriced: `DELETE FROM store_product_overrides WHERE id = '${OVR_A1_PRICED}'`,
  overrideDeleteUnpriced: `DELETE FROM store_product_overrides WHERE id = '${OVR_A2_FLAG}'`,
  overrideNonPrice: `UPDATE store_product_overrides SET is_active = false, tax_category = 'zero' WHERE id = '${OVR_A1_PRICED}'`,
  overrideRetirePriced: `UPDATE store_product_overrides SET retired_at = now() WHERE id = '${OVR_A1_PRICED}'`,
  overrideRetireUnpriced: `UPDATE store_product_overrides SET retired_at = now() WHERE id = '${OVR_A2_FLAG}'`,
} as const;

/** Reactivating the retired priced override lives at store A2. */
const REACTIVATE_PRICED = `UPDATE store_product_overrides SET retired_at = NULL WHERE id = '${OVR_A2_RETIRED}'`;

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw err;
    return;
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'paf-a', 'PAF A', 'EGP'), ($2, 'paf-b', 'PAF B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, default_price, default_currency_code)
     VALUES ($1, $5, 'A1', 'std', $7, $7, 12.5, 'EGP'), ($2, $5, 'A2', 'std', $7, $7, NULL, NULL),
            ($3, $5, 'A3', 'std', $7, $7, 3, 'EGP'), ($4, $6, 'B1', 'std', $7, $7, 20, 'EGP')`,
    [PROD_A1, PROD_A2, PROD_A3, PROD_B1, TENANT_A, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO store_product_overrides (id, tenant_id, store_id, product_id, price, currency_code, is_active, retired_at, created_by, updated_by)
     VALUES ($1, $4, $5, $7, 11, 'EGP', NULL, NULL, $9, $9),
            ($2, $4, $5, $8, NULL, NULL, false, NULL, $9, $9),
            ($3, $4, $6, $8, 7, 'EGP', NULL, now(), $9, $9)`,
    [OVR_A1_PRICED, OVR_A2_FLAG, OVR_A2_RETIRED, TENANT_A, STORE_A1, STORE_A2, PROD_A1, PROD_A2, ACTOR],
  );
  await a.query(upSql);
  // Production grant (docs/operations/sql/pricing-authority-domain-grants.sql): SELECT on the
  // authority row only. SELECT + INSERT on the run tables here, so the RLS matrix can probe them.
  await a.query(`GRANT SELECT ON tenant_pricing_authority TO app_test`);
  await a.query(`GRANT SELECT, INSERT ON pricing_import_runs, pricing_cutover_runs TO app_test`);
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

// -----------------------------------------------------------------------------
// Shape and seed
// -----------------------------------------------------------------------------

describe("0132_pricing_authority_freeze — shape and seed", () => {
  it("creates the three tables and the Drizzle schema declares exactly their columns", async () => {
    if (skip()) return;
    const e = guard();
    const drizzle = Object.values(schema).filter((t) => {
      try {
        return (TABLES as readonly string[]).includes(getTableName(t as Parameters<typeof getTableName>[0]));
      } catch {
        return false;
      }
    }) as Parameters<typeof getTableColumns>[0][];
    expect(drizzle.map((t) => getTableName(t)).sort()).toEqual([...TABLES].sort());
    for (const t of drizzle) {
      const name = getTableName(t);
      const declared = Object.values(getTableColumns(t) as Record<string, { name: string; notNull: boolean }>)
        .map((c) => `${c.name}:${c.notNull ? "NO" : "YES"}`)
        .sort();
      const actual = await e.admin.query<{ c: string }>(
        `SELECT column_name || ':' || is_nullable AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
        [name],
      );
      expect([name, actual.rows.map((r) => r.c).sort()]).toEqual([name, declared]);
    }
  });

  it("FORCEs RLS: SELECT + INSERT everywhere, UPDATE on the authority row only, no DELETE; the writer's three", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of TABLES) {
      const rls = await e.admin.query<{ rel: boolean; force: boolean }>(
        `SELECT relrowsecurity AS rel, relforcerowsecurity AS force FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect([table, rls.rows[0]]).toEqual([table, { rel: true, force: true }]);
      const policies = await e.admin.query<{ p: string }>(
        `SELECT cmd || ':' || array_to_string(roles, ',') AS p FROM pg_policies WHERE tablename = $1 ORDER BY 1`,
        [table],
      );
      const expected =
        table === "tenant_pricing_authority"
          ? ["INSERT:pricing_projection_writer", "INSERT:public", "SELECT:pricing_projection_writer", "SELECT:public",
             "UPDATE:pricing_projection_writer", "UPDATE:public"]
          : ["INSERT:public", "SELECT:public"];
      expect([table, policies.rows.map((r) => r.p)]).toEqual([table, expected]);
    }
  });

  it("seeds one legacy row per existing tenant", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ n: string; legacy: string }>(
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE authority = 'legacy')::text AS legacy FROM tenant_pricing_authority`,
    );
    expect(Number(r.rows[0]!.n)).toBe(await tenantCount());
    expect(r.rows[0]!.legacy).toBe(r.rows[0]!.n);
  });

  it("gives a new tenant its legacy row (trigger) and drops it with the tenant", async () => {
    if (skip()) return;
    const tenant = id("0c001");
    await inRolledBackTx(guard().admin, async (c) => {
      await c.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'paf-c', 'PAF C', 'EGP')`, [tenant]);
      const row = await c.query<{ authority: string }>(`SELECT authority FROM tenant_pricing_authority WHERE tenant_id = $1`, [tenant]);
      expect(row.rows).toEqual([{ authority: "legacy" }]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      const gone = await c.query(`SELECT 1 FROM tenant_pricing_authority WHERE tenant_id = $1`, [tenant]);
      expect(gone.rowCount).toBe(0);
    });
  });

  it("the app role can create a tenant (platform admin) and its row is still written", async () => {
    if (skip()) return;
    const tenant = id("0c002");
    await asApp(guard(), null, async (c) => {
      await c.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant]);
      await c.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'paf-d', 'PAF D', 'EGP')`, [tenant]);
      const row = await c.query<{ authority: string }>(`SELECT authority FROM tenant_pricing_authority WHERE tenant_id = $1`, [tenant]);
      expect(row.rows).toEqual([{ authority: "legacy" }]);
    });
  });
});

// -----------------------------------------------------------------------------
// RLS matrix
// -----------------------------------------------------------------------------

describe("0132_pricing_authority_freeze — RLS matrix", () => {
  it.each(TABLES)("%s: the app role sees only its own tenant's rows, none with an empty GUC", async (table) => {
    if (skip()) return;
    const e = guard();
    const runInsert = (tenant: string) =>
      table === "pricing_import_runs"
        ? `INSERT INTO pricing_import_runs (id, tenant_id, import_instant, change_log_sequence, created_by_user_id, correlation_id)
           VALUES (gen_random_uuid(), '${tenant}', now(), 0, '${ACTOR}', '${CORR}')`
        : `INSERT INTO pricing_cutover_runs (id, tenant_id, kind, outcome, started_at, finished_at, created_by_user_id, correlation_id)
           VALUES (gen_random_uuid(), '${tenant}', 'cutover', 'aborted', now(), now(), '${ACTOR}', '${CORR}')`;
    if (table !== "tenant_pricing_authority") {
      // Rows for both tenants, committed, then cleaned (the no-delete trigger keeps them otherwise).
      await e.admin.query(runInsert(TENANT_A));
      await e.admin.query(runInsert(TENANT_B));
    }
    try {
      const own = await asApp(e, TENANT_B, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
      expect(own.rows).toEqual([{ t: TENANT_B }]);
      const none = await asApp(e, "", (c) => c.query(`SELECT 1 FROM ${table}`));
      expect(none.rowCount).toBe(0);
      if (table !== "tenant_pricing_authority") {
        // Cross-tenant INSERT refused by the WITH CHECK.
        expect(await asApp(e, TENANT_B, (c) => errorCode(() => c.query(runInsert(TENANT_A))))).toBe("42501");
        // Run rows are never deleted, whatever the role.
        expect(await inRolledBackTx(e.admin, (c) => errorCode(() => c.query(`DELETE FROM ${table}`)))).toBe("42501");
        expect(await inRolledBackTx(e.admin, (c) => errorCode(() => c.query(`TRUNCATE ${table}`)))).toBe("42501");
      }
    } finally {
      if (table !== "tenant_pricing_authority") await clearRuns();
    }
  });

  it("the app role cannot insert, change or delete an authority row (no grant)", async () => {
    if (skip()) return;
    const e = guard();
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => c.query(`UPDATE tenant_pricing_authority SET authority = 'legacy'`)))).toBe("42501");
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => c.query(`DELETE FROM tenant_pricing_authority`)))).toBe("42501");
    expect(
      await asApp(e, TENANT_A, (c) =>
        errorCode(() => c.query(`INSERT INTO tenant_pricing_authority (tenant_id) VALUES ($1)`, [TENANT_A])),
      ),
    ).toBe("42501");
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => c.query(`SELECT 1 FROM tenant_pricing_authority FOR SHARE`)))).toBe("42501");
  });

  it("refuses an unknown authority state", async () => {
    if (skip()) return;
    expect(await errorCode(() => setAuthority(TENANT_A, "frozen"))).toBe("23514");
  });
});

// -----------------------------------------------------------------------------
// The freeze (spec 044 §6.2)
// -----------------------------------------------------------------------------

describe("0132_pricing_authority_freeze — inert under legacy", () => {
  it.each(Object.entries(W))("%s goes through while the tenant is legacy", async (_name, sql) => {
    if (skip()) return;
    expect(await appWrite(sql)).toBeNull();
  });

  it("reactivating a priced override goes through while the tenant is legacy", async () => {
    if (skip()) return;
    expect(await appWrite(REACTIVATE_PRICED, [], STORE_A2)).toBeNull();
  });
});

describe.each(STATES)("0132_pricing_authority_freeze — frozen under %s", (state) => {
  beforeAll(async () => {
    if (!skip()) await setAuthority(TENANT_A, state);
  });
  afterAll(async () => {
    if (!skip()) await setAuthority(TENANT_A, "legacy");
  });

  const rejected: (keyof typeof W)[] = [
    "productPrice",
    "productCurrency",
    "productClearPrice",
    "productInsertPriced",
    "productDeletePriced",
    "overridePrice",
    "overrideCurrency",
    "overrideInsertPriced",
    "overrideDeletePriced",
  ];
  const allowed: (keyof typeof W)[] = [
    "productInsertUnpriced",
    "productNonPrice",
    "overrideInsertUnpriced",
    "overrideDeleteUnpriced",
    "overrideNonPrice",
    "overrideRetireUnpriced",
  ];

  it.each(rejected)("rejects %s with 55000 pricing_authority_frozen", async (name) => {
    if (skip()) return;
    const message = await asAppA(STORE_A1, async (c) => {
      try {
        await c.query(W[name]);
        return null;
      } catch (err) {
        return `${(err as { code?: string }).code} ${(err as Error).message}`;
      }
    });
    expect(message).toMatch(new RegExp(`^${FROZEN} pricing_authority_frozen`));
  });

  it.each(allowed)("allows %s (not a price write)", async (name) => {
    if (skip()) return;
    expect(await appWrite(W[name])).toBeNull();
  });

  it(`retiring and reactivating a priced override: ${state === "cutover_in_progress" ? "rejected" : "allowed"}`, async () => {
    if (skip()) return;
    const expected = state === "cutover_in_progress" ? FROZEN : null;
    expect(await appWrite(W.overrideRetirePriced)).toBe(expected);
    expect(await appWrite(REACTIVATE_PRICED, [], STORE_A2)).toBe(expected);
  });

  it("does not freeze another tenant", async () => {
    if (skip()) return;
    const code = await asApp(guard(), TENANT_B, (c) =>
      errorCode(() => c.query(`UPDATE tenant_products SET default_price = 21 WHERE id = $1`, [PROD_B1])),
    );
    expect(code).toBeNull();
  });

  it("the runtime role is still rejected after setting any session variable", async () => {
    if (skip()) return;
    const code = await asAppA(STORE_A1, async (c) => {
      for (const [k, v] of [
        ["app.is_platform_admin", "true"],
        ["app.pricing_bypass", "true"],
        ["app.pricing_authority", "legacy"],
        ["pricing.reverse_project", "on"],
        ["app.current_role", WRITER],
      ] as const) {
        await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
      }
      return errorCode(() => c.query(W.productPrice));
    });
    expect(code).toBe(FROZEN);
  });
});

// -----------------------------------------------------------------------------
// The bypass
// -----------------------------------------------------------------------------

describe("0132_pricing_authority_freeze — the privileged bypass", () => {
  const OPERATOR = "rt1485_operator";

  beforeAll(async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(`CREATE ROLE ${OPERATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await a.query(`GRANT ${WRITER} TO ${OPERATOR}`);
    await setAuthority(TENANT_A, "pricing");
  });
  afterAll(async () => {
    if (skip()) return;
    await setAuthority(TENANT_A, "legacy");
    await guard().admin.query(`DROP ROLE IF EXISTS ${OPERATOR}`);
  });

  /** As the operator role (a member of the writer role, like the migration owner), rolled back. */
  function asOperator<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return inRolledBackTx(guard().admin, async (c) => {
      await c.query(`SET LOCAL ROLE ${OPERATOR}`);
      return fn(c);
    });
  }

  const reverse = (c: Q, product: string, store: string | null, price: string | null): Promise<unknown> =>
    c.query(`SELECT pricing_reverse_project($1, $2, $3, $4, $5, $6, $7)`, [
      TENANT_A,
      product,
      store,
      price,
      price === null ? null : "EGP",
      ACTOR,
      CORR,
    ]);

  it("writes a frozen Book price through pricing_reverse_project and restores the caller's context", async () => {
    if (skip()) return;
    await asOperator(async (c) => {
      await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_B]);
      await reverse(c, PROD_A1, null, "99.0000");
      const ctx = await c.query<{ t: string; s: string }>(
        `SELECT current_setting('app.current_tenant', true) AS t, current_setting('app.current_store', true) AS s`,
      );
      expect(ctx.rows[0]!.t).toBe(TENANT_B);
      await c.query(`RESET ROLE`);
      const p = await c.query<{ p: string }>(`SELECT default_price::text AS p FROM tenant_products WHERE id = $1`, [PROD_A1]);
      expect(p.rows[0]!.p).toBe("99.0000");
    });
  });

  it("updates, inserts and clears override prices; a price-only override is retired, not emptied", async () => {
    if (skip()) return;
    await asOperator(async (c) => {
      await reverse(c, PROD_A1, STORE_A1, "8.0000"); // update the live priced override
      await reverse(c, PROD_A3, STORE_A2, "2.0000"); // no live override: insert a price-only one
      await reverse(c, PROD_A2, STORE_A1, "6.0000"); // is_active-only override gains a price
      await reverse(c, PROD_A2, STORE_A1, null); // ...and loses it again: price cleared, row kept
      await reverse(c, PROD_A1, STORE_A1, null); // price-only override: retired
      await c.query(`RESET ROLE`);
      const rows = await c.query<{ store: string; product: string; price: string | null; retired: boolean; active: boolean | null }>(
        `SELECT store_id::text AS store, product_id::text AS product, price::text AS price,
                retired_at IS NOT NULL AS retired, is_active AS active
           FROM store_product_overrides WHERE tenant_id = $1 AND id <> $2 ORDER BY store_id, product_id`,
        [TENANT_A, OVR_A2_RETIRED],
      );
      expect(rows.rows).toEqual([
        { store: STORE_A1, product: PROD_A1, price: "8.0000", retired: true, active: null },
        { store: STORE_A1, product: PROD_A2, price: null, retired: false, active: false },
        { store: STORE_A2, product: PROD_A3, price: "2.0000", retired: false, active: null },
      ]);
    });
  });

  it("refuses a half-given price and an unknown product", async () => {
    if (skip()) return;
    expect(
      await asOperator((c) =>
        errorCode(() => c.query(`SELECT pricing_reverse_project($1, $2, NULL, 5, NULL, $3, $4)`, [TENANT_A, PROD_A1, ACTOR, CORR])),
      ),
    ).toBe("22023");
    expect(await asOperator((c) => errorCode(() => reverse(c, id("0a0ff"), null, "5")))).toBe("P0002");
  });

  it("the operator's own direct write is still frozen (only the function bypasses)", async () => {
    if (skip()) return;
    const code = await asOperator(async (c) => {
      await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      return errorCode(() => c.query(W.productPrice));
    });
    expect(code).toBe(FROZEN);
  });

  it("the runtime role cannot execute the function or the locked-read helper", async () => {
    if (skip()) return;
    const e = guard();
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => reverse(c, PROD_A1, null, "1")))).toBe("42501");
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => c.query(`SELECT pricing_authority_for_share($1)`, [TENANT_A]))))
      .toBe("42501");
  });

  it("the runtime role cannot become the writer or switch triggers off", async () => {
    if (skip()) return;
    const e = guard();
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => c.query(`SET ROLE ${WRITER}`)))).toBe("42501");
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => c.query(`SET session_replication_role = replica`)))).toBe("42501");
    const roles = await e.admin.query<{ ok: boolean }>(
      `SELECT pg_has_role('app_test', $1, 'MEMBER') AS ok`,
      [WRITER],
    );
    expect(roles.rows[0]!.ok).toBe(false);
  });

  it("pricing_reverse_project is not executable by PUBLIC and is owned by the writer role", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ owner: string; pub: boolean; secdef: boolean }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [REVERSE],
    );
    expect(r.rows[0]).toEqual({ owner: WRITER, pub: false, secdef: true });
    const freeze = await guard().admin.query<{ secdef: boolean }>(
      `SELECT prosecdef AS secdef FROM pg_proc WHERE oid = $1::regprocedure`,
      [FREEZE_FN],
    );
    expect(freeze.rows[0]!.secdef).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Locking and fail-closed
// -----------------------------------------------------------------------------

describe("0132_pricing_authority_freeze — share lock and missing row", () => {
  it("a priced write waits on a cutover's FOR UPDATE; a non-price write does not", async () => {
    if (skip()) return;
    const e = guard();
    const holder = await e.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM tenant_pricing_authority WHERE tenant_id = $1 FOR UPDATE`, [TENANT_A]);
      const priced = await asAppA(STORE_A1, async (c) => {
        await c.query(`SET LOCAL lock_timeout = '300ms'`);
        return errorCode(() => c.query(W.productPrice));
      });
      expect(priced).toBe("55P03");
      const nonPrice = await asAppA(STORE_A1, async (c) => {
        await c.query(`SET LOCAL lock_timeout = '300ms'`);
        return errorCode(() => c.query(W.productNonPrice));
      });
      expect(nonPrice).toBeNull();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("fails closed when the tenant has no authority row", async () => {
    if (skip()) return;
    const message = await inRolledBackTx(guard().admin, async (c) => {
      await c.query(`DELETE FROM tenant_pricing_authority WHERE tenant_id = $1`, [TENANT_A]);
      await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      try {
        await c.query(W.productPrice);
        return null;
      } catch (err) {
        return `${(err as { code?: string }).code} ${(err as Error).message}`;
      }
    });
    expect(message).toMatch(/^55000 pricing_authority_missing/);
  });
});

// -----------------------------------------------------------------------------
// Rollback (spec 044 §8.2 R3)
// -----------------------------------------------------------------------------

describe("0132_pricing_authority_freeze — down migration", () => {
  const OWNER_TABLES = [
    ...TABLES,
    "tenants",
    "tenant_products",
    "store_product_overrides",
    "catalog_change_log",
    "pricing_revisions",
  ];
  const OWNER_FUNCTIONS = [FREEZE_FN];

  async function runFileWithEmptyGuc(path: string, role: string): Promise<string | null> {
    const client = await guard().admin.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await client.query(`SELECT set_config('app.current_tenant', '', false)`);
      return await errorCode(() => client.query(readFileSync(path, "utf8")));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query("RESET app.current_tenant").catch(() => undefined);
      client.release();
    }
  }

  /** A NOSUPERUSER, NOBYPASSRLS owner that is a member of the writer role, like production's. */
  function asOwner<T>(role: string, fn: () => Promise<T>): Promise<T> {
    return asMigrationOwner(guard(), { role, tables: OWNER_TABLES, functions: OWNER_FUNCTIONS }, async () => {
      await guard().admin.query(`GRANT ${WRITER} TO ${role}`);
      return fn();
    });
  }

  it("REFUSES while an authority row is not legacy, also as a NOSUPERUSER owner under FORCE RLS", async () => {
    if (skip()) return;
    const e = guard();
    await withAuthority(TENANT_A, "pricing", async () => {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("55000");
      await asOwner("rt1485_refuse_owner", async () => {
        expect(await runFileWithEmptyGuc(DOWN_PATH, "rt1485_refuse_owner")).toBe("55000");
      });
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
  });

  it("REFUSES while a run row exists", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(
      `INSERT INTO pricing_import_runs (id, tenant_id, import_instant, change_log_sequence, created_by_user_id, correlation_id)
       VALUES (gen_random_uuid(), $1, now(), 0, $2, $3)`,
      [TENANT_B, ACTOR, CORR],
    );
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("55000");
    } finally {
      await clearRuns();
    }
    await e.admin.query(
      `INSERT INTO pricing_cutover_runs (id, tenant_id, kind, outcome, started_at, finished_at, created_by_user_id, correlation_id)
       VALUES (gen_random_uuid(), $1, 'rollback', 'succeeded', now(), now(), $2, $3)`,
      [TENANT_B, ACTOR, CORR],
    );
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("55000");
    } finally {
      await clearRuns();
    }
  });

  it("succeeds on the seeded all-legacy rows, is rerunnable, and the up (as the owner) recreates and reseeds", async () => {
    if (skip()) return;
    const e = guard();
    await asOwner("rt1485_down_owner", async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, "rt1485_down_owner")).toBeNull();
      for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, false]);
      const fns = await e.admin.query(`SELECT 1 FROM pg_proc WHERE proname LIKE 'pricing\\_%' AND proname IN
        ('pricing_legacy_freeze', 'pricing_authority_for_share', 'pricing_authority_seed_tenant', 'pricing_reverse_project')`);
      expect(fns.rowCount).toBe(0);
      const triggers = await e.admin.query(`SELECT 1 FROM pg_trigger WHERE tgname LIKE '%pricing\\_%' AND tgname IN
        ('tenants_pricing_authority_seed', 'tenant_products_pricing_freeze', 'store_product_overrides_pricing_freeze')`);
      expect(triggers.rowCount).toBe(0);
      const privileges = await e.admin.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, 'tenant_products', 'SELECT') OR has_table_privilege($1, 'catalog_change_log', 'INSERT') AS ok`,
        [WRITER],
      );
      expect(privileges.rows[0]!.ok).toBe(false);
      // With the freeze gone, a legacy price write goes through.
      expect(await appWrite(W.productPrice)).toBeNull();
      // Rerunnable.
      expect(await runFileWithEmptyGuc(DOWN_PATH, "rt1485_down_owner")).toBeNull();
      // The up, as the same NOSUPERUSER owner with an empty tenant GUC, seeds every tenant.
      expect(await runFileWithEmptyGuc(UP_PATH, "rt1485_down_owner")).toBeNull();
    });
    // runFileWithEmptyGuc rolls back on failure only; the up above committed (its own BEGIN/COMMIT).
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    const seeded = await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_pricing_authority WHERE authority = 'legacy'`,
    );
    expect(Number(seeded.rows[0]!.n)).toBe(await tenantCount());
    // The plain superuser round trip still works.
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    await e.admin.query(`GRANT SELECT ON tenant_pricing_authority TO app_test`);
    expect(await withAuthority(TENANT_A, "pricing", () => appWrite(W.productPrice))).toBe(FROZEN);
  });

  it("the up refuses when another role can act as the writer role", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    await e.admin.query(`GRANT ${WRITER} TO app_test`);
    try {
      expect(await runSqlFile(e, UP_PATH)).toBe("42501");
    } finally {
      await e.admin.query(`REVOKE ${WRITER} FROM app_test`);
      await e.admin.query(upSql);
      await e.admin.query(`GRANT SELECT ON tenant_pricing_authority TO app_test`);
    }
    expect(await exists("tenant_pricing_authority")).toBe(true);
  });
});
