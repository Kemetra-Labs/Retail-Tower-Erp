/**
 * RT-1334 (RT-286 spec 048 slice S1): `0095_tenant_product_brands` migration
 * test.
 *
 * Validates `packages/db/drizzle/0095_tenant_product_brands.sql` (+ `.down.sql`)
 * on a real PostgreSQL 16 (Testcontainers), applied on top of every earlier
 * migration with a product already in the catalog (the UPGRADE path):
 *   - FORCE RLS on `tenant_product_brands` and the exact policy set (SELECT,
 *     INSERT, UPDATE; no DELETE policy);
 *   - the name CHECK (1..200), active-name uniqueness per tenant (a retired
 *     brand frees its name; another tenant may use the same name);
 *   - `tenant_products.brand_id`: nullable, existing products keep NULL, the
 *     composite FK is VALIDATED and refuses another tenant's or a missing
 *     brand (AC1);
 *   - deleting a brand sets ONLY its products' `brand_id` to NULL (AC2): the
 *     products, their tenant and the rest of the row stay, and the POS change
 *     log is not written (OD-6);
 *   - tenant isolation under FORCE RLS as the app role (AC1): own tenant only,
 *     an empty tenant GUC sees nothing, cross-tenant INSERT / UPDATE refused,
 *     no DELETE;
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS
 *     with the session tenant GUC pre-set to '' (the empty-GUC cast case), and
 *     the down REFUSES while a brand exists.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0095_tenant_product_brands.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0095_tenant_product_brands.down.sql");

const id = (n: string): string => `09500000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const ACTOR = id("0a0a1");
const PRODUCT_A = id("0a0d1");
const PRODUCT_A2 = id("0a0d2");
const PRODUCT_B = id("0b0d1");
const BRAND_A = id("0a0b1");
const BRAND_A2 = id("0a0b2");
const BRAND_B = id("0b0b1");
const MISSING_BRAND = id("0a0b9");

const B = "tenant_product_brands";
const P = "tenant_products";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

const INSERT_BRAND = `INSERT INTO ${B} (id, tenant_id, name, created_by) VALUES ($1, $2, $3, $4)`;
const INSERT_PRODUCT = `INSERT INTO ${P} (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, $3, 'std', $4, $4)`;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0095-tenant-product-brands.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  // Setup errors from here on are real failures: never skipped.
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'brd-a', 'BRD A', 'USD'), ($2, 'brd-b', 'BRD B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  // Products that exist BEFORE the migration (the upgrade path).
  await a.query(INSERT_PRODUCT, [PRODUCT_A, TENANT_A, "Shoe A", ACTOR]);
  await a.query(INSERT_PRODUCT, [PRODUCT_A2, TENANT_A, "Sock A", ACTOR]);
  await a.query(INSERT_PRODUCT, [PRODUCT_B, TENANT_B, "Shoe B", ACTOR]);
  await a.query(upSql);
  // The app role's table grants are taken after the table exists.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** Run one statement as the superuser inside a rolled-back transaction; returns the error code or null. */
async function tryRun(sql: string, params: unknown[]): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function seedBrands(): Promise<void> {
  await guard().admin.query(INSERT_BRAND, [BRAND_A, TENANT_A, "Nike", ACTOR]);
  await guard().admin.query(INSERT_BRAND, [BRAND_B, TENANT_B, "Adidas", ACTOR]);
}

/** Clears every product's brand, then every brand (superuser; the table has no DELETE policy). */
async function clearBrands(): Promise<void> {
  await guard().admin.query(`UPDATE ${P} SET brand_id = NULL WHERE brand_id IS NOT NULL`);
  await guard().admin.query(`DELETE FROM ${B}`);
}

/**
 * Run a migration file on one connection as `role`, with the session's
 * `app.current_tenant` pre-set to '' (the state a pooled connection can be
 * in), and return its error code or null. Rolled back on failure.
 */
async function runFileWithEmptyGuc(path: string, role: string): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    await client.query("SELECT set_config('app.current_tenant', '', false)");
    return await errorCode(() => client.query(readFileSync(path, "utf8")));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query("RESET app.current_tenant").catch(() => undefined);
    client.release();
  }
}

