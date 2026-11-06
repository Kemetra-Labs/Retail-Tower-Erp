/**
 * 0082-0083 - the product-history indexes behind the Tracking Profile lock
 * probe (Jira RT-459; [GATED] approval: Jira RT-459 comment 15729). Read by
 * tracking-profile.service.ts hasHistory (profile GET and PUT) and the 0045
 * trigger tenant_products_guard_tracking_profile, both of which ask
 *   EXISTS (stock_movements WHERE tenant_product_ref = $1)
 *   OR EXISTS (sale_lines WHERE tenant_product_ref = $1)
 * with no tenant predicate: RLS supplies tenant_id.
 *
 * Applies every migration before 0082 against a real Postgres, seeds two
 * tenants with many products, sales and movements over several stores, then
 * applies 0082-0083 exactly as the runner does (one `query()` per file), and
 * proves:
 *   - each file is a single CONCURRENTLY statement with no transaction control;
 *   - each index is valid, partial on tenant_product_ref IS NOT NULL, with the
 *     RT-459 columns;
 *   - as the non-superuser app role with app.current_tenant set (so RLS, not
 *     the query, supplies the tenant), the probe is served by both new indexes
 *     with tenant_id and tenant_product_ref in the Index Cond, for a custom
 *     plan (the service) and a generic plan (the plpgsql trigger);
 *   - the probe answers exactly as before the build, including another
 *     tenant's product reading false, and the trigger still locks;
 *   - each down drops only its own index, keeps every row, and round-trips.
 *
 * A superuser bypasses RLS, so a plan read as the superuser would prove
 * nothing about the tenant equality; every plan here is read as the app role.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  expectSingleConcurrentStatement,
  indexState as readIndexState,
  migrationPath,
} from "../_helpers/concurrent-index-migration";
import { withTenant } from "../_helpers/migration-sql";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const FIRST_NAME = "0082_sale_lines_tenant_product_idx.sql";

const SALE_INDEX = "idx_sale_lines_tenant_product";
const MOVEMENT_INDEX = "idx_stock_movements_tenant_product";

/** The two RT-459 migrations, in order. */
const MIGRATIONS = [
  { id: "0082_sale_lines_tenant_product_idx", table: "sale_lines", index: SALE_INDEX },
  { id: "0083_stock_movements_tenant_product_idx", table: "stock_movements", index: MOVEMENT_INDEX },
] as const;

/** Indexes that existed before and must survive both downs. */
const KEPT_INDEXES = ["idx_sale_lines_tenant_store", "idx_stock_movements_tenant_store_product"];

const up = (id: string): string => migrationPath(id, "up");
const down = (id: string): string => migrationPath(id, "down");

const TENANT = "0a000000-0000-7000-8000-000000459001";
const TENANT_2 = "0a000000-0000-7000-8000-000000459002";
const STORE_A = "0a000000-0000-7000-8000-000000459003";
const STORE_B = "0a000000-0000-7000-8000-000000459004";
const STORE_C = "0a000000-0000-7000-8000-000000459005";
const STORE_T2 = "0a000000-0000-7000-8000-000000459006";
const ACTOR = "0a000000-0000-7000-8000-000000459007";
/** A product with movements only. */
const PRODUCT_MOVED = "0a000000-0000-7000-8000-000000459008";
/** A product with a sale line only. */
const PRODUCT_SOLD = "0a000000-0000-7000-8000-000000459009";
/** A product with no history: the case the index exists for. */
const PRODUCT_EMPTY = "0a000000-0000-7000-8000-00000045900a";
/** TENANT_2's product, with both kinds of history in TENANT_2. */
const PRODUCT_T2 = "0a000000-0000-7000-8000-00000045900b";
const SALE_SOLD = "0a000000-0000-7000-8000-00000045900c";
const SALE_T2 = "0a000000-0000-7000-8000-00000045900d";

/** Bulk products per tenant: many distinct values keep the per-product estimate small. */
const BULK_PRODUCTS = 1500;
const BULK_SALES = 1500;

