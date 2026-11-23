/**
 * Jira RT-1577 (RT-1511 S2) — the performance gate: `posGetStoreAvailability` for a store of 10,000 sellable SKUs,
 * against spec 013 NFR-2 (a full availability refresh within 30 seconds), measured, not claimed.
 *
 * What it does:
 *   1. Seeds ONE store with 10,000 priced products and a realistic position over `stock_movements`: 12 movements per
 *      product (about 110k rows at the store), 500 tracked products each with an expired and a valid lot, some stock in
 *      `quality_hold`, 1,500 active and 500 lapsed reservations, low-stock levels, and the movements of a second store.
 *      Then `ANALYZE`, the steady state autovacuum reaches in production.
 *   2. Walks the whole snapshot through the real service on the NOBYPASSRLS `app_test` role under
 *      `runWithTenantContext`, so RLS is in force exactly as in production: 20 pages of 500 and 10 pages of 1000, three
 *      times each (the first pass is cold). Prints per-page and total timings.
 *   3. Prints `EXPLAIN (ANALYZE, BUFFERS)` of the two statements of one 500-product page, run on the same client and
 *      transaction as the real call (a superuser plan would bypass RLS and show a plan that never runs).
 *   4. Spot-checks 40 products of the 10,000 against `OnHand.availability` (correctness at scale).
 *
 * The evidence is printed between `RT-1577 PERF EVIDENCE` markers, with the comparison against half of the NFR-2 budget (the
 * server's share, leaving the rest to network and till). The hard assertion is NFR-2 itself, so a loaded shared runner does not
 * fail the lane while a real regression (a plan that scans the whole store per page) still does.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { performance } from 'node:perf_hooks';

import { Pool, type PoolClient } from 'pg';

import { InventoryService } from '../../../src/inventory/inventory.service';
import { PosAvailabilityService } from '../../../src/inventory/availability/pos-availability.service';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import { ACTOR_A, STORE_A_X, STORE_A_Y, TENANT_A, seedCatalogIsolationFixture } from '../../catalog/__support__/isolation-harness';

const SKUS = 10_000;
const BASE = 0x157900000000;
/** Spec 013 NFR-2: a full refresh within 30 seconds. The server's share is reported against half of it. */
const NFR2_MS = 30_000;
const SERVER_BUDGET_MS = NFR2_MS / 2;

let env: PgTestEnv | null = null;
let admin: Pool;
let service: PosAvailabilityService;
let inventory: InventoryService;
const explained: string[] = [];
let capture = false;
/** Every product of the tenant is scanned (the fixture adds a few unpriced ones, which are scanned but not served). */
let scannedProducts = SKUS;

const skipped = (): boolean => env === null;
const productId = (g: number): string => `0a000000-0000-7000-8000-${(BASE + g).toString(16).padStart(12, '0')}`;

