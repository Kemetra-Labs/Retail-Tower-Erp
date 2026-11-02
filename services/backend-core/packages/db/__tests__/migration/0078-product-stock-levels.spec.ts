/**
 * 0078 — a product's low-stock thresholds (Jira RT-1066; RT-1064 decision
 * record TH-5; [GATED] migration approved under the owner delegation of
 * 2026-11-02).
 *
 * Applies every migration before 0078 against a real Postgres, seeds two
 * tenants with products and stores, applies 0078 exactly as the runner does
 * (one `query()` for the file), and proves:
 *   - the table, its CHECKs (`reorder_level > 0`, `0 < critical_level <=
 *     reorder_level`, equal allowed) and exact `numeric(19,4)` storage;
 *   - at most one ACTIVE level per scope (tenant level; store level), a
 *     retired level not counting;
 *   - the product and the store are pinned to the row's tenant (composite
 *     FKs; a tenant level has no store);
 *   - RLS ENABLE + FORCE, fail-closed with the GUC unset or '', tenant-scoped
 *     SELECT / INSERT WITH CHECK / UPDATE, and no DELETE policy (the app role
 *     deletes nothing);
 *   - `updated_at` is stamped on UPDATE (trigger);
 *   - down refuses while any level is stored (also as a NON-superuser owner
 *     under FORCE RLS), drops the table once empty, and round-trips with up.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { DRIZZLE_DIR, startEnvBefore } from "../_helpers/migration-before";
import { asApp, asMigrationOwner, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const UP_NAME = "0078_product_stock_levels.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, "0078_product_stock_levels.down.sql"), "utf8");

const TENANT = "0a000000-0000-7000-8000-000000106601";
const TENANT_B = "0b000000-0000-7000-8000-000000106601";
const ACTOR = "0a000000-0000-7000-8000-000000106603";
const STORE = "0a000000-0000-7000-8000-000000106610";
const STORE_2 = "0a000000-0000-7000-8000-000000106611";
const STORE_B = "0b000000-0000-7000-8000-000000106610";
const PRODUCT = "0a000000-0000-7000-8000-000000106620";
const PRODUCT_B = "0b000000-0000-7000-8000-000000106620";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

const id = (): string => `0a000000-0000-7000-8000-${(0x1066a0000 + seq++).toString(16).padStart(12, "0")}`;

interface LevelRow {
  readonly tenantId?: string;
  readonly productId?: string;
  readonly storeId?: string | null;
  readonly reorder?: string | null;
  readonly critical?: string | null;
  readonly retired?: boolean;
}

const INSERT_SQL = `INSERT INTO product_stock_levels
     (id, tenant_id, product_id, store_id, reorder_level, critical_level, retired_at, created_by, updated_by)
   VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, CASE WHEN $7::boolean THEN now() END, $8, $8)`;

function params(row: LevelRow): unknown[] {
  return [
    id(),
    row.tenantId ?? TENANT,
    row.productId ?? PRODUCT,
    row.storeId ?? null,
    row.reorder === undefined ? "10" : row.reorder,
    row.critical === undefined ? "2" : row.critical,
    row.retired ?? false,
    ACTOR,
  ];
}

/** Inserts `rows` on one superuser connection, always rolled back; returns the first error code. */
async function insertCode(...rows: LevelRow[]): Promise<string | null> {
  const client = await pg().admin.connect();
  try {
    await client.query("BEGIN");
    return await errorCode(async () => {
      for (const row of rows) await client.query(INSERT_SQL, params(row));
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function count(client: PoolClient, where = "TRUE"): Promise<number> {
  const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM product_stock_levels WHERE ${where}`);
  return r.rows[0]!.n;
}

async function tableExists(): Promise<boolean> {
  const r = await pg().admin.query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'product_stock_levels'`);
  return r.rows.length === 1;
}

beforeAll(async () => {
  env = await startEnvBefore(UP_NAME, "0078 spec");
  if (env === null) return;
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt1066-a', 'A'), ($2, 'rt1066-b', 'B')`, [TENANT, TENANT_B]);
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'S1', 'S1'), ($2, $4, 'S2', 'S2'), ($3, $5, 'SB', 'SB')`,
    [STORE, STORE_2, STORE_B, TENANT, TENANT_B],
  );
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'a@rt1066.example')`, [ACTOR]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $3, 'RT1066 A', 'standard', $4, $4), ($2, $5, 'RT1066 B', 'standard', $4, $4)`,
    [PRODUCT, PRODUCT_B, TENANT, ACTOR, TENANT_B],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0078 up", () => {
  it("creates the table with RLS enabled and forced, and SELECT / INSERT / UPDATE policies only", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    // The app role's table grants (GRANT ... ON ALL TABLES) cover the new table only once it exists.
    await ensureAppRole(pg());
    const rls = await pg().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'product_stock_levels'::regclass`,
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'product_stock_levels' ORDER BY cmd`,
    );
    expect(policies.rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("accepts a tenant level, a store level and critical = reorder; stores the exact decimal", async () => {
    if (skip()) return;
    expect(
      await insertCode(
        { reorder: "12.5", critical: "12.5" },
        { storeId: STORE, reorder: "999999999999999.9999", critical: null },
      ),
    ).toBeNull();
    const client = await pg().admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(INSERT_SQL, params({ reorder: "0.0001", critical: "0.0001" }));
      const r = await client.query<{ r: string }>(`SELECT reorder_level::text AS r FROM product_stock_levels`);
      expect(r.rows[0]!.r).toBe("0.0001");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each([
    ["a zero reorder level", { reorder: "0", critical: null }, "23514"],
    ["a negative reorder level", { reorder: "-1", critical: null }, "23514"],
    ["a zero critical level", { reorder: "5", critical: "0" }, "23514"],
    ["a critical level above the reorder level", { reorder: "5", critical: "5.0001" }, "23514"],
    ["a NULL reorder level", { reorder: null }, "23502"],
  ] as const)("refuses %s", async (_label, row, code) => {
    if (skip()) return;
    expect(await insertCode(row)).toBe(code);
  });

  it("allows one active level per scope; a retired level does not count", async () => {
    if (skip()) return;
    expect(await insertCode({}, {})).toBe("23505");
    expect(await insertCode({ storeId: STORE }, { storeId: STORE })).toBe("23505");
    expect(await insertCode({ retired: true }, { retired: true }, {})).toBeNull();
    expect(await insertCode({ storeId: STORE, retired: true }, { storeId: STORE })).toBeNull();
    expect(await insertCode({}, { storeId: STORE }, { storeId: STORE_2 })).toBeNull();
  });

  it("pins the product and the store to the row's tenant", async () => {
    if (skip()) return;
    expect(await insertCode({ productId: PRODUCT_B })).toBe("23503");
    expect(await insertCode({ storeId: STORE_B })).toBe("23503");
    expect(await insertCode({ tenantId: TENANT_B, productId: PRODUCT_B, storeId: STORE })).toBe("23503");
    expect(await insertCode({ tenantId: TENANT_B, productId: PRODUCT_B, storeId: STORE_B })).toBeNull();
  });

  describe("RLS (app role)", () => {
    beforeAll(async () => {
      if (skip()) return;
      await pg().admin.query(INSERT_SQL, params({}));
      await pg().admin.query(INSERT_SQL, params({ storeId: STORE }));
      await pg().admin.query(INSERT_SQL, params({ tenantId: TENANT_B, productId: PRODUCT_B }));
    });

    it("is fail-closed with the tenant GUC unset or empty", async () => {
      if (skip()) return;
      expect(await asApp(pg(), null, (c) => count(c))).toBe(0);
      expect(await asApp(pg(), "", (c) => count(c))).toBe(0);
    });

    it("reads only the session tenant's levels", async () => {
      if (skip()) return;
      expect(await asApp(pg(), TENANT, (c) => count(c))).toBe(2);
      expect(await asApp(pg(), TENANT_B, (c) => count(c))).toBe(1);
      expect(await asApp(pg(), TENANT, (c) => count(c, `tenant_id = '${TENANT_B}'`))).toBe(0);
    });

    it("refuses an INSERT for another tenant (WITH CHECK)", async () => {
      if (skip()) return;
      const code = await asApp(pg(), TENANT, (c) =>
        errorCode(() => c.query(INSERT_SQL, params({ tenantId: TENANT_B, productId: PRODUCT_B, storeId: STORE_B }))),
      );
      expect(code).toBe("42501");
    });

    it("updates its own tenant's level, never another tenant's, and never moves a row to another tenant", async () => {
      if (skip()) return;
      await asApp(pg(), TENANT, async (c) => {
        const own = await c.query(`UPDATE product_stock_levels SET reorder_level = 11 WHERE store_id IS NULL`);
        expect(own.rowCount).toBe(1);
        const other = await c.query(`UPDATE product_stock_levels SET reorder_level = 11 WHERE tenant_id = $1`, [TENANT_B]);
        expect(other.rowCount).toBe(0);
        const moved = await errorCode(() =>
          c.query(`UPDATE product_stock_levels SET tenant_id = $1 WHERE store_id IS NULL`, [TENANT_B]),
        );
        expect(moved).toBe("42501");
      });
    });

    it("stamps updated_at on UPDATE (the set_updated_at trigger)", async () => {
      if (skip()) return;
      const read = async (): Promise<number> =>
        (
          await pg().admin.query<{ u: Date }>(
            `SELECT updated_at AS u FROM product_stock_levels WHERE tenant_id = $1 AND store_id IS NULL`,
            [TENANT],
          )
        ).rows[0]!.u.getTime();
      const before = await read();
      await new Promise((r) => setTimeout(r, 5));
      await pg().admin.query(`UPDATE product_stock_levels SET critical_level = 3 WHERE tenant_id = $1 AND store_id IS NULL`, [
        TENANT,
      ]);
      expect(await read()).toBeGreaterThan(before);
    });

    it("deletes nothing: there is no DELETE policy", async () => {
      if (skip()) return;
      const deleted = await asApp(pg(), TENANT, (c) => c.query(`DELETE FROM product_stock_levels`));
      expect(deleted.rowCount).toBe(0);
    });
  });
});

describe("0078 down", () => {
  it("refuses while any level is stored, also as a non-superuser owner under FORCE RLS", async () => {
    if (skip()) return;
    expect(await errorCode(() => pg().admin.query(DOWN_SQL()))).toBe("P0001");
    const owner = { role: "rt1066_migration_owner", tables: ["product_stock_levels", "tenants"], functions: [] };
    const asOwner = await asMigrationOwner(pg(), owner, async () => {
      const client = await pg().admin.connect();
      try {
        await client.query(`SET ROLE ${owner.role}`);
        return await errorCode(() => client.query(DOWN_SQL()));
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });
    expect(asOwner).toBe("P0001");
    expect(await tableExists()).toBe(true);
  });

  it("drops the table once empty and round-trips with up", async () => {
    if (skip()) return;
    await pg().admin.query(`DELETE FROM product_stock_levels`);
    await pg().admin.query(DOWN_SQL());
    expect(await tableExists()).toBe(false);
    await pg().admin.query(UP_SQL());
    expect(await tableExists()).toBe(true);
    expect(await insertCode({})).toBeNull();
  });
});
