/**
 * Jira RT-453 — the four `tracking_consistency` safety findings (RT-50 G7-12,
 * decision 956; reserved by RT-1081, critical per OD-8) against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 * Contract: `inventory/inventory.yaml` 1.14.0-draft `TrackingConsistencyFinding`.
 *
 *   - `identity_without_edge_map`: one per identity, tenant-wide;
 *   - `untracked_effect_on_tracked_product`: one per product × store × unit,
 *     for effects since the store's identity anchor (tracked activation);
 *   - `serial_position_out_of_range`: one per identity × store × unit outside {0, 1};
 *   - `profile_erp_flag_mismatch`: one per product whose profile disagrees
 *     with the ERP flags of a store's latest complete Bin snapshot; an entry
 *     without tracking evidence (an older Connector) is not compared.
 *
 * Scope: a store_manager sees only the store-scoped checks in its stores, never
 * a tenant-wide one; another tenant's data never appears. Every body conforms
 * to the contract. Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';

import type { MembershipRepository } from '../../../src/context/membership.repository';
import type { ResolvedContext } from '../../../src/context/types';
import {
  SafetyFindingsService,
  type TrackingConsistencyFinding,
} from '../../../src/inventory/safety/safety-findings.service';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { allContracts, contractDocument } from '../../_helpers/openapi-contract';
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

// `0453` / `c5` mnemonic, hex-safe.
const P_BATCH = '0a000000-0000-7000-8000-00000453c501';
const P_SERIAL = '0a000000-0000-7000-8000-00000453c502';
const P_NONE = '0a000000-0000-7000-8000-00000453c503';
const P_EXPIRY = '0a000000-0000-7000-8000-00000453c504';
const P_UNKNOWN_EVIDENCE = '0a000000-0000-7000-8000-00000453c505';
const P_B = '0b000000-0000-7000-8000-00000453c501';

let env: PgTestEnv | null = null;
let admin: Pool;
let findings: SafetyFindingsService;
let role = 'owner';
let seq = 0;
const locations: Record<string, string> = {};

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function next(): string {
  seq += 1;
  return String(seq).padStart(6, '0');
}

async function identity(product: string, kind: 'batch' | 'serial', mapped: boolean, tenantId = TENANT_A): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code)
     VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [tenantId, product, kind, `TC-${next()}`],
  );
  const id = r.rows[0]!.id;
  if (mapped) {
    await admin.query(
      `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref)
       SELECT tenant_id, id, kind, code FROM tracking_identities WHERE id = $1`,
      [id],
    );
  }
  return id;
}

async function effect(o: {
  product: string;
  storeId: string;
  quantity: string;
  identity: string | null;
  unit?: string;
  status?: string;
  tenantId?: string;
  /** Default: now (after the stores' identity anchors). */
  receivedAt?: string;
}): Promise<void> {
  const tenantId = o.tenantId ?? TENANT_A;
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, received_at, created_by, stock_location_id, inventory_status, tracking_identity_id)
     VALUES (gen_random_uuid(), $1, $2, 'adjustment', $3::numeric, $4, $5, 'rt453 fixture', now(),
             COALESCE($10::timestamptz, now()), $6, $7, $8, $9)`,
    [
      tenantId,
      o.storeId,
      o.quantity,
      o.unit ?? 'ea',
      o.product,
      tenantId === TENANT_A ? ACTOR_A : ACTOR_B,
      locations[o.storeId],
      o.status ?? 'sellable',
      o.identity,
      o.receivedAt ?? null,
    ],
  );
}

/** The store's product anchor and per-identity anchor (tracked activation), activated at `at`. */
async function identityAnchor(tenantId: string, storeId: string, at: string): Promise<void> {
  const actor = tenantId === TENANT_A ? ACTOR_A : ACTOR_B;
  const run = await admin.query<{ id: string }>(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'completed', $3::timestamptz, '{}'::jsonb) RETURNING id::text`,
    [tenantId, storeId, at],
  );
  const base = await admin.query<{ id: string }>(
    `INSERT INTO inventory_anchors
       (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id,
        snapshot_read_at, snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 'sellable', 1, $4, $5::timestamptz, $5::timestamptz, 'WH', $5::timestamptz,
             '{}'::jsonb, $6) RETURNING id::text`,
    [tenantId, storeId, locations[storeId], run.rows[0]!.id, at, actor],
  );
  await admin.query(
    `INSERT INTO inventory_identity_anchors
       (id, tenant_id, store_id, generation, base_anchor_id, source_run_id, snapshot_read_at, snapshot_recorded_at,
        erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5::timestamptz, $5::timestamptz, 'WH', $5::timestamptz, '{}'::jsonb, $6)`,
    [tenantId, storeId, base.rows[0]!.id, run.rows[0]!.id, at, actor],
  );
}