describe("0095: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0095: RLS and policies", () => {
  it("forces RLS on tenant_product_brands with SELECT, INSERT and UPDATE policies and no DELETE policy", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
      [B],
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await guard().admin.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = $1 ORDER BY policyname`,
      [B],
    );
    expect(policies.rows).toEqual([
      { policyname: "tenant_product_brands_tenant_insert", cmd: "INSERT" },
      { policyname: "tenant_product_brands_tenant_select", cmd: "SELECT" },
      { policyname: "tenant_product_brands_tenant_update", cmd: "UPDATE" },
    ]);
  });
});

describe("0095: brand constraints", () => {
  it("bounds the name to 1..200 characters", async () => {
    if (skip()) return;
    expect(await tryRun(INSERT_BRAND, [BRAND_A, TENANT_A, "x".repeat(200), ACTOR])).toBeNull();
    expect(await tryRun(INSERT_BRAND, [BRAND_A, TENANT_A, "", ACTOR])).toBe("23514");
    expect(await tryRun(INSERT_BRAND, [BRAND_A, TENANT_A, "x".repeat(201), ACTOR])).toBe("23514");
  });

  it("keeps active names unique per tenant; a retired brand frees its name; another tenant may reuse it", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(INSERT_BRAND, [BRAND_A, TENANT_A, "Nike", ACTOR]);
      await client.query("SAVEPOINT s1");
      expect(await errorCode(() => client.query(INSERT_BRAND, [BRAND_A2, TENANT_A, "Nike", ACTOR]))).toBe("23505");
      await client.query("ROLLBACK TO SAVEPOINT s1");
      // Names compare exactly, as categories do.
      expect(await errorCode(() => client.query(INSERT_BRAND, [BRAND_A2, TENANT_A, "nike", ACTOR]))).toBeNull();
      await client.query(`DELETE FROM ${B} WHERE id = $1`, [BRAND_A2]);
      expect(await errorCode(() => client.query(INSERT_BRAND, [BRAND_B, TENANT_B, "Nike", ACTOR]))).toBeNull();
      await client.query(`UPDATE ${B} SET retired_at = now() WHERE id = $1`, [BRAND_A]);
      expect(await errorCode(() => client.query(INSERT_BRAND, [BRAND_A2, TENANT_A, "Nike", ACTOR]))).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("0095: tenant_products.brand_id", () => {
  it("is a nullable uuid that existing products hold as NULL", async () => {
    if (skip()) return;
    const col = await guard().admin.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'brand_id'`,
      [P],
    );
    expect(col.rows).toEqual([{ data_type: "uuid", is_nullable: "YES", column_default: null }]);
    const rows = await guard().admin.query<{ id: string; brand_id: string | null }>(
      `SELECT id, brand_id FROM ${P} WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[PRODUCT_A, PRODUCT_A2, PRODUCT_B]],
    );
    expect(rows.rows.map((r) => r.brand_id)).toEqual([null, null, null]);
  });

  it("has a VALIDATED composite FK with ON DELETE SET NULL (brand_id)", async () => {
    if (skip()) return;
    const fk = await guard().admin.query<{ convalidated: boolean; def: string }>(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fk_tenant_products_brand_tenant'`,
    );
    expect(fk.rows).toHaveLength(1);
    expect(fk.rows[0]!.convalidated).toBe(true);
    expect(fk.rows[0]!.def).toBe(
      "FOREIGN KEY (tenant_id, brand_id) REFERENCES tenant_product_brands(tenant_id, id) ON DELETE SET NULL (brand_id)",
    );
  });

  it("accepts the product's own tenant's brand and refuses another tenant's or a missing brand", async () => {
    if (skip()) return;
    await seedBrands();
    try {
      const SET = `UPDATE ${P} SET brand_id = $2 WHERE id = $1`;
      expect(await tryRun(SET, [PRODUCT_A, BRAND_A])).toBeNull();
      expect(await tryRun(SET, [PRODUCT_A, BRAND_B])).toBe("23503");
      expect(await tryRun(SET, [PRODUCT_A, MISSING_BRAND])).toBe("23503");
      expect(await tryRun(SET, [PRODUCT_A, null])).toBeNull();
    } finally {
      await clearBrands();
    }
  });

  it("AC2: deleting a brand clears only brand_id on its products; the products, their tenant and the change log stay", async () => {
    if (skip()) return;
    const a = guard().admin;
    await seedBrands();
    try {
      await a.query(`UPDATE ${P} SET brand_id = $2 WHERE id = ANY($1::uuid[])`, [[PRODUCT_A, PRODUCT_A2], BRAND_A]);
      await a.query(`UPDATE ${P} SET brand_id = $2 WHERE id = $1`, [PRODUCT_B, BRAND_B]);
      const logBefore = (await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM catalog_change_log`)).rows[0]!.n;

      await a.query(`DELETE FROM ${B} WHERE id = $1`, [BRAND_A]);

      const rows = await a.query<{ id: string; tenant_id: string; name: string; brand_id: string | null }>(
        `SELECT id, tenant_id, name, brand_id FROM ${P} WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [[PRODUCT_A, PRODUCT_A2, PRODUCT_B]],
      );
      expect(rows.rows).toEqual([
        { id: PRODUCT_A, tenant_id: TENANT_A, name: "Shoe A", brand_id: null },
        { id: PRODUCT_B, tenant_id: TENANT_B, name: "Shoe B", brand_id: BRAND_B },
        { id: PRODUCT_A2, tenant_id: TENANT_A, name: "Sock A", brand_id: null },
      ]);
      // brand_id is not sellable-relevant: the POS read-down log did not move (OD-6).
      const logAfter = (await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM catalog_change_log`)).rows[0]!.n;
      expect(logAfter).toBe(logBefore);
    } finally {
      await clearBrands();
    }
  });
});

describe("0095: tenant isolation (AC1, FORCE RLS)", () => {
  it("lets the app role read and change only its own tenant's brands, never delete one", async () => {
    if (skip()) return;
    await seedBrands();
    try {
      await asApp(guard(), TENANT_A, async (client) => {
        expect((await client.query<{ id: string }>(`SELECT id FROM ${B}`)).rows).toEqual([{ id: BRAND_A }]);
        // Another tenant's brand is refused by the INSERT policy (42501).
        await client.query("SAVEPOINT other");
        await expect(client.query(INSERT_BRAND, [BRAND_A2, TENANT_B, "Puma", ACTOR])).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT other");
        // Tenant B's brand is invisible to UPDATE: a rename of it (or of everything) touches only A's.
        expect((await client.query(`UPDATE ${B} SET name = 'X' WHERE id = $1`, [BRAND_B])).rowCount).toBe(0);
        expect((await client.query(`UPDATE ${B} SET name = name || '!'`)).rowCount).toBe(1);
        // Moving a brand to another tenant is refused (WITH CHECK).
        await client.query("SAVEPOINT move");
        await expect(client.query(`UPDATE ${B} SET tenant_id = $1 WHERE id = $2`, [TENANT_B, BRAND_A])).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK TO SAVEPOINT move");
        // No DELETE policy.
        expect((await client.query(`DELETE FROM ${B}`)).rowCount).toBe(0);
        // The app role sets its own product's brand; another tenant's brand id fails the FK.
        expect((await client.query(`UPDATE ${P} SET brand_id = $2 WHERE id = $1`, [PRODUCT_A, BRAND_A])).rowCount).toBe(1);
        await client.query("SAVEPOINT cross_tenant");
        await expect(client.query(`UPDATE ${P} SET brand_id = $2 WHERE id = $1`, [PRODUCT_A, BRAND_B])).rejects.toMatchObject({
          code: "23503",
        });
        await client.query("ROLLBACK TO SAVEPOINT cross_tenant");
      });
      const after = await guard().admin.query<{ id: string; name: string }>(`SELECT id, name FROM ${B} ORDER BY name`);
      expect(after.rows).toEqual([
        { id: BRAND_B, name: "Adidas" },
        { id: BRAND_A, name: "Nike" },
      ]);
    } finally {
      await clearBrands();
    }
  });

  it("shows nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    await seedBrands();
    try {
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM ${B}`)).rowCount).toBe(0);
      });
    } finally {
      await clearBrands();
    }
  });
});