/** A pool whose clients also print `EXPLAIN (ANALYZE, BUFFERS)` of the availability statements while `capture` is set. */
function explainingPool(real: Pool): Pool {
  const wrapped = new WeakSet<PoolClient>();
  const wrap = (client: PoolClient): PoolClient => {
    // A pool hands the same client out again: wrap it once, or the wrappers nest and explain each other's EXPLAIN.
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (text: unknown, values?: unknown) => {
      const result = await query(text, values);
      if (capture && typeof text === 'string' && !text.startsWith('EXPLAIN') && /FROM tenant_products tp|ANY\(\$2::uuid\[\]\)/.test(text)) {
        const plan = (await query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values)) as { rows: Array<Record<string, string>> };
        const label = text.includes('FROM tenant_products tp') ? 'PAGE SCAN (catalog port)' : 'PAGE FACTS (inventory)';
        explained.push(`--- ${label}\n${plan.rows.map((r) => r['QUERY PLAN']).join('\n')}`);
      }
      return result;
    };
    return client;
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'connect') return async () => wrap(await target.connect());
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const loc = (store: string): string => `(SELECT id FROM stock_locations WHERE store_id = '${store}' AND kind = 'primary')`;
    const pid = `('0a000000-0000-7000-8000-' || lpad(to_hex(${BASE}::bigint + g), 12, '0'))::uuid`;
    await client.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, default_price, default_currency_code, created_by, updated_by, tracking_mode)
       SELECT ${pid}, $1::uuid, 'perf ' || g, 'standard', 10.00, 'EGP', $2::uuid, $2::uuid, CASE WHEN g % 20 = 0 THEN 'batch' ELSE 'none' END
         FROM generate_series(1, ${SKUS}) g`,
      [TENANT_A, ACTOR_A],
    );
    // 12 movements per untracked product: one big receipt, a quality-hold receipt for every tenth, and sales-like decrements.
    await client.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason, occurred_at,
          created_by, stock_location_id, inventory_status)
       SELECT gen_random_uuid(), $1::uuid, $3::uuid, CASE WHEN q > 0 THEN 'inbound' ELSE 'adjustment' END, q, 'ea', p.pid, 'rt1577 perf seed',
              now() - (m || ' hours')::interval, $2::uuid, ${loc(STORE_A_X)},
              CASE WHEN m = 2 AND p.g % 10 = 0 THEN 'quality_hold' ELSE 'sellable' END
         FROM (SELECT g, ${pid} AS pid FROM generate_series(1, ${SKUS}) g WHERE g % 20 <> 0) p
         CROSS JOIN generate_series(1, 12) m
         CROSS JOIN LATERAL (SELECT CASE WHEN m = 1 THEN 500 WHEN m = 2 AND p.g % 10 = 0 THEN 5 ELSE -((m % 7) + 1) END AS q) x`,
      [TENANT_A, ACTOR_A, STORE_A_X],
    );
    // A second store's movements on the same products: the store predicate must keep them out of the first store's reads.
    await client.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason, occurred_at,
          created_by, stock_location_id, inventory_status)
       SELECT gen_random_uuid(), $1::uuid, $3::uuid, 'inbound', 77, 'ea', ${pid}, 'rt1577 perf seed', now(), $2::uuid, ${loc(STORE_A_Y)}, 'sellable'
         FROM generate_series(1, ${SKUS}) g`,
      [TENANT_A, ACTOR_A, STORE_A_Y],
    );
    // 500 tracked products: an expired lot (7) and a valid lot (5), ERP-born as the tracked path requires.
    await client.query(`CREATE TEMP TABLE perf_lots AS
       SELECT g, ${pid} AS pid, gen_random_uuid() AS expired_id, gen_random_uuid() AS valid_id
         FROM generate_series(1, ${SKUS}) g WHERE g % 20 = 0`);
    await client.query(
      `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date)
       SELECT expired_id, $1::uuid, pid, 'batch', 'PERF-E-' || g, '2000-01-01'::date FROM perf_lots
       UNION ALL SELECT valid_id, $1::uuid, pid, 'batch', 'PERF-V-' || g, '2099-01-01'::date FROM perf_lots`,
      [TENANT_A],
    );
    await client.query(`CREATE TEMP TABLE perf_lot_moves AS
       SELECT gen_random_uuid() AS id, pid, expired_id AS lot, 7 AS q FROM perf_lots
       UNION ALL SELECT gen_random_uuid(), pid, valid_id, 5 FROM perf_lots`);
    await client.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, received_at,
          created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status, tracking_identity_id)
       SELECT id, $1::uuid, $3::uuid, 'inbound', q, 'each', pid, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', $2::uuid, 'erp_external',
              'erp_procurement_receipt', id, ${loc(STORE_A_X)}, 'sellable', lot
         FROM perf_lot_moves`,
      [TENANT_A, ACTOR_A, STORE_A_X],
    );
    await client.query(
      `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at)
       SELECT id, $1::uuid, 'external', '2020-01-01T00:00:00Z' FROM perf_lot_moves`,
      [TENANT_A],
    );
    // Reservations on every fifth untracked product: two thirds of them active, one third lapsed (never swept).
    await client.query(
      `INSERT INTO inventory_reservations
         (id, tenant_id, store_id, stock_location_id, tenant_product_ref, quantity, expires_at, source_type, source_id,
          source_line_id, created_by)
       SELECT gen_random_uuid(), $1::uuid, $3::uuid, ${loc(STORE_A_X)}, ${pid}, 2,
              CASE WHEN g % 3 = 0 THEN '2020-01-01T00:00:00Z'::timestamptz ELSE '2099-01-01T00:00:00Z'::timestamptz END,
              'transfer', gen_random_uuid(), gen_random_uuid(), $2::uuid
         FROM generate_series(1, ${SKUS}) g WHERE g % 5 = 0 AND g % 20 <> 0`,
      [TENANT_A, ACTOR_A, STORE_A_X],
    );
    // Low-stock levels: a tenant default for a third of the products, a store level for every tenth.
    await client.query(
      `INSERT INTO product_stock_levels (id, tenant_id, product_id, store_id, reorder_level, created_by, updated_by)
       SELECT gen_random_uuid(), $1::uuid, ${pid}, NULL, 50, $2::uuid, $2::uuid FROM generate_series(1, ${SKUS}) g WHERE g % 3 = 0`,
      [TENANT_A, ACTOR_A],
    );
    await client.query(
      `INSERT INTO product_stock_levels (id, tenant_id, product_id, store_id, reorder_level, created_by, updated_by)
       SELECT gen_random_uuid(), $1::uuid, ${pid}, $3::uuid, 400, $2::uuid, $2::uuid FROM generate_series(1, ${SKUS}) g WHERE g % 10 = 0`,
      [TENANT_A, ACTOR_A, STORE_A_X],
    );
    await client.query(
      `ANALYZE tenant_products, stock_movements, inventory_reservations, tracking_identities, product_stock_levels,
               store_product_overrides, stock_locations`,
    );
  } finally {
    client.release();
  }
}

