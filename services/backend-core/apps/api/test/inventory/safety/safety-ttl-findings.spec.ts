/**
 * Jira RT-449 PR 2 — the Safety TTL setting (H8) and the computed safety
 * findings (H6) against real Postgres (Testcontainers, every migration, the
 * NOBYPASSRLS `app_test` role). Contract: `inventory/inventory.yaml` 1.8.0.
 *
 * Safety TTL: NULL answers the default 900; any value in 60–900 may be set,
 * raised or lowered (H8's range is the "downwards only" rule); out-of-range
 * values never reach the table (the column CHECK refuses them too); setting
 * the current value writes nothing; a change is audited and does not step
 * the Inventory Safety Revision.
 *
 * Findings: an active hold is critical with the stores holding its identity;
 * an expired lot still in `sellable` is critical per store; the expiry day
 * itself is not expired (G7-5, judged at the store's local date); quantity in
 * another status is not a finding; a store_manager sees only its stores
 * (and no hold without stock there); `expiring_lot` is never emitted; another
 * tenant's data never appears.
 *
 * The role read is a fake (`findRoleCodeForUserInTenant`); the scope rule is
 * the real `callerStoreScope`. Identities and positions are SEEDED: nothing
 * writes them until RT-453 (F6). Docker policy: hard failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';

import type { MembershipRepository } from '../../../src/context/membership.repository';
import type { ResolvedContext } from '../../../src/context/types';
import {
  SafetyFindingsService,
  type ExpiredLotSellableFinding,
} from '../../../src/inventory/safety/safety-findings.service';
import { SafetyTtlService } from '../../../src/inventory/safety/safety-ttl.service';
import { TrackingHoldsService } from '../../../src/inventory/safety/tracking-holds.service';
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

// `0449` / `f3` mnemonic, hex-safe.
const PRODUCT_T = '0a000000-0000-7000-8000-0000044f3001';
const PRODUCT_TB = '0b000000-0000-7000-8000-0000044f3001';

let env: PgTestEnv | null = null;
let admin: Pool;
let ttl: SafetyTtlService;
let findings: SafetyFindingsService;
let holds: TrackingHoldsService;
let role = 'owner';
let seq = 0;
const locations: Record<string, string> = {};

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function conforms(name: string, body: unknown): void {
  const validate = ajv.getSchema(`inventory#/components/schemas/${name}`);
  if (!validate) throw new Error(`ajv cannot resolve ${name}`);
  if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
}

function next(): string {
  seq += 1;
  return String(seq).padStart(6, '0');
}

async function newIdentity(expiry: string | null, tenantId = TENANT_A, product = PRODUCT_T): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $2, 'batch', $3, $4::date) RETURNING id::text AS id`,
    [tenantId, product, `FIND-${next()}`, expiry],
  );
  return r.rows[0]!.id;
}

/** One identity-grain effect (the fixture RT-451 will write for real). */
async function seedEffect(identity: string, storeId: string, status: string, quantity: string, tenantId = TENANT_A): Promise<void> {
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status, tracking_identity_id)
     VALUES (gen_random_uuid(), $1, $2, 'adjustment', $3::numeric, 'ea', $4, 'rt449 pr2 fixture', now(), $5,
             $6, $7, $8)`,
    [
      tenantId,
      storeId,
      quantity,
      tenantId === TENANT_A ? PRODUCT_T : PRODUCT_TB,
      tenantId === TENANT_A ? ACTOR_A : ACTOR_B,
      locations[storeId],
      status,
      identity,
    ],
  );
}

/** The store-local date in `days` days (negative = past), as the findings judge it. */
async function storeDate(storeId: string, days: number): Promise<string> {
  const r = await admin.query<{ d: string }>(
    `SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS d FROM stores WHERE id = $1`,
    [storeId, days],
  );
  return r.rows[0]!.d;
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

async function list(context: ResolvedContext = ctx(), tenantId = TENANT_A) {
  const body = await findings.listFindings({ tenantId, context });
  conforms('InventorySafetyFindingList', body);
  return body;
}

async function counts(): Promise<Record<string, string>> {
  const r = await admin.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM audit_events WHERE action = 'inventory.safety_ttl.update')::text AS audits,
            (SELECT count(*) FROM tenant_inventory_settings)::text AS settings,
            (SELECT COALESCE(SUM(revision), 0) FROM tenant_inventory_safety_revisions)::text AS revisions,
            (SELECT count(*) FROM inventory_safety_changes)::text AS changes`,
  );
  return r.rows[0]!;
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-449 safety TTL and findings');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'find-a@fixture.invalid', NULL), ($2, 'find-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode) VALUES
       ($1, $3, 'Findings tracked', 'standard', $5, $5, 'batch'), ($2, $4, 'Findings tracked B', 'standard', $6, $6, 'batch')`,
    [PRODUCT_T, PRODUCT_TB, TENANT_A, TENANT_B, ACTOR_A, ACTOR_B],
  );
  // Store A_Y runs a day ahead of UTC on most clocks; the expiry rule is per store.
  await admin.query(`UPDATE stores SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [STORE_A_Y]);
  const primaries = await admin.query<{ store_id: string; id: string }>(
    `SELECT store_id::text, id::text FROM stock_locations WHERE kind = 'primary' AND store_id = ANY($1::uuid[])`,
    [[STORE_A_X, STORE_A_Y, STORE_B_X]],
  );
  for (const row of primaries.rows) locations[row.store_id] = row.id;
  const pool = env.app as unknown as Pool;
  const memberships = {
    findRoleCodeForUserInTenant: async () => role,
  } as unknown as MembershipRepository;
  ttl = new SafetyTtlService(pool);
  findings = new SafetyFindingsService(pool, memberships);
  holds = new TrackingHoldsService(pool);
  ajv.addSchema(contractDocument(allContracts(), 'inventory') as object, 'inventory');
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

