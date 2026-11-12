/**
 * RT-1334 (RT-286 spec 048 slice S1): `0098_tenant_products_brand_idx`, the
 * brand index of `tenant_products`, built CONCURRENTLY.
 *
 * Applies every migration before 0098 (0097 included) against a real
 * PostgreSQL 16, seeds two tenants' products (most with no brand), applies
 * 0098 exactly as the runner does (one `query()` per file), and proves:
 *   - up and down are each a single CONCURRENTLY statement with no transaction
 *     control, so the runner never wraps the build in a transaction block;
 *   - the index is valid, partial on `brand_id IS NOT NULL`, over
 *     (tenant_id, brand_id), and leaves products without a brand out;
 *   - as the app role under tenant RLS, the Console list's brand filter shape
 *     (`tenant_id = $1 AND brand_id = $2`) is served by the index (printed plan
 *     as evidence) and returns only that tenant's brand's products;
 *   - the down drops only this index, keeps every product row and the 0097
 *     column and FK, and round-trips with up.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp } from "../_helpers/migration-spec";
import { sqlStatements } from "../_helpers/migration-sql";
import { expectSingleConcurrentStatement, indexState, migrationPath } from "../_helpers/concurrent-index-migration";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const ID = "0098_tenant_products_brand_idx";
const INDEX = "idx_tenant_products_tenant_brand";
const UP = migrationPath(ID, "up");
const DOWN = migrationPath(ID, "down");

const id = (n: string): string => `09800000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const ACTOR = id("0a0a1");
const BRAND_A = id("0a0b1");
const BRAND_B = id("0b0b1");
const PRODUCTS_PER_TENANT = 4_000;
/** Products of BRAND_A in tenant A (every 100th). */
const BRANDED_A = PRODUCTS_PER_TENANT / 100;

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

async function seedTenant(tenantId: string, slug: string, brandId: string): Promise<void> {
  const a = guard().admin;
  await a.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, $2, $2, 'EGP')`, [tenantId, slug]);
  await a.query(`INSERT INTO tenant_product_brands (id, tenant_id, name, created_by) VALUES ($1, $2, 'Nile', $3)`, [
    brandId,
    tenantId,
    ACTOR,
  ]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, brand_id)
     SELECT gen_random_uuid(), $1, $2 || ' product ' || g, 'std', $3, $3,
            CASE WHEN g % 100 = 0 THEN $4::uuid END
       FROM generate_series(1, $5) g`,
    [tenantId, slug, ACTOR, brandId, PRODUCTS_PER_TENANT],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0098-tenant-products-brand-idx.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  // Setup errors from here on are real failures: never skipped.
  await applyMigrationsBefore(env, DRIZZLE_DIR, `${ID}.sql`);
  await seedTenant(TENANT_A, "brx-a", BRAND_A);
  await seedTenant(TENANT_B, "brx-b", BRAND_B);
  await env.admin.query("ANALYZE tenant_products");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0098: file shape", () => {
  it("up and down are each one CONCURRENTLY statement with no transaction control", () => {
    expectSingleConcurrentStatement(UP);
    expectSingleConcurrentStatement(DOWN);
    // No IF NOT EXISTS on the build: an invalid leftover must fail loudly, never be skipped.
    expect(sqlStatements(UP)[0]).not.toMatch(/IF NOT EXISTS/);
  });
});

describe("0098: the index", () => {
  it("does not exist before 0098, and is valid, partial and on (tenant_id, brand_id) after it", async () => {
    if (skip()) return;
    const e = guard();
    expect(await indexState(e.admin, INDEX)).toBeNull();
    await e.admin.query(readFileSync(UP, "utf8"));
    const state = await indexState(e.admin, INDEX);
    expect(state).toEqual({
      valid: true,
      def: `CREATE INDEX ${INDEX} ON public.tenant_products USING btree (tenant_id, brand_id) WHERE (brand_id IS NOT NULL)`,
    });
    await e.admin.query("ANALYZE tenant_products");
  });

  it("serves the brand filter as the app role under tenant RLS, and returns only that tenant's brand", async () => {
    if (skip()) return;
    const e = guard();
    await asApp(e, TENANT_A, async (client) => {
      const sql = `SELECT id FROM tenant_products WHERE tenant_id = $1::uuid AND brand_id = $2::uuid`;
      const plan = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, [TENANT_A, BRAND_A]);
      const text = JSON.stringify(plan.rows[0]!["QUERY PLAN"]);
      // eslint-disable-next-line no-console
      console.log(`[0098] brand filter plan: ${text}`);
      expect(text).toContain(INDEX);
      expect((await client.query(sql, [TENANT_A, BRAND_A])).rowCount).toBe(BRANDED_A);
      // Another tenant's brand is invisible under RLS, index or not.
      expect((await client.query(sql, [TENANT_B, BRAND_B])).rowCount).toBe(0);
    });
  });
});

describe("0098: down and round trip", () => {
  it("drops only its index, keeps every product, the brand column and the 0097 FK, and is rerunnable", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(readFileSync(DOWN, "utf8"));
    await e.admin.query(readFileSync(DOWN, "utf8"));
    expect(await indexState(e.admin, INDEX)).toBeNull();
    const n = await e.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM tenant_products`);
    expect(n.rows[0]!.n).toBe(String(2 * PRODUCTS_PER_TENANT));
    const fk = await e.admin.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fk_tenant_products_brand_tenant' AND convalidated`);
    expect(fk.rowCount).toBe(1);
    await e.admin.query(readFileSync(UP, "utf8"));
    expect((await indexState(e.admin, INDEX))?.valid).toBe(true);
  });
});