/** The probe, byte-for-byte as tracking-profile.service.ts hasHistory sends it. */
const PROBE_SQL = `SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_product_ref = $1)
           OR EXISTS (SELECT 1 FROM sale_lines WHERE tenant_product_ref = $1) AS locked`;

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const read = (path: string): string => readFileSync(path, "utf8");
const skip = (): boolean => env === null;

async function applyBefore0082(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(FIRST_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(read(resolve(DRIZZLE_DIR, name)));
  }
  await ensureAppRole(pgEnv);
}

async function seedTenant(tenantId: string, stores: readonly string[], tag: string): Promise<void> {
  const admin = pg().admin;
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     SELECT gen_random_uuid(), $1, 'RT-459 bulk ' || g, 'standard', $2, $2
       FROM generate_series(1, $3) g`,
    [tenantId, ACTOR, BULK_PRODUCTS],
  );
  // Two movements per bulk product in every store, plus ad-hoc (no product) rows.
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, occurred_at, created_by, stock_location_id, inventory_status)
     SELECT gen_random_uuid(), p.tenant_id, l.store_id, 'inbound', 1, 'ea', p.id,
            now() - (random() * interval '90 days'), $2, l.id, 'sellable'
       FROM tenant_products p
       JOIN stock_locations l ON l.tenant_id = p.tenant_id AND l.kind = 'primary'
       CROSS JOIN generate_series(1, 2) g
      WHERE p.tenant_id = $1 AND p.name LIKE 'RT-459 bulk %'`,
    [tenantId, ACTOR],
  );
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, occurred_at, created_by, stock_location_id, inventory_status)
     SELECT gen_random_uuid(), l.tenant_id, l.store_id, 'inbound', 1, 'ea', NULL,
            now() - (random() * interval '90 days'), $2, l.id, 'sellable'
       FROM stock_locations l CROSS JOIN generate_series(1, 1000) g
      WHERE l.tenant_id = $1 AND l.kind = 'primary'`,
    [tenantId, ACTOR],
  );
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     SELECT gen_random_uuid(), $1, ($2::uuid[])[1 + g % array_length($2::uuid[], 1)], 'EGP', 80,
            '2026-10-01T10:00:00Z', '2026-10-01', 'pos-1', $3 || '-' || g, $4, $5
       FROM generate_series(1, $6) g`,
    [tenantId, [...stores], `rt459-${tag}`, "c".repeat(64), ACTOR, BULK_SALES],
  );
  // Eight lines per sale: one ad-hoc, seven naming a random bulk product.
  await admin.query(
    `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price,
                             currency_code, quantity, line_amount, unit, tenant_product_ref)
     SELECT gen_random_uuid(), s.id, s.tenant_id, s.store_id, 'Line', 10, 'EGP', 1, 10, 'pcs',
            CASE WHEN g = 1 THEN NULL
                 ELSE p.ids[1 + floor(random() * array_length(p.ids, 1))::int] END
       FROM sales s
       CROSS JOIN generate_series(1, 8) g
       CROSS JOIN (SELECT array_agg(id) AS ids FROM tenant_products
                    WHERE tenant_id = $1 AND name LIKE 'RT-459 bulk %') p
      WHERE s.tenant_id = $1`,
    [tenantId],
  );
}

async function seedSpecial(): Promise<void> {
  const admin = pg().admin;
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $5, 'RT-459 moved', 'standard', $6, $6),
            ($2, $5, 'RT-459 sold', 'standard', $6, $6),
            ($3, $5, 'RT-459 empty', 'standard', $6, $6),
            ($4, $7, 'RT-459 T2', 'standard', $6, $6)`,
    [PRODUCT_MOVED, PRODUCT_SOLD, PRODUCT_EMPTY, PRODUCT_T2, TENANT, ACTOR, TENANT_2],
  );
  for (const [tenantId, storeId, productId] of [
    [TENANT, STORE_B, PRODUCT_MOVED],
    [TENANT_2, STORE_T2, PRODUCT_T2],
  ] as const) {
    await admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
          tenant_product_ref, occurred_at, created_by, stock_location_id, inventory_status)
       SELECT gen_random_uuid(), $1, $2, 'inbound', 1, 'ea', $3::uuid, now(), $4, l.id, 'sellable'
         FROM stock_locations l CROSS JOIN generate_series(1, 3) g
        WHERE l.store_id = $2 AND l.kind = 'primary'`,
      [tenantId, storeId, productId, ACTOR],
    );
  }
  for (const [saleId, tenantId, storeId, productId] of [
    [SALE_SOLD, TENANT, STORE_C, PRODUCT_SOLD],
    [SALE_T2, TENANT_2, STORE_T2, PRODUCT_T2],
  ] as const) {
    await admin.query(
      `INSERT INTO sales
         (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
          business_date, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, 'EGP', 10, '2026-10-01T10:00:00Z', '2026-10-01',
               'pos-1', $4, $5, $6)`,
      [saleId, tenantId, storeId, `rt459-special-${saleId}`, "c".repeat(64), ACTOR],
    );
    await admin.query(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price,
                               currency_code, quantity, line_amount, unit, tenant_product_ref)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Tea', 10, 'EGP', 1, 10, 'pcs', $4)`,
      [saleId, tenantId, storeId, productId],
    );
  }
}

