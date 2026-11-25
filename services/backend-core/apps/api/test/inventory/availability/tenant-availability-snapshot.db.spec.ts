/**
 * Jira RT-1597 — `readTenantAvailabilitySnapshot` (the W3 port the W9 redistribution proposals read) against real
 * Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 *
 * Proves (RT-1597 acceptance 2 and 5):
 *   - parity: every row equals the POS store-availability snapshot (`PosAvailabilityService.getSnapshot`, same product
 *     set) AND `OnHand.availability` (`readAvailability`) of the same store and product, over the hard cases of the
 *     A-1 rules (negative ATS, an expired lot, a lapsed reservation, stock at another store only);
 *   - the reorder level is the store's active level over the tenant default, else null;
 *   - each store's read time is the oldest of its rows', and `app.current_store` is left as it was found;
 *   - the store set: only live (not deleted, active) stores; a requested inactive store or a store of another tenant is
 *     excluded and never read (RLS: tenant B's store is `not_found` from tenant A);
 *   - the limits: `maxStores` and `maxRows` refuse with no row at all; exactly the limit is allowed.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { runWithTenantContext } from '@data-pulse-2/db';
import { Pool, type PoolClient } from 'pg';

import {
  readTenantAvailabilitySnapshot,
  TENANT_AVAILABILITY_PLACEHOLDER_LIMITS,
  type TenantAvailabilityLimits,
  type TenantAvailabilitySnapshot,
} from '../../../src/inventory';
import { readAvailability } from '../../../src/inventory/availability/availability.query';
import { PosAvailabilityService } from '../../../src/inventory/availability/pos-availability.service';
import { liveAndNamedStores } from '../../../src/stores';
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

const id = (n: number): string => `0a000000-0000-7000-8000-${(0x159700000000 + n).toString(16).padStart(12, '0')}`;

const P = {
  wide: id(0x101), // X: 100, Y: 5; tenant level 10
  negative: id(0x102), // X: 2 sellable, 6 reserved -> -4; store X level 3 over tenant level 50
  expiredLot: id(0x103), // X: 7 in an expired lot + 5 in a valid one -> 5
  lapsedReservation: id(0x104), // X: 10, active 2, lapsed 3 -> 8; no level
  storeYOnly: id(0x105), // Y: 50; X: none -> 0
  unpriced: id(0x120), // not sellable: never a row
};
const EXPIRED_LOT = id(0x201);
const VALID_LOT = id(0x202);
const PRODUCT_B = id(0x301);

let env: PgTestEnv | null = null;
let admin: Pool;
let pos: PosAvailabilityService;
let primaryX = '';
let seq = 0;

const skipped = (): boolean => env === null;
const nextId = (): string => `0a000000-0000-7000-8000-${(0x159800000000 + ++seq).toString(16).padStart(12, '0')}`;
const stores = { liveAndNamedStores };

async function asTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return await runWithTenantContext(env!.app as unknown as Pool, { tenantId, isPlatformAdmin: false }, fn);
}

async function snapshot(
  tenantId: string,
  opts: { storeIds?: readonly string[]; limits?: TenantAvailabilityLimits } = {},
): Promise<TenantAvailabilitySnapshot> {
  return await asTenant(tenantId, (client) =>
    readTenantAvailabilitySnapshot(
      client,
      { tenantId, storeIds: opts.storeIds, limits: opts.limits ?? TENANT_AVAILABILITY_PLACEHOLDER_LIMITS },
      { stores },
    ),
  );
}

function ok(s: TenantAvailabilitySnapshot): Extract<TenantAvailabilitySnapshot, { kind: 'snapshot' }> {
  if (s.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${JSON.stringify(s)}`);
  return s;
}

async function product(productId: string, opts: { tenantId?: string; price?: string | null; tracking?: 'batch' } = {}): Promise<void> {
  const price = opts.price === undefined ? '10.00' : opts.price;
  const tenant = opts.tenantId ?? TENANT_A;
  await admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, default_price, default_currency_code, created_by, updated_by, tracking_mode)
     VALUES ($1, $2, $3, 'standard', $4::numeric, CASE WHEN $4::numeric IS NULL THEN NULL ELSE 'EGP' END, $5, $5, COALESCE($6, 'none'))`,
    [productId, tenant, `RT1597 ${productId.slice(-4)}`, price, tenant === TENANT_A ? ACTOR_A : ACTOR_B, opts.tracking ?? null],
  );
}

async function level(productId: string, storeId: string | null, reorder: string): Promise<void> {
  await admin.query(
    `INSERT INTO product_stock_levels (id, tenant_id, product_id, store_id, reorder_level, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $6)`,
    [nextId(), TENANT_A, productId, storeId, reorder, ACTOR_A],
  );
}

async function move(storeId: string, productId: string, quantity: string, tenantId = TENANT_A): Promise<void> {
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, 'inbound', $4::numeric, 'ea', $5, 'rt1597 seed', now(), $6,
             (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), 'sellable')`,
    [nextId(), tenantId, storeId, quantity, productId, tenantId === TENANT_A ? ACTOR_A : ACTOR_B],
  );
}

/** A lot-bound movement (ERP-born: a tracked identity is attached only by an ERP receipt). */
async function moveLot(productId: string, quantity: string, lotId: string): Promise<void> {
  const eventId = nextId();
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, received_at,
        created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status, tracking_identity_id)
     VALUES ($1, $2, $3, 'inbound', $4::numeric(19,4), 'each', $5, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
             $6, 'erp_external', 'erp_procurement_receipt', $1, $7, 'sellable', $8)`,
    [eventId, TENANT_A, STORE_A_X, quantity, productId, ACTOR_A, primaryX, lotId],
  );
  await admin.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at)
     VALUES ($1, $2, 'external', '2020-01-01T00:00:00Z')`,
    [eventId, TENANT_A],
  );
}

