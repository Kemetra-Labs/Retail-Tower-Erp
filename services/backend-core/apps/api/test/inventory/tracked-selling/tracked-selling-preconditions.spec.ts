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
    // The checks this issue does not own stay unmet (fail closed).
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