const skipped = (): boolean => env === null;

describe('Safety TTL (H8)', () => {
  it('answers the default 900 while unset', async () => {
    if (skipped()) return;
    expect(await ttl.getSafetyTtl(TENANT_A)).toEqual({
      safetyTtlSeconds: null,
      effectiveSafetyTtlSeconds: 900,
      updatedAt: null,
    });
  });

  it('writes nothing when the default is set again', async () => {
    if (skipped()) return;
    const before = await counts();
    expect((await ttl.setSafetyTtl({ tenantId: TENANT_A, userId: ACTOR_A, safetyTtlSeconds: null })).updatedAt).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it('sets, raises within 60-900 and resets, auditing each change without stepping the revision', async () => {
    if (skipped()) return;
    const before = await counts();
    const set = await ttl.setSafetyTtl({ tenantId: TENANT_A, userId: ACTOR_A, safetyTtlSeconds: 300 });
    expect(set).toMatchObject({ safetyTtlSeconds: 300, effectiveSafetyTtlSeconds: 300 });
    conforms('SafetyTtlSetting', set);
    expect((await ttl.setSafetyTtl({ tenantId: TENANT_A, userId: ACTOR_A, safetyTtlSeconds: 600 })).safetyTtlSeconds).toBe(600);
    const reset = await ttl.setSafetyTtl({ tenantId: TENANT_A, userId: ACTOR_A, safetyTtlSeconds: null });
    expect(reset).toMatchObject({ safetyTtlSeconds: null, effectiveSafetyTtlSeconds: 900 });
    expect(reset.updatedAt).not.toBeNull();
    const after = await counts();
    expect(Number(after.audits) - Number(before.audits)).toBe(3);
    expect([after.revisions, after.changes]).toEqual([before.revisions, before.changes]);
    const audit = await admin.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_events WHERE action = 'inventory.safety_ttl.update' ORDER BY occurred_at, id`,
    );
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      { old: null, new: 300 },
      { old: 300, new: 600 },
      { old: 600, new: null },
    ]);
  });

  it('writes nothing for the current value', async () => {
    if (skipped()) return;
    await ttl.setSafetyTtl({ tenantId: TENANT_A, userId: ACTOR_A, safetyTtlSeconds: 120 });
    const before = await counts();
    expect((await ttl.setSafetyTtl({ tenantId: TENANT_A, userId: ACTOR_A, safetyTtlSeconds: 120 })).safetyTtlSeconds).toBe(120);
    expect(await counts()).toEqual(before);
    expect((await ttl.getSafetyTtl(TENANT_A)).effectiveSafetyTtlSeconds).toBe(120);
  });

  it('is refused above 900 or below 60 by the column CHECK as well', async () => {
    if (skipped()) return;
    for (const value of [59, 901]) {
      await expect(
        ttl.setSafetyTtl({ tenantId: TENANT_A, userId: ACTOR_A, safetyTtlSeconds: value }),
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect((await ttl.getSafetyTtl(TENANT_A)).safetyTtlSeconds).toBe(120);
  });

  it("is per tenant: tenant B still runs on the default", async () => {
    if (skipped()) return;
    expect((await ttl.getSafetyTtl(TENANT_B)).effectiveSafetyTtlSeconds).toBe(900);
  });
});

describe('safety findings (H6)', () => {
  it('lists nothing for a tenant with no hold and no expired stock', async () => {
    if (skipped()) return;
    expect((await list()).findings).toEqual([]);
  });

  it('lists an active hold as critical with the stores holding the identity', async () => {
    if (skipped()) return;
    const identity = await newIdentity(null);
    await seedEffect(identity, STORE_A_X, 'sellable', '5');
    await seedEffect(identity, STORE_A_Y, 'sellable', '2');
    const placed = await holds.placeQualityHold({
      tenantId: TENANT_A,
      userId: ACTOR_A,
      idempotencyKey: `rt449-find-${next()}`,
      trackingIdentityId: identity,
      reasonCode: 'supplier_notice',
      note: null,
    });
    const noStock = await holds.placeQualityHold({
      tenantId: TENANT_A,
      userId: ACTOR_A,
      idempotencyKey: `rt449-find-${next()}`,
      trackingIdentityId: await newIdentity(null),
      reasonCode: 'supplier_notice',
      note: null,
    });
    const body = await list();
    const hold = body.findings.find((f) => f.kind === 'active_tracking_hold' && f.holdId === placed.hold.id);
    expect(hold).toMatchObject({
      severity: 'critical',
      holdKind: 'quality_hold',
      trackingIdentityId: identity,
      storeIds: [STORE_A_X, STORE_A_Y].sort(),
    });
    const bare = body.findings.find((f) => f.kind === 'active_tracking_hold' && f.holdId === noStock.hold.id);
    expect(bare).toMatchObject({ storeIds: [] });
  });

  it('shows a store_manager only the holds with stock in its stores, narrowed to them', async () => {
    if (skipped()) return;
    role = 'store_manager';
    try {
      const body = await list(ctx({ storeId: STORE_A_X, storeAccess: { kind: 'specific', storeIds: [STORE_A_X] } }));
      const holdsSeen = body.findings.filter((f) => f.kind === 'active_tracking_hold');
      expect(holdsSeen).toHaveLength(1);
      expect(holdsSeen[0]).toMatchObject({ storeIds: [STORE_A_X] });
    } finally {
      role = 'owner';
    }
  });

  it('lists an expired lot still in sellable per store, never on its expiry day nor in another status', async () => {
    if (skipped()) return;
    const expired = await newIdentity(await storeDate(STORE_A_X, -1));
    await seedEffect(expired, STORE_A_X, 'sellable', '3.5');
    await seedEffect(expired, STORE_A_X, 'sellable', '-1');
    const today = await newIdentity(await storeDate(STORE_A_X, 0));
    await seedEffect(today, STORE_A_X, 'sellable', '4');
    const inspected = await newIdentity(await storeDate(STORE_A_X, -10));
    await seedEffect(inspected, STORE_A_X, 'return_inspection', '2');
    const sold = await newIdentity(await storeDate(STORE_A_X, -10));
    await seedEffect(sold, STORE_A_X, 'sellable', '2');
    await seedEffect(sold, STORE_A_X, 'sellable', '-2');
    const expiredFindings = (await list()).findings.filter((f) => f.kind === 'expired_lot_sellable');
    expect(expiredFindings).toEqual([
      expect.objectContaining({
        severity: 'critical',
        trackingIdentityId: expired,
        storeId: STORE_A_X,
        sellableQuantity: '2.5000',
        stockingUnit: 'ea',
        expiryDate: await storeDate(STORE_A_X, -1),
        storeBusinessDate: await storeDate(STORE_A_X, 0),
      }),
    ]);
  });

  it("judges expiry at each store's local business date", async () => {
    if (skipped()) return;
    // Expires on store A_Y's yesterday: expired there, whatever the UTC date is.
    const identity = await newIdentity(await storeDate(STORE_A_Y, -1));
    await seedEffect(identity, STORE_A_Y, 'sellable', '1');
    const body = await list();
    expect(body.findings).toContainEqual(
      expect.objectContaining({ kind: 'expired_lot_sellable', trackingIdentityId: identity, storeId: STORE_A_Y }),
    );
  });

  it('scopes expired lots to a store_manager stores, and an empty scope sees nothing', async () => {
    if (skipped()) return;
    role = 'store_manager';
    try {
      const y = await list(ctx({ storeId: STORE_A_Y, storeAccess: { kind: 'specific', storeIds: [STORE_A_Y] } }));
      const expiredY = y.findings.filter((f): f is ExpiredLotSellableFinding => f.kind === 'expired_lot_sellable');
      expect(expiredY.length).toBeGreaterThan(0);
      expect(expiredY.every((f) => f.storeId === STORE_A_Y)).toBe(true);
      // No resolved store authority is no store, never tenant-wide.
      const { storeAccess: _unresolved, ...noAccess } = ctx();
      const none = await list(noAccess);
      expect(none.findings).toEqual([]);
    } finally {
      role = 'owner';
    }
  });

  it('orders holds before expired lots and never emits expiring_lot', async () => {
    if (skipped()) return;
    const kinds = (await list()).findings.map((f) => f.kind);
    expect(kinds).not.toContain('expiring_lot');
    expect(kinds.indexOf('expired_lot_sellable')).toBeGreaterThan(kinds.lastIndexOf('active_tracking_hold'));
  });

  it("never lists another tenant's hold or expired stock", async () => {
    if (skipped()) return;
    const bIdentity = await newIdentity('2020-01-01', TENANT_B, PRODUCT_TB);
    await holds.placeQualityHold({
      tenantId: TENANT_B,
      userId: ACTOR_B,
      idempotencyKey: `rt449-find-${next()}`,
      trackingIdentityId: bIdentity,
      reasonCode: 'supplier_notice',
      note: null,
    });
    // Seeded after the hold, so it stays `sellable` (placing a hold moves sellable stock).
    await seedEffect(bIdentity, STORE_B_X, 'sellable', '9', TENANT_B);
    const a = await list();
    expect(a.findings.some((f) => f.trackingIdentityId === bIdentity)).toBe(false);
    const b = await list(ctx({ tenantId: TENANT_B, userId: ACTOR_B }), TENANT_B);
    expect(b.findings.map((f) => f.kind).sort()).toEqual(['active_tracking_hold', 'expired_lot_sellable']);
  });
});