describe("0095: UP -> DOWN -> UP", () => {
  const exists = async (table: string): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [table])).rows[0]!.t !== null;
  const hasBrandColumn = async (): Promise<boolean> =>
    (
      await guard().admin.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'brand_id'`,
        [P],
      )
    ).rowCount === 1;
  const OWNER_TABLES = ["tenants", P, B];

  it("refuses while a brand exists, also as a NOSUPERUSER migration owner under an empty GUC, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    await seedBrands();
    await e.admin.query(`UPDATE ${P} SET brand_id = $2 WHERE id = $1`, [PRODUCT_A, BRAND_A]);
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt1334_refuse_owner", tables: OWNER_TABLES, functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await exists(B)).toBe(true);
      expect(await hasBrandColumn()).toBe(true);
      expect((await e.admin.query(`SELECT 1 FROM ${B}`)).rowCount).toBe(2);
      const product = await e.admin.query<{ brand_id: string }>(`SELECT brand_id FROM ${P} WHERE id = $1`, [PRODUCT_A]);
      expect(product.rows).toEqual([{ brand_id: BRAND_A }]);
    } finally {
      await clearBrands();
    }
  });

  it("drops the column and the table once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await exists(B)).toBe(false);
    expect(await hasBrandColumn()).toBe(false);
    await e.admin.query(downSql);
    // The products survived the down.
    expect((await e.admin.query(`SELECT 1 FROM ${P} WHERE id = ANY($1::uuid[])`, [[PRODUCT_A, PRODUCT_A2, PRODUCT_B]])).rowCount).toBe(3);
    await e.admin.query(upSql);
    expect(await exists(B)).toBe(true);
    expect(await hasBrandColumn()).toBe(true);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS with an empty session GUC", async () => {
    if (skip()) return;
    const owner = { role: "rt1334_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
      expect(await runFileWithEmptyGuc(UP_PATH, owner.role)).toBeNull();
    });
    expect(await exists(B)).toBe(true);
    expect(await hasBrandColumn()).toBe(true);
    const fk = await guard().admin.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_tenant_products_brand_tenant'`,
    );
    expect(fk.rows).toEqual([{ convalidated: true }]);
  });
});