/** When the stores took their identity anchors in this file (an hour ago). */
const ANCHORED_AT = new Date(Date.now() - 3_600_000).toISOString();

/** A complete Bin report on a stock run of the store (entries carry the resolved product, as recorded). */
async function snapshot(
  storeId: string,
  entries: Array<{ product: string; tracking?: { hasBatchNo: boolean; hasSerialNo: boolean; hasExpiryDate: boolean } }>,
  opts: { tenantId?: string; recordedAt?: string } = {},
): Promise<void> {
  const recordedAt = opts.recordedAt ?? new Date().toISOString();
  const report = {
    readAt: recordedAt,
    recordedAt,
    complete: true,
    entries: entries.map((e, i) => ({
      erpnextItemRef: `ITEM-${i}`,
      tenant_product_ref: e.product,
      quantity: '1',
      stockUom: 'Nos',
      ...(e.tracking === undefined ? {} : { tracking: e.tracking }),
    })),
  };
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'completed', now(), $3::jsonb)`,
    [opts.tenantId ?? TENANT_A, storeId, JSON.stringify({ bin_view_report: report })],
  );
}

function ctx(over: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    userId: ACTOR_A,
    tenantId: TENANT_A,
    storeId: null,
    isPlatformAdmin: false,
    source: 'session',
    storeAccess: { kind: 'all' },
    ...over,
  };
}

async function consistency(context: ResolvedContext = ctx(), tenantId = TENANT_A): Promise<TrackingConsistencyFinding[]> {
  const body = await findings.listFindings({ tenantId, context });
  const validate = ajv.getSchema('inventory#/components/schemas/InventorySafetyFindingList');
  if (!validate) throw new Error('ajv cannot resolve InventorySafetyFindingList');
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
  return body.findings.filter((f): f is TrackingConsistencyFinding => f.kind === 'tracking_consistency');
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('tracking-consistency-findings.spec');
  if (!env) return;
  admin = env.admin as unknown as Pool;
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'tc-a@fixture.invalid', NULL), ($2, 'tc-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required) VALUES
       ($1, $7, 'TC batch', 'standard', $9, $9, 'batch', false),
       ($2, $7, 'TC serial', 'standard', $9, $9, 'serial', false),
       ($3, $7, 'TC none', 'standard', $9, $9, 'none', false),
       ($4, $7, 'TC expiry', 'standard', $9, $9, 'batch', true),
       ($5, $7, 'TC unknown evidence', 'standard', $9, $9, 'batch', false),
       ($6, $8, 'TC batch B', 'standard', $10, $10, 'batch', false)`,
    [P_BATCH, P_SERIAL, P_NONE, P_EXPIRY, P_UNKNOWN_EVIDENCE, P_B, TENANT_A, TENANT_B, ACTOR_A, ACTOR_B],
  );
  const primaries = await admin.query<{ store_id: string; id: string }>(
    `SELECT store_id::text, id::text FROM stock_locations WHERE kind = 'primary' AND store_id = ANY($1::uuid[])`,
    [[STORE_A_X, STORE_A_Y, STORE_B_X]],
  );
  for (const row of primaries.rows) locations[row.store_id] = row.id;
  for (const [tenant, store] of [
    [TENANT_A, STORE_A_X],
    [TENANT_A, STORE_A_Y],
    [TENANT_B, STORE_B_X],
  ] as const) {
    await identityAnchor(tenant, store, ANCHORED_AT);
  }
  const memberships = { findRoleCodeForUserInTenant: async () => role } as unknown as MembershipRepository;
  findings = new SafetyFindingsService(env.app as unknown as Pool, memberships);
  ajv.addSchema(contractDocument(allContracts(), 'inventory') as object, 'inventory');
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skipped = (): boolean => env === null;