async function reserve(productId: string, quantity: string, expiresAt: string): Promise<void> {
  await admin.query(
    `INSERT INTO inventory_reservations
       (id, tenant_id, store_id, stock_location_id, tenant_product_ref, quantity, expires_at, source_type, source_id,
        source_line_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::numeric(19,4), $7, 'transfer', $8, $9, $10)`,
    [nextId(), TENANT_A, STORE_A_X, primaryX, productId, quantity, expiresAt, nextId(), nextId(), ACTOR_A],
  );
}

/** Every item of the POS snapshot of one store, walking all its pages with a small page size. */
async function posItems(storeId: string): Promise<Map<string, string>> {
  const items = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const page = await pos.getSnapshot(TENANT_A, storeId, { limit: 2, cursor });
    for (const item of page.items) items.set(item.productId, item.availableToSell);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1597 tenant availability snapshot');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt1597-a@fixture.invalid', NULL), ($2, 'rt1597-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  primaryX = (await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])).rows[0].id;
  pos = new PosAvailabilityService(env.app as unknown as Pool);

  for (const p of [P.wide, P.negative, P.lapsedReservation, P.storeYOnly]) await product(p);
  await product(P.expiredLot, { tracking: 'batch' });
  await product(P.unpriced, { price: null });
  await product(PRODUCT_B, { tenantId: TENANT_B });
  await admin.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date) VALUES
       ($1, $3, $4, 'batch', 'RT1597-EXPIRED', '2000-01-01'), ($2, $3, $4, 'batch', 'RT1597-VALID', '2099-01-01')`,
    [EXPIRED_LOT, VALID_LOT, TENANT_A, P.expiredLot],
  );

  await level(P.wide, null, '10');
  await level(P.negative, null, '50');
  await level(P.negative, STORE_A_X, '3');

  await move(STORE_A_X, P.wide, '100');
  await move(STORE_A_Y, P.wide, '5');
  await move(STORE_A_X, P.negative, '2');
  await reserve(P.negative, '6', '2099-01-01T00:00:00Z');
  await moveLot(P.expiredLot, '7', EXPIRED_LOT);
  await moveLot(P.expiredLot, '5', VALID_LOT);
  await move(STORE_A_X, P.lapsedReservation, '10');
  await reserve(P.lapsedReservation, '2', '2099-01-01T00:00:00Z');
  await reserve(P.lapsedReservation, '3', '2020-01-01T00:00:00Z'); // lapsed, never swept: still state 'active'
  await move(STORE_A_Y, P.storeYOnly, '50');
  await move(STORE_A_X, P.unpriced, '9');
  await move(STORE_B_X, PRODUCT_B, '8', TENANT_B);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

describe('readTenantAvailabilitySnapshot: parity with the existing availability reads (one formula)', () => {
  it('reads every active store of the tenant, and each row equals the POS snapshot and OnHand.availability', async () => {
    if (skipped()) return;
    const s = ok(await snapshot(TENANT_A));
    expect(s.stores.map((x) => x.storeId)).toEqual([STORE_A_X, STORE_A_Y].sort());
    expect(s.excludedStores).toEqual([]);
    for (const storeId of [STORE_A_X, STORE_A_Y]) {
      const mine = new Map(s.rows.filter((r) => r.storeId === storeId).map((r) => [r.productId, r.availableToSell] as const));
      // Same product set and the same ATS as the till's snapshot of that store.
      expect(mine).toEqual(await posItems(storeId));
      // And the same ATS as the Console's one-product read.
      await asTenant(TENANT_A, async (client) => {
        for (const [productId, ats] of mine) {
          expect((await readAvailability(client, { storeId, productId })).availableToSell).toBe(ats);
        }
      });
    }
  });

  it('covers the hard cases of the A-1 rules and resolves the reorder level (store over tenant default, else null)', async () => {
    if (skipped()) return;
    const s = ok(await snapshot(TENANT_A));
    const at = (storeId: string, productId: string) => s.rows.find((r) => r.storeId === storeId && r.productId === productId);
    expect(at(STORE_A_X, P.wide)).toMatchObject({ availableToSell: '100.0000', reorderLevel: '10.0000' });
    expect(at(STORE_A_Y, P.wide)).toMatchObject({ availableToSell: '5.0000', reorderLevel: '10.0000' });
    expect(at(STORE_A_X, P.negative)).toMatchObject({ availableToSell: '-4.0000', reorderLevel: '3.0000' });
    expect(at(STORE_A_Y, P.negative)).toMatchObject({ availableToSell: '0.0000', reorderLevel: '50.0000' });
    expect(at(STORE_A_X, P.expiredLot)).toMatchObject({ availableToSell: '5.0000', reorderLevel: null });
    expect(at(STORE_A_X, P.lapsedReservation)).toMatchObject({ availableToSell: '8.0000', reorderLevel: null });
    expect(at(STORE_A_X, P.storeYOnly)).toMatchObject({ availableToSell: '0.0000' });
    expect(at(STORE_A_Y, P.storeYOnly)).toMatchObject({ availableToSell: '50.0000' });
    expect(s.rows.some((r) => r.productId === P.unpriced)).toBe(false);
    expect(s.rows.some((r) => r.productId === PRODUCT_B)).toBe(false);
  });

  it("records each store's read time as the oldest of its rows', and leaves app.current_store as it found it", async () => {
    if (skipped()) return;
    const result = await asTenant(TENANT_A, async (client) => {
      await client.query(`SELECT set_config('app.current_store', '*', true)`);
      const s = ok(
        await readTenantAvailabilitySnapshot(client, { tenantId: TENANT_A, limits: TENANT_AVAILABILITY_PLACEHOLDER_LIMITS }, { stores }),
      );
      const after = (await client.query(`SELECT current_setting('app.current_store', true) AS v`)).rows[0].v as string;
      return { s, after };
    });
    expect(result.after).toBe('*');
    for (const store of result.s.stores) {
      const rows = result.s.rows.filter((r) => r.storeId === store.storeId);
      expect(store.rowCount).toBe(rows.length);
      expect(rows.length).toBeGreaterThan(0);
      expect(store.readAt).toBe(rows.map((r) => r.readAt).sort()[0]);
      expect(Number.isNaN(Date.parse(store.readAt))).toBe(false);
    }
  });
});

describe('readTenantAvailabilitySnapshot: the store set and tenant isolation', () => {
  it('reads only the requested live stores; an inactive store is excluded and not read', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE stores SET is_active = false WHERE id = $1`, [STORE_A_Y]);
    try {
      const all = ok(await snapshot(TENANT_A));
      expect(all.stores.map((x) => x.storeId)).toEqual([STORE_A_X]);
      const named = ok(await snapshot(TENANT_A, { storeIds: [STORE_A_X, STORE_A_Y] }));
      expect(named.stores.map((x) => x.storeId)).toEqual([STORE_A_X]);
      expect(named.excludedStores).toEqual([{ storeId: STORE_A_Y, reason: 'inactive' }]);
      expect(named.rows.every((r) => r.storeId === STORE_A_X)).toBe(true);
    } finally {
      await admin.query(`UPDATE stores SET is_active = true WHERE id = $1`, [STORE_A_Y]);
    }
  });

  it("never reads another tenant's store (RLS): it is not_found, and an empty list reads nothing", async () => {
    if (skipped()) return;
    const cross = ok(await snapshot(TENANT_A, { storeIds: [STORE_B_X] }));
    expect(cross.stores).toEqual([]);
    expect(cross.rows).toEqual([]);
    expect(cross.excludedStores).toEqual([{ storeId: STORE_B_X, reason: 'not_found' }]);
    const none = ok(await snapshot(TENANT_A, { storeIds: [] }));
    expect(none.stores).toEqual([]);
    expect(none.rows).toEqual([]);
    // Tenant B's own snapshot sees only its own product.
    const b = ok(await snapshot(TENANT_B));
    expect(b.rows.every((r) => r.storeId !== STORE_A_X && r.storeId !== STORE_A_Y)).toBe(true);
    expect(b.rows.some((r) => r.productId === P.wide)).toBe(false);
    expect(b.rows.find((r) => r.productId === PRODUCT_B && r.storeId === STORE_B_X)?.availableToSell).toBe('8.0000');
  });
});

describe('readTenantAvailabilitySnapshot: limits (all or nothing)', () => {
  it('refuses above maxStores before reading any product', async () => {
    if (skipped()) return;
    expect(await snapshot(TENANT_A, { limits: { maxStores: 1, maxRows: 20_000 } })).toEqual({
      kind: 'refused_too_large',
      limit: 'maxStores',
      max: 1,
    });
    expect(ok(await snapshot(TENANT_A, { limits: { maxStores: 2, maxRows: 20_000 } })).stores).toHaveLength(2);
  });

  it('refuses above maxRows with no row at all, and allows exactly maxRows', async () => {
    if (skipped()) return;
    const total = ok(await snapshot(TENANT_A)).rows.length;
    expect(total).toBeGreaterThan(1);
    expect(await snapshot(TENANT_A, { limits: { maxStores: 50, maxRows: total - 1 } })).toEqual({
      kind: 'refused_too_large',
      limit: 'maxRows',
      max: total - 1,
    });
    expect(ok(await snapshot(TENANT_A, { limits: { maxStores: 50, maxRows: total } })).rows).toHaveLength(total);
  });
});