/** The probe's answer for a product, as the app role inside `tenantId`. */
async function probe(tenantId: string, productId: string): Promise<boolean> {
  return withTenant(pg().app, tenantId, async (c) => {
    const r = await c.query<{ locked: boolean }>(PROBE_SQL, [productId]);
    return r.rows[0]?.locked === true;
  });
}

type PlanNode = {
  readonly "Node Type": string;
  readonly "Index Name"?: string;
  readonly "Index Cond"?: string;
  readonly Plans?: readonly PlanNode[];
};

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

async function planNodes(client: PoolClient, explain: string, params: unknown[]): Promise<PlanNode[]> {
  const r = await client.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(explain, params);
  return flatten(r.rows[0]!["QUERY PLAN"][0].Plan);
}

/** The service's custom plan for `productId`, as the app role inside TENANT. */
const customPlan = (productId: string): Promise<PlanNode[]> =>
  withTenant(pg().app, TENANT, (c) => planNodes(c, `EXPLAIN (FORMAT JSON) ${PROBE_SQL}`, [productId]));

/** The generic plan ($1 unknown at plan time), the shape a plpgsql trigger reuses. */
const genericPlan = (): Promise<PlanNode[]> =>
  withTenant(pg().app, TENANT, (c) => planNodes(c, `EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${PROBE_SQL}`, []));

/** Both RT-459 indexes serve the plan, each matched on tenant_id and the product. */
function expectServedByBothIndexes(nodes: readonly PlanNode[]): void {
  for (const index of [SALE_INDEX, MOVEMENT_INDEX]) {
    const node = nodes.find((n) => n["Index Name"] === index);
    expect(node).toBeDefined();
    expect(node?.["Index Cond"]).toContain("tenant_id");
    expect(node?.["Index Cond"]).toContain("tenant_product_ref");
  }
}

const indexState = (name: string) => readIndexState(pg().admin, name);

async function countRows(table: string): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return r.rows[0]!.n;
}

/** [tenant, product, expected answer]: the probe's answers, read before and after the build. */
const CASES = [
  [TENANT, PRODUCT_MOVED, true],
  [TENANT, PRODUCT_SOLD, true],
  [TENANT, PRODUCT_EMPTY, false],
  [TENANT, PRODUCT_T2, false],
  [TENANT_2, PRODUCT_T2, true],
] as const;
const answersBefore: boolean[] = [];

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0082-product-history-indexes.spec] Docker NOT AVAILABLE - skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0082(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES
       ($1, 'RT-459 tenant', 'rt459-tenant'), ($2, 'RT-459 tenant 2', 'rt459-tenant-2')`,
    [TENANT, TENANT_2],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $5, 'rt459a', 'RT-459 A'), ($2, $5, 'rt459b', 'RT-459 B'),
       ($3, $5, 'rt459c', 'RT-459 C'), ($4, $6, 'rt459t2', 'RT-459 T2')`,
    [STORE_A, STORE_B, STORE_C, STORE_T2, TENANT, TENANT_2],
  );
  // Rows existing BEFORE the build (the upgrade path).
  await seedTenant(TENANT, [STORE_A, STORE_B, STORE_C], "t1");
  await seedTenant(TENANT_2, [STORE_T2], "t2");
  await seedSpecial();
  await env.admin.query("ANALYZE sale_lines");
  await env.admin.query("ANALYZE stock_movements");

  for (const [tenantId, productId] of CASES) answersBefore.push(await probe(tenantId, productId));
  // One query() per file, exactly as the runner sends it.
  for (const m of MIGRATIONS) await env.admin.query(read(up(m.id)));
  await env.admin.query("ANALYZE sale_lines");
  await env.admin.query("ANALYZE stock_movements");
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0082-0083 - single CONCURRENTLY statements", () => {
  it.each(MIGRATIONS.map((m) => [m.id]))(
    "%s up and down are one statement with no transaction control",
    (id) => {
      [up(id), down(id)].forEach(expectSingleConcurrentStatement);
    },
  );
});