describe('tracking_consistency findings (RT-453, G7-12 / 956)', () => {
  it('emits nothing while the records agree', async () => {
    if (skipped()) return;
    const mapped = await identity(P_BATCH, 'batch', true);
    await effect({ product: P_BATCH, storeId: STORE_A_X, quantity: '3', identity: mapped });
    await effect({ product: P_NONE, storeId: STORE_A_X, quantity: '3', identity: null });
    expect(await consistency()).toEqual([]);
  });

  it('identity_without_edge_map: one per identity, tenant-wide', async () => {
    if (skipped()) return;
    const orphan = await identity(P_BATCH, 'batch', false);
    const found = (await consistency()).filter((f) => f.check === 'identity_without_edge_map');
    expect(found).toEqual([
      {
        kind: 'tracking_consistency',
        severity: 'critical',
        check: 'identity_without_edge_map',
        tenantProductRef: P_BATCH,
        trackingIdentityId: orphan,
        storeId: null,
        stockingUnit: null,
      },
    ]);
    await admin.query(
      `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref)
       SELECT tenant_id, id, kind, code FROM tracking_identities WHERE id = $1`,
      [orphan],
    );
  });

  it('untracked_effect_on_tracked_product: one per product, store and unit, however many effects', async () => {
    if (skipped()) return;
    // Before the store's identity anchor a tracked product is sold untracked by design (OD-T4): not a finding.
    await effect({
      product: P_EXPIRY,
      storeId: STORE_A_X,
      quantity: '-1',
      identity: null,
      receivedAt: new Date(Date.parse(ANCHORED_AT) - 60_000).toISOString(),
    });
    await effect({ product: P_BATCH, storeId: STORE_A_X, quantity: '1', identity: null });
    await effect({ product: P_BATCH, storeId: STORE_A_X, quantity: '2', identity: null });
    await effect({ product: P_BATCH, storeId: STORE_A_Y, quantity: '1', identity: null, unit: 'box' });
    const found = (await consistency()).filter((f) => f.check === 'untracked_effect_on_tracked_product');
    expect(found.map((f) => [f.tenantProductRef, f.storeId, f.stockingUnit, f.trackingIdentityId])).toEqual(
      [
        [P_BATCH, STORE_A_X, 'ea', null],
        [P_BATCH, STORE_A_Y, 'box', null],
      ].sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
    );
  });

  it('serial_position_out_of_range: a serial identity outside {0, 1} at a store, summed over statuses', async () => {
    if (skipped()) return;
    const ok = await identity(P_SERIAL, 'serial', true);
    await effect({ product: P_SERIAL, storeId: STORE_A_X, quantity: '1', identity: ok });
    const two = await identity(P_SERIAL, 'serial', true);
    await effect({ product: P_SERIAL, storeId: STORE_A_X, quantity: '1', identity: two });
    await effect({ product: P_SERIAL, storeId: STORE_A_X, quantity: '1', identity: two, status: 'return_inspection' });
    const negative = await identity(P_SERIAL, 'serial', true);
    await effect({ product: P_SERIAL, storeId: STORE_A_Y, quantity: '-1', identity: negative });
    const found = (await consistency()).filter((f) => f.check === 'serial_position_out_of_range');
    expect(found.map((f) => [f.trackingIdentityId, f.storeId]).sort()).toEqual(
      [
        [two, STORE_A_X],
        [negative, STORE_A_Y],
      ].sort(),
    );
  });

  it("profile_erp_flag_mismatch: per product, from each store's latest complete snapshot; unknown evidence is not compared", async () => {
    if (skipped()) return;
    // An older snapshot disagreed for P_NONE; the store's latest one agrees.
    await snapshot(STORE_A_X, [{ product: P_NONE, tracking: { hasBatchNo: true, hasSerialNo: false, hasExpiryDate: false } }], {
      recordedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await snapshot(STORE_A_X, [
      { product: P_NONE, tracking: { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false } },
      { product: P_BATCH, tracking: { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false } },
      { product: P_EXPIRY, tracking: { hasBatchNo: true, hasSerialNo: false, hasExpiryDate: false } },
      { product: P_UNKNOWN_EVIDENCE },
    ]);
    // The other store reports the serial product as batch-tracked.
    await snapshot(STORE_A_Y, [{ product: P_SERIAL, tracking: { hasBatchNo: true, hasSerialNo: false, hasExpiryDate: false } }]);
    const found = (await consistency()).filter((f) => f.check === 'profile_erp_flag_mismatch');
    expect(found.map((f) => f.tenantProductRef).sort()).toEqual([P_BATCH, P_EXPIRY, P_SERIAL].sort());
    expect(found.every((f) => f.storeId === null && f.trackingIdentityId === null && f.stockingUnit === null)).toBe(true);
  });

  it('shows a store_manager only the store-scoped checks in its stores, never a tenant-wide one', async () => {
    if (skipped()) return;
    role = 'store_manager';
    try {
      const scoped = await consistency(ctx({ storeId: STORE_A_Y, storeAccess: { kind: 'specific', storeIds: [STORE_A_Y] } }));
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.every((f) => f.storeId === STORE_A_Y)).toBe(true);
      expect(scoped.map((f) => f.check).sort()).toEqual(['serial_position_out_of_range', 'untracked_effect_on_tracked_product']);
    } finally {
      role = 'owner';
    }
  });

  it("never lists another tenant's records", async () => {
    if (skipped()) return;
    const bOrphan = await identity(P_B, 'batch', false, TENANT_B);
    await effect({ product: P_B, storeId: STORE_B_X, quantity: '1', identity: null, tenantId: TENANT_B });
    const a = await consistency();
    expect(a.some((f) => f.tenantProductRef === P_B || f.trackingIdentityId === bOrphan)).toBe(false);
    const b = await consistency(ctx({ tenantId: TENANT_B, userId: ACTOR_B }), TENANT_B);
    expect(b.map((f) => f.check).sort()).toEqual(['identity_without_edge_map', 'untracked_effect_on_tracked_product']);
  });
});