interface WalkResult {
  readonly totalMs: number;
  readonly pageMs: readonly number[];
  readonly items: number;
  readonly asOfs: readonly string[];
}

async function walk(limit: number): Promise<WalkResult> {
  const pageMs: number[] = [];
  const asOfs: string[] = [];
  let items = 0;
  let cursor: string | null = null;
  const start = performance.now();
  do {
    const t0 = performance.now();
    const page: Awaited<ReturnType<PosAvailabilityService['getSnapshot']>> = await service.getSnapshot(TENANT_A, STORE_A_X, { limit, cursor });
    pageMs.push(performance.now() - t0);
    asOfs.push(page.asOf);
    items += page.items.length;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { totalMs: performance.now() - start, pageMs, items, asOfs };
}

const stat = (xs: readonly number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
const fmt = (n: number): string => n.toFixed(1);

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1577 availability performance gate');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'perf-a@fixture.invalid', NULL) ON CONFLICT DO NOTHING`, [ACTOR_A]);
  await seed(admin);
  service = new PosAvailabilityService(explainingPool(env.app as unknown as Pool));
  inventory = new InventoryService(env.app as unknown as Pool);
}, 900_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

describe('10,000 sellable SKUs against spec 013 NFR-2', () => {
  it('seeds the intended store', async () => {
    if (skipped()) return;
    const r = await admin.query(
      `SELECT (SELECT count(*) FROM tenant_products WHERE tenant_id = $1 AND default_price IS NOT NULL)::int AS products,
              (SELECT count(*) FROM stock_movements WHERE tenant_id = $1 AND store_id = $2)::int AS movements_at_store,
              (SELECT count(*) FROM stock_movements WHERE tenant_id = $1)::int AS movements_all,
              (SELECT count(*) FROM tenant_products WHERE tenant_id = $1)::int AS products_scanned,
              (SELECT count(*) FROM inventory_reservations WHERE tenant_id = $1 AND state = 'active' AND expires_at > now())::int AS reservations_active,
              (SELECT count(*) FROM inventory_reservations WHERE tenant_id = $1 AND state = 'active' AND expires_at <= now())::int AS reservations_lapsed,
              (SELECT count(*) FROM product_stock_levels WHERE tenant_id = $1)::int AS levels`,
      [TENANT_A, STORE_A_X],
    );
    console.log(`RT-1577 seed (counted in the database): ${JSON.stringify(r.rows[0])}`);
    scannedProducts = r.rows[0].products_scanned;
    expect(r.rows[0].products).toBe(SKUS);
    expect(r.rows[0].movements_at_store).toBeGreaterThan(100_000);
  });

  it('walks the whole snapshot within half of the NFR-2 budget, and prints the evidence', async () => {
    if (skipped()) return;
    const lines: string[] = [
      '=== RT-1577 PERF EVIDENCE ===',
      `products=${SKUS} scanned_by_the_page_walk=${scannedProducts} node=${process.version}`,
    ];
    const medians: Record<number, number> = {};
    const allRuns: Array<{ limit: number; run: WalkResult }> = [];
    for (const limit of [500, 1000]) {
      const runs: WalkResult[] = [];
      for (let i = 0; i < 3; i += 1) runs.push(await walk(limit));
      for (const [i, run] of runs.entries()) {
        allRuns.push({ limit, run });
        lines.push(
          `limit=${limit} run=${i + 1}${i === 0 ? ' (cold)' : ''} pages=${run.pageMs.length} items=${run.items} total_ms=${fmt(run.totalMs)} ` +
            `page_ms min=${fmt(stat(run.pageMs, 0))} p50=${fmt(stat(run.pageMs, 0.5))} p95=${fmt(stat(run.pageMs, 0.95))} max=${fmt(stat(run.pageMs, 1))}`,
        );
      }
      medians[limit] = stat(runs.map((r) => r.totalMs), 0.5);
      lines.push(`limit=${limit} median_total_ms=${fmt(medians[limit]!)} (NFR-2 budget ${NFR2_MS} ms; server budget ${SERVER_BUDGET_MS} ms)`);
    }
    // The plan of page 3: the first two cursors are walked with capture off, then one page with it on.
    const page2 = (await service.getSnapshot(TENANT_A, STORE_A_X, { limit: 500, cursor: null })).nextCursor;
    const page3 = (await service.getSnapshot(TENANT_A, STORE_A_X, { limit: 500, cursor: page2 })).nextCursor;
    capture = true;
    await service.getSnapshot(TENANT_A, STORE_A_X, { limit: 500, cursor: page3 });
    capture = false;
    lines.push('--- EXPLAIN (ANALYZE, BUFFERS) of one 500-product page, page 3 of the walk, as app_test under RLS', ...explained);
    lines.push('=== END RT-1577 PERF EVIDENCE ===');
    // Print first: a missed bound must still leave the plan and the timings behind.
    console.log(lines.join(String.fromCharCode(10)));

    for (const { limit, run } of allRuns) {
      expect(run.items).toBe(SKUS);
      expect(run.pageMs).toHaveLength(Math.ceil(scannedProducts / limit));
    }
    for (const limit of [500, 1000]) expect(medians[limit]!).toBeLessThan(NFR2_MS);
  }, 600_000);

  it('agrees with OnHand.availability for 40 products spread over the 10,000', async () => {
    if (skipped()) return;
    const all: Array<{ productId: string; availableToSell: string }> = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<PosAvailabilityService['getSnapshot']>> = await service.getSnapshot(TENANT_A, STORE_A_X, { limit: 1000, cursor });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    const byId = new Map(all.map((i) => [i.productId, i.availableToSell]));
    // Every 250th product: a mix of plain, tracked (g % 20 = 0), held (g % 10 = 0) and reserved (g % 5 = 0) ones.
    for (let g = 1; g <= SKUS; g += 250) {
      const onHand = await inventory.getOnHand({ tenantId: TENANT_A, storeId: STORE_A_X, productId: productId(g) });
      expect(byId.get(productId(g))).toBe(onHand.availability.availableToSell);
    }
    for (const g of [20, 40, 100, 5, 15, 10, 30]) {
      const onHand = await inventory.getOnHand({ tenantId: TENANT_A, storeId: STORE_A_X, productId: productId(g) });
      expect(byId.get(productId(g))).toBe(onHand.availability.availableToSell);
    }
    // A tracked product: 7 (expired lot) + 5 (valid lot) sellable, 7 expired: ATS 5.
    expect(byId.get(productId(20))).toBe('5.0000');
  }, 300_000);
});