describe("0082-0083 - the two RT-459 indexes", () => {
  it.each(MIGRATIONS.map((m) => [m.index, m.table]))(
    "%s is valid, partial, with the RT-459 columns",
    async (index, table) => {
      if (skip()) return;
      expect(await indexState(index)).toEqual({
        valid: true,
        def: `CREATE INDEX ${index} ON public.${table} USING btree (tenant_id, tenant_product_ref) WHERE (tenant_product_ref IS NOT NULL)`,
      });
    },
  );

  it("the seeded probe answers are what the fixtures say (before the build)", () => {
    if (skip()) return;
    expect(answersBefore).toEqual(CASES.map(([, , expected]) => expected));
  });

  it.each([
    ["no history", PRODUCT_EMPTY],
    ["movements only", PRODUCT_MOVED],
    ["a sale line only", PRODUCT_SOLD],
  ])(
    "as the app role under tenant RLS, the service probe for a product with %s uses both indexes",
    async (_label, productId) => {
      if (skip()) return;
      expectServedByBothIndexes(await customPlan(productId));
    },
  );

  it("the generic plan (the trigger's) uses both indexes too", async () => {
    if (skip()) return;
    expectServedByBothIndexes(await genericPlan());
  });

  it("the probe answers exactly as before the build, and RLS still isolates tenants", async () => {
    if (skip()) return;
    const after: boolean[] = [];
    for (const [tenantId, productId] of CASES) after.push(await probe(tenantId, productId));
    expect(after).toEqual(answersBefore);
  });

  it("the 0045 trigger still locks a product with history and lets a history-free one change", async () => {
    if (skip()) return;
    for (const product of [PRODUCT_MOVED, PRODUCT_SOLD]) {
      await expect(
        withTenant(pg().app, TENANT, (c) =>
          c.query(`UPDATE tenant_products SET tracking_mode = 'batch' WHERE id = $1`, [product]),
        ),
      ).rejects.toThrow(/tracking profile is locked/);
    }
    const r = await withTenant(pg().app, TENANT, (c) =>
      c.query(`UPDATE tenant_products SET tracking_mode = 'batch' WHERE id = $1`, [PRODUCT_EMPTY]),
    );
    expect(r.rowCount).toBe(1);
  });
});

describe("0082-0083 - down -> up round-trip", () => {
  it("each down drops only its own index, keeps every row, and up re-applies cleanly", async () => {
    if (skip()) return;
    const tables = ["sale_lines", "stock_movements"] as const;
    const before = await Promise.all(tables.map(countRows));
    for (const [i, m] of [...MIGRATIONS].reverse().entries()) {
      await pg().admin.query(read(down(m.id)));
      expect(await indexState(m.index)).toBeNull();
      for (const earlier of MIGRATIONS.slice(0, MIGRATIONS.length - 1 - i)) {
        expect((await indexState(earlier.index))?.valid).toBe(true);
      }
    }
    for (const kept of KEPT_INDEXES) expect((await indexState(kept))?.valid).toBe(true);
    expect(await Promise.all(tables.map(countRows))).toEqual(before);
    for (const m of MIGRATIONS) await pg().admin.query(read(up(m.id)));
    for (const m of MIGRATIONS) expect((await indexState(m.index))?.valid).toBe(true);
  });
});
