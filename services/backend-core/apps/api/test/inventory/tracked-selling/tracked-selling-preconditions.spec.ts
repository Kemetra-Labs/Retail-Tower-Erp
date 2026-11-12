/**
 * Jira RT-453 — the two Q13 preconditions this issue makes confirmable
 * (`TrackedSellingPrecondition` `identity_anchor` and
 * `tracking_grain_reconciliation`, `inventory/inventory.yaml` 1.14.0-draft)
 * against real Postgres (Testcontainers, every migration, the NOBYPASSRLS
 * `app_test` role).
 *
 *   - `identity_anchor`: met only once EVERY live store of the tenant has a
 *     per-identity anchor;
 *   - `tracking_grain_reconciliation`: met only once every live store also has
 *     a stock reconciliation run completed AFTER its latest identity anchor;
 *   - another tenant's anchors and runs never count; the other preconditions
 *     are unchanged (RT-293 / RT-452 stay unconfirmable).
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { runWithTenantContext } from '@data-pulse-2/db';
import { Pool } from 'pg';

import { TrackedSellingPreconditions } from '../../../src/inventory/tracked-selling/tracked-selling-preconditions';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  ACTOR_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

let env: PgTestEnv | null = null;
let admin: Pool;
const checks = new TrackedSellingPreconditions();

async function unmet(tenantId: string): Promise<string[]> {
  return runWithTenantContext(env!.app, { tenantId, isPlatformAdmin: false }, (c) => checks.unmet(c, tenantId));
}

async function liveStores(tenantId: string): Promise<string[]> {
  const r = await admin.query<{ id: string }>(`SELECT id::text FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL`, [
    tenantId,
  ]);
  return r.rows.map((x) => x.id);
}

/** A completed stock run of the store, finished at `finishedAt`; returns its id. */
async function completedRun(tenantId: string, storeId: string, finishedAt: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'completed', $3::timestamptz, '{}'::jsonb)
     RETURNING id::text`,
    [tenantId, storeId, finishedAt],
  );
  return r.rows[0]!.id;
}

/** The store's product anchor and its per-identity anchor, activated at `at`. */
async function identityAnchor(tenantId: string, storeId: string, actor: string, at: string): Promise<void> {
  const run = await completedRun(tenantId, storeId, at);
  const base = await admin.query<{ id: string }>(
    `INSERT INTO inventory_anchors
       (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id,
        snapshot_read_at, snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES (gen_random_uuid(), $1, $2, (SELECT id FROM stock_locations WHERE store_id = $2 AND kind = 'primary'), 'sellable',
             (SELECT COALESCE(max(generation), 0) + 1 FROM inventory_anchors WHERE store_id = $2), $3,
             $4::timestamptz, $4::timestamptz, 'WH', $4::timestamptz, '{}'::jsonb, $5)
     RETURNING id::text`,
    [tenantId, storeId, run, at, actor],
  );
  await admin.query(
    `INSERT INTO inventory_identity_anchors
       (id, tenant_id, store_id, generation, base_anchor_id, source_run_id, snapshot_read_at, snapshot_recorded_at,
        erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES (gen_random_uuid(), $1, $2, (SELECT COALESCE(max(generation), 0) + 1 FROM inventory_identity_anchors WHERE store_id = $2),
             $3, $4, $5::timestamptz, $5::timestamptz, 'WH', $5::timestamptz, '{}'::jsonb, $6)`,
    [tenantId, storeId, base.rows[0]!.id, run, at, actor],
  );
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-453 Q13 preconditions');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

const skipped = (): boolean => env === null;

describe('identity_anchor and tracking_grain_reconciliation (RT-453)', () => {
  it('are unmet while any live store lacks its identity anchor', async () => {
    if (skipped()) return;
    const stores = await liveStores(TENANT_A);
    expect(stores).toEqual(expect.arrayContaining([STORE_A_X, STORE_A_Y]));
    expect(await unmet(TENANT_A)).toEqual(
      expect.arrayContaining(['identity_anchor', 'tracking_grain_reconciliation']),
    );
    // One store anchored, the other not: still unmet.
    await identityAnchor(TENANT_A, STORE_A_X, ACTOR_A, '2026-11-12T08:00:00Z');
    expect(await unmet(TENANT_A)).toEqual(expect.arrayContaining(['identity_anchor']));
  });

  it('meets identity_anchor once every store is anchored, and tracking grain only after a run completes after it', async () => {
    if (skipped()) return;
    for (const store of await liveStores(TENANT_A)) {
      if (store !== STORE_A_X) await identityAnchor(TENANT_A, store, ACTOR_A, '2026-11-12T08:00:00Z');
    }
    let open = await unmet(TENANT_A);
    expect(open).not.toContain('identity_anchor');
    // The anchors' own source runs finished AT the anchor, not after it.
    expect(open).toContain('tracking_grain_reconciliation');
    for (const store of await liveStores(TENANT_A)) await completedRun(TENANT_A, store, '2026-11-12T09:00:00Z');
    open = await unmet(TENANT_A);
    expect(open).not.toContain('identity_anchor');
    expect(open).not.toContain('tracking_grain_reconciliation');
    // The checks this issue does not own stay unmet here: no ERP import run is seeded yet
    // (RT-1288, own describe below) and RT-452 has no signal (fail closed).
    expect(open).toEqual(expect.arrayContaining(['erp_tracking_import', 'erp_batch_posting_verified']));
  });

  it('asks for a run after the LATEST identity anchor: a re-anchor reopens tracking grain', async () => {
    if (skipped()) return;
    await identityAnchor(TENANT_A, STORE_A_X, ACTOR_A, '2026-11-12T10:00:00Z');
    expect(await unmet(TENANT_A)).toContain('tracking_grain_reconciliation');
    await completedRun(TENANT_A, STORE_A_X, '2026-11-12T11:00:00Z');
    expect(await unmet(TENANT_A)).not.toContain('tracking_grain_reconciliation');
  });

  it("never counts another tenant's anchors and runs", async () => {
    if (skipped()) return;
    expect(await unmet(TENANT_B)).toEqual(expect.arrayContaining(['identity_anchor', 'tracking_grain_reconciliation']));
    await identityAnchor(TENANT_B, STORE_B_X, ACTOR_B, '2026-11-12T08:00:00Z');
    // Tenant B has another live store without an anchor (or, if only one, tracking grain still needs a later run).
    expect(await unmet(TENANT_B)).toContain('tracking_grain_reconciliation');
  });
});

/**
 * Jira RT-1288 — `erp_tracking_import` is met when EVERY live store has an active `stock`
 * warehouse mapping AND at least one completed ERP-origin stock import run (migration 0096) on
 * that mapped warehouse. The contract meaning of the precondition is unchanged.
 */
describe('erp_tracking_import (RT-1288)', () => {
  const NO_STORES_TENANT = '00000000-0000-4000-8000-0000000000e1';
  const WH_X = 'WH-TRACK-X';
  const WH_Y = 'WH-TRACK-Y';
  const mapIds: Record<string, string> = {};

  async function met(tenantId: string): Promise<boolean> {
    return !(await unmet(tenantId)).includes('erp_tracking_import');
  }

  async function map(tenantId: string, storeId: string, ref: string, purpose = 'stock'): Promise<string> {
    const r = await admin.query<{ id: string }>(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, version)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 1) RETURNING id::text`,
      [tenantId, storeId, purpose, ref],
    );
    return r.rows[0]!.id;
  }

  async function run(tenantId: string, storeId: string, mapId: string, ref: string, status: string): Promise<void> {
    await admin.query(
      `INSERT INTO erp_stock_import_runs
         (id, tenant_id, store_id, warehouse_map_id, erpnext_warehouse_ref, status, settle_seconds, overlap_seconds, ended_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 300, 3900, CASE WHEN $5 = 'running' THEN NULL ELSE now() END)`,
      [tenantId, storeId, mapId, ref, status],
    );
  }

  it('is unmet when the tenant has no live store', async () => {
    if (skipped()) return;
    expect(await met(NO_STORES_TENANT)).toBe(false);
  });

  it('is unmet while a live store has no stock warehouse mapping, even if another store is imported', async () => {
    if (skipped()) return;
    mapIds[STORE_A_X] = await map(TENANT_A, STORE_A_X, WH_X);
    await run(TENANT_A, STORE_A_X, mapIds[STORE_A_X]!, WH_X, 'completed');
    expect(await met(TENANT_A)).toBe(false);
  });

  it('is unmet when a store is mapped but its warehouse has no run', async () => {
    if (skipped()) return;
    mapIds[STORE_A_Y] = await map(TENANT_A, STORE_A_Y, WH_Y);
    expect(await met(TENANT_A)).toBe(false);
  });

  it('is unmet while the only runs of a mapped warehouse are running, refused or failed', async () => {
    if (skipped()) return;
    for (const status of ['running', 'refused', 'failed']) {
      await run(TENANT_A, STORE_A_Y, mapIds[STORE_A_Y]!, WH_Y, status);
    }
    expect(await met(TENANT_A)).toBe(false);
  });

  it('ignores a returns-purpose mapping: only the stock mapping counts', async () => {
    if (skipped()) return;
    const returns = await map(TENANT_A, STORE_A_Y, 'WH-RETURNS-Y', 'returns');
    await run(TENANT_A, STORE_A_Y, returns, 'WH-RETURNS-Y', 'completed');
    expect(await met(TENANT_A)).toBe(false);
  });

  it('is met once every live store has a completed run on its mapped stock warehouse', async () => {
    if (skipped()) return;
    await run(TENANT_A, STORE_A_Y, mapIds[STORE_A_Y]!, WH_Y, 'completed');
    expect(await met(TENANT_A)).toBe(true);
    // The other preconditions are not touched by it.
    expect(await unmet(TENANT_A)).toContain('erp_batch_posting_verified');
  });

  it("never counts another tenant's mappings and runs, in either direction", async () => {
    if (skipped()) return;
    // Tenant A is met now (both stores imported). Tenant B has two live stores: one imported,
    // one unmapped, so B stays unmet whatever A's completed runs say.
    expect(await met(TENANT_A)).toBe(true);
    expect(await met(TENANT_B)).toBe(false);
    const mapB = await map(TENANT_B, STORE_B_X, 'WH-TRACK-B');
    await run(TENANT_B, STORE_B_X, mapB, 'WH-TRACK-B', 'completed');
    expect(await met(TENANT_B)).toBe(false);
    // B's completed run does not leak into A: A is still met, and B's own run is not counted for A.
    expect(await met(TENANT_A)).toBe(true);
  });

  it('is unmet again when a store is re-mapped: the old run belongs to the retired mapping', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE erpnext_warehouse_map SET retired_at = now() WHERE id = $1`, [mapIds[STORE_A_X]]);
    await map(TENANT_A, STORE_A_X, 'WH-TRACK-X2');
    expect(await met(TENANT_A)).toBe(false);
  });

  it('is met again once the new stock mapping has its own completed run', async () => {
    if (skipped()) return;
    const active = await admin.query<{ id: string }>(
      `SELECT id::text FROM erpnext_warehouse_map WHERE store_id = $1 AND purpose = 'stock' AND retired_at IS NULL`,
      [STORE_A_X],
    );
    await run(TENANT_A, STORE_A_X, active.rows[0]!.id, 'WH-TRACK-X2', 'completed');
    expect(await met(TENANT_A)).toBe(true);
  });
});
