/**
 * Jira RT-1577 (RT-1511 S2) — `posGetStoreAvailability` against real Postgres (Testcontainers, every migration, the
 * NOBYPASSRLS `app_test` role), over HTTP behind the real `PosDeviceAuthGuard`.
 * Contract: `packages/contracts/openapi/inventory/pos-availability.yaml`.
 *
 * What this proves (RT-1577 acceptance criteria):
 *   - the product set is the store's sellable catalogue (unpriced, retired and store-deactivated products are absent);
 *   - ATS and band for every case of the rules: in stock, low, low AT the level, the store level over the tenant default,
 *     no level set, zero, negative (never clamped), an expired lot, a held quantity, an active versus a lapsed reservation;
 *   - the snapshot number equals `OnHand.availability.availableToSell` of the same product (one rule, two surfaces);
 *   - `asOf` is on every page; paging is stable (keyset, no repeat, no loss) even when products appear mid-walk, and a
 *     page can be empty and still carry a cursor;
 *   - negatives: no token, a revoked device, a device of another store, a device of another tenant, a `branch_id` that is
 *     not the device's store, a malformed or foreign cursor, a bad `limit`;
 *   - bodies match the contract schemas.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { Module, type INestApplication } from '@nestjs/common';
import { hashToken } from '@data-pulse-2/auth';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';
import request from 'supertest';

import { AuthModule } from '../../../src/auth/auth.module';
import { PosDeviceAuthGuard } from '../../../src/auth/pos-device-auth.guard';
import { AUTH_LOOKUP_POOL, PG_POOL } from '../../../src/database';
import { InventoryService } from '../../../src/inventory/inventory.service';
import { PosAvailabilityController } from '../../../src/inventory/availability/pos-availability.controller';
import { encodeAvailabilityCursor } from '../../../src/inventory/availability/pos-availability.cursor';
import { PosAvailabilityService } from '../../../src/inventory/availability/pos-availability.service';
import { DeviceRepository } from '../../../src/pos-operators/device.repository';
import { bootDeviceModuleApp, startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { allContracts, contractDocument } from '../../_helpers/openapi-contract';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

const id = (n: number): string => `0a000000-0000-7000-8000-${(0x157700000000 + n).toString(16).padStart(12, '0')}`;
const device = (n: string) => ({
  id: `0a000000-0000-7000-8000-0000001577d${n}`,
  token: `rt1577-availability-device-token-${n}-aaaaaaaaaaaa`,
});
const DEV_AX = device('1');
const DEV_AY = device('2');
const DEV_BX = device('3');
const DEV_REVOKED = device('4');

/** The sellable products of tenant A, in id order; each case of the rules has its own. */
const P = {
  inStock: id(0x101), // ATS 100, tenant level 10
  low: id(0x102), // ATS 5, tenant level 10
  atLevel: id(0x103), // ATS 10, tenant level 10: low AT the level
  storeLevelWins: id(0x104), // ATS 20; tenant level 50 (would be low), store X level 10 (in stock)
  tenantLevelOnY: id(0x105), // ATS 20, tenant level 50 only: low
  noLevel: id(0x106), // ATS 3, no level: in stock
  zero: id(0x107), // 5 in, 5 out: ATS 0, out
  negative: id(0x108), // 2 sellable, 6 reserved: ATS -4, out
  expiredLot: id(0x109), // tracked: 7 in an expired lot, 5 in a valid one: ATS 5
  held: id(0x10a), // 10 sellable + 4 in quality hold: ATS 10
  lapsedReservation: id(0x10b), // 10 sellable, active 2, lapsed 3: ATS 8
  noMovement: id(0x10c), // none: 0, out
  storeOnly: id(0x10d), // moved at STORE_A_Y only: 0 at X
  // Excluded from the store's sellable catalogue:
  unpriced: id(0x120),
  retired: id(0x121),
  storeDeactivated: id(0x122),
};
const EXPIRED_LOT = id(0x201);
const VALID_LOT = id(0x202);
const PRODUCT_B = id(0x301);

const EXPECTED_AT_X: ReadonlyArray<readonly [string, string, string]> = [
  [P.inStock, '100.0000', 'in_stock'],
  [P.low, '5.0000', 'low'],
  [P.atLevel, '10.0000', 'low'],
  [P.storeLevelWins, '20.0000', 'in_stock'],
  [P.tenantLevelOnY, '20.0000', 'low'],
  [P.noLevel, '3.0000', 'in_stock'],
  [P.zero, '0.0000', 'out'],
  [P.negative, '-4.0000', 'out'],
  [P.expiredLot, '5.0000', 'in_stock'],
  [P.held, '10.0000', 'in_stock'],
  [P.lapsedReservation, '8.0000', 'in_stock'],
  [P.noMovement, '0.0000', 'out'],
  [P.storeOnly, '0.0000', 'out'],
];
const EXCLUDED = [P.unpriced, P.retired, P.storeDeactivated];

@Module({
  imports: [AuthModule],
  controllers: [PosAvailabilityController],
  providers: [
    PosAvailabilityService,
    {
      provide: DeviceRepository,
      useFactory: (lookup: Pool, domain: Pool): DeviceRepository => new DeviceRepository(lookup, domain),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
  ],
})
class AvailabilityTestModule {}

interface Item {
  readonly productId: string;
  readonly availableToSell: string;
  readonly band: string;
}
interface Page {
  readonly storeId: string;
  readonly asOf: string;
  readonly items: Item[];
  readonly nextCursor: string | null;
}

let env: PgTestEnv | null = null;
let admin: Pool;
let app: INestApplication;
let inventory: InventoryService;
let primaryX = '';
let seq = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const skipped = (): boolean => env === null;
const nextId = (): string => `0a000000-0000-7000-8000-${(0x157800000000 + ++seq).toString(16).padStart(12, '0')}`;
const server = () => app.getHttpServer() as Parameters<typeof request>[0];
const asDevice = (d: { token: string }, query = '') =>
  request(server()).get(`/api/pos/v1/inventory/availability${query}`).set('Authorization', `Bearer ${d.token}`);

function conforms(name: string, body: unknown): void {
  const validate = ajv.getSchema(`pos-availability#/components/schemas/${name}`);
  if (!validate) throw new Error(`ajv cannot resolve ${name}`);
  if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
}

/** Walk every page of one device with `limit`, checking the contract and the shared `storeId` of each page. */
async function walk(d: { token: string }, limit: number, extra = ''): Promise<{ pages: Page[]; items: Item[] }> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${extra}`;
    const res = await asDevice(d, query);
    expect(res.status).toBe(200);
    conforms('StoreAvailabilityPage', res.body);
    pages.push(res.body as Page);
    cursor = (res.body as Page).nextCursor;
  } while (cursor !== null);
  return { pages, items: pages.flatMap((p) => p.items) };
}

async function product(
  productId: string,
  opts: { tenantId?: string; price?: string | null; retired?: boolean; tracking?: 'batch' } = {},
): Promise<void> {
  const price = opts.price === undefined ? '10.00' : opts.price;
  await admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, default_price, default_currency_code, retired_at, created_by, updated_by, tracking_mode)
     VALUES ($1, $2, $3, 'standard', $4::numeric, CASE WHEN $4::numeric IS NULL THEN NULL ELSE 'EGP' END,
             CASE WHEN $5::boolean THEN now() END, $6, $6, COALESCE($7, 'none'))`,
    [
      productId,
      opts.tenantId ?? TENANT_A,
      `RT1577 ${productId.slice(-4)}`,
      price,
      opts.retired ?? false,
      (opts.tenantId ?? TENANT_A) === TENANT_A ? ACTOR_A : ACTOR_B,
      opts.tracking ?? null,
    ],
  );
}

async function level(productId: string, storeId: string | null, reorder: string, retired = false): Promise<void> {
  await admin.query(
    `INSERT INTO product_stock_levels (id, tenant_id, product_id, store_id, reorder_level, retired_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::numeric, CASE WHEN $7::boolean THEN now() END, $6, $6)`,
    [nextId(), TENANT_A, productId, storeId, reorder, ACTOR_A, retired],
  );
}

async function move(
  storeId: string,
  productId: string,
  quantity: string,
  opts: { status?: string; tenantId?: string } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, $4, $5::numeric, 'ea', $6, 'rt1577 seed', now(), $7,
             (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), $8)`,
    [
      nextId(),
      opts.tenantId ?? TENANT_A,
      storeId,
      quantity.startsWith('-') ? 'adjustment' : 'inbound',
      quantity,
      productId,
      (opts.tenantId ?? TENANT_A) === TENANT_A ? ACTOR_A : ACTOR_B,
      opts.status ?? 'sellable',
    ],
  );
}

/** A lot-bound movement (ERP-born, as `availability.db.spec.ts`: a tracked identity is attached only by an ERP receipt). */
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

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1577 POS store availability');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'avail-a@fixture.invalid', NULL), ($2, 'avail-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  primaryX = (await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])).rows[0].id;

  for (const p of [
    P.inStock, P.low, P.atLevel, P.storeLevelWins, P.tenantLevelOnY, P.noLevel, P.zero, P.negative, P.held,
    P.lapsedReservation, P.noMovement, P.storeOnly, P.storeDeactivated,
  ]) {
    await product(p);
  }
  await product(P.expiredLot, { tracking: 'batch' });
  await product(P.unpriced, { price: null });
  await product(P.retired, { retired: true });
  await product(PRODUCT_B, { tenantId: TENANT_B });
  await admin.query(
    `INSERT INTO store_product_overrides (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, false, $5, $5)`,
    [nextId(), TENANT_A, STORE_A_X, P.storeDeactivated, ACTOR_A],
  );
  await admin.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date) VALUES
       ($1, $3, $4, 'batch', 'AV-EXPIRED', '2000-01-01'), ($2, $3, $4, 'batch', 'AV-VALID', '2099-01-01')`,
    [EXPIRED_LOT, VALID_LOT, TENANT_A, P.expiredLot],
  );

  // Low-stock levels (the band): tenant defaults, and a store level that wins at STORE_A_X.
  await level(P.inStock, null, '10');
  await level(P.low, null, '10');
  await level(P.atLevel, null, '10');
  await level(P.storeLevelWins, null, '50');
  await level(P.storeLevelWins, STORE_A_X, '10');
  await level(P.tenantLevelOnY, null, '50');
  await level(P.inStock, STORE_A_X, '1000', true); // a RETIRED store level must be ignored: ATS 100 stays in_stock

  // Quantities at STORE_A_X's primary location.
  await move(STORE_A_X, P.inStock, '100');
  // Stock at a non-primary location is not sold from (V1 sells from the primary location only): ATS stays 100.
  const storage = nextId();
  await admin.query(
    `INSERT INTO stock_locations (id, tenant_id, store_id, code, name, kind) VALUES ($1, $2, $3, 'BACK', 'Back room', 'storage')`,
    [storage, TENANT_A, STORE_A_X],
  );
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason, occurred_at, created_by,
        stock_location_id, inventory_status)
     VALUES ($1, $2, $3, 'inbound', 40, 'ea', $4, 'rt1577 seed', now(), $5, $6, 'sellable')`,
    [nextId(), TENANT_A, STORE_A_X, P.inStock, ACTOR_A, storage],
  );
  await move(STORE_A_X, P.low, '20');
  await move(STORE_A_X, P.low, '-15');
  await move(STORE_A_X, P.atLevel, '10');
  await move(STORE_A_X, P.storeLevelWins, '20');
  await move(STORE_A_X, P.tenantLevelOnY, '20');
  await move(STORE_A_X, P.noLevel, '3');
  await move(STORE_A_X, P.zero, '5');
  await move(STORE_A_X, P.zero, '-5');
  await move(STORE_A_X, P.negative, '2');
  await reserve(P.negative, '6', '2099-01-01T00:00:00Z');
  await moveLot(P.expiredLot, '7', EXPIRED_LOT);
  await moveLot(P.expiredLot, '5', VALID_LOT);
  await move(STORE_A_X, P.held, '10');
  await move(STORE_A_X, P.held, '4', { status: 'quality_hold' });
  await move(STORE_A_X, P.lapsedReservation, '10');
  await reserve(P.lapsedReservation, '2', '2099-01-01T00:00:00Z');
  await reserve(P.lapsedReservation, '3', '2020-01-01T00:00:00Z'); // lapsed, never swept: still state 'active'
  await move(STORE_A_Y, P.storeOnly, '50');
  await move(STORE_A_X, P.unpriced, '9');
  await move(STORE_A_X, P.retired, '9');
  await move(STORE_A_X, P.storeDeactivated, '9');
  await move(STORE_B_X, PRODUCT_B, '8', { tenantId: TENANT_B });

  for (const [d, tenant, store] of [
    [DEV_AX, TENANT_A, STORE_A_X],
    [DEV_AY, TENANT_A, STORE_A_Y],
    [DEV_BX, TENANT_B, STORE_B_X],
    [DEV_REVOKED, TENANT_A, STORE_A_X],
  ] as const) {
    await admin.query(`INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till', $4)`, [
      d.id, tenant, store, hashToken(d.token),
    ]);
  }
  await admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEV_REVOKED.id]);

  inventory = new InventoryService(env.app as unknown as Pool);
  ajv.addSchema(contractDocument(allContracts(), 'pos-availability') as object, 'pos-availability');
  app = await bootDeviceModuleApp(AvailabilityTestModule, { domain: env.app, lookup: admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

describe('the snapshot of the device store', () => {
  it('lists exactly the sellable catalogue, with ATS and band for every rule case', async () => {
    if (skipped()) return;
    const { items, pages } = await walk(DEV_AX, 1000);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.storeId).toBe(STORE_A_X);
    expect(Number.isNaN(Date.parse(pages[0]!.asOf))).toBe(false);
    const byId = new Map(items.map((i) => [i.productId, i]));
    for (const [productId, ats, band] of EXPECTED_AT_X) {
      expect(byId.get(productId)).toEqual({ productId, availableToSell: ats, band });
    }
    for (const productId of EXCLUDED) expect(byId.has(productId)).toBe(false);
    // Only this tenant's sellable products: the fixture's unpriced products and tenant B's product are absent.
    expect(items.map((i) => i.productId).sort()).toEqual(EXPECTED_AT_X.map(([p]) => p).sort());
    expect(items.map((i) => i.productId)).toEqual([...items.map((i) => i.productId)].sort());
  });

  it('equals OnHand.availability.availableToSell for every product (one rule, two surfaces)', async () => {
    if (skipped()) return;
    const { items } = await walk(DEV_AX, 1000);
    for (const item of items) {
      const onHand = await inventory.getOnHand({ tenantId: TENANT_A, storeId: STORE_A_X, productId: item.productId });
      expect(item.availableToSell).toBe(onHand.availability.availableToSell);
    }
  });

  it('reads the device store only: STORE_A_Y sees its own quantities and none of STORE_A_X', async () => {
    if (skipped()) return;
    const { items, pages } = await walk(DEV_AY, 1000);
    expect(pages[0]!.storeId).toBe(STORE_A_Y);
    const byId = new Map(items.map((i) => [i.productId, i]));
    expect(byId.get(P.storeOnly)).toEqual({ productId: P.storeOnly, availableToSell: '50.0000', band: 'in_stock' });
    expect(byId.get(P.inStock)).toEqual({ productId: P.inStock, availableToSell: '0.0000', band: 'out' });
    // The deactivation override belongs to STORE_A_X: the product is still sold at STORE_A_Y.
    expect(byId.has(P.storeDeactivated)).toBe(true);
  });
});

describe('paging', () => {
  it('is stable: one-product pages walk the same set once, and a page can be empty yet carry a cursor', async () => {
    if (skipped()) return;
    const full = (await walk(DEV_AX, 1000)).items.map((i) => i.productId);
    const { pages, items } = await walk(DEV_AX, 1);
    expect(items.map((i) => i.productId)).toEqual(full);
    expect(new Set(items.map((i) => i.productId)).size).toBe(items.length);
    // The fixture's unpriced products sort first in id order, so the first single-product pages hold nothing.
    const emptyWithCursor = pages.filter((p) => p.items.length === 0 && p.nextCursor !== null);
    expect(emptyWithCursor.length).toBeGreaterThan(0);
    expect(pages.every((p) => !Number.isNaN(Date.parse(p.asOf)))).toBe(true);
  });

  it('answers an empty last page with its asOf', async () => {
    if (skipped()) return;
    const cursor = encodeAvailabilityCursor({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      afterProductId: 'ffffffff-ffff-7fff-bfff-ffffffffffff',
    });
    const res = await asDevice(DEV_AX, `?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ storeId: STORE_A_X, items: [], nextCursor: null });
    expect(Number.isNaN(Date.parse(res.body.asOf))).toBe(false);
    conforms('StoreAvailabilityPage', res.body);
  });

  it('never repeats or hides a product when products appear mid-walk', async () => {
    if (skipped()) return;
    const before = (await walk(DEV_AX, 1000)).items.map((i) => i.productId);
    const first = await asDevice(DEV_AX, '?limit=4');
    expect(first.status).toBe(200);
    const seen = (first.body as Page).items.map((i) => i.productId);
    const early = id(0x001); // sorts before every product of this test, so before the cursor: not seen by this walk
    const late = id(0x999); // sorts after: seen exactly once
    await product(early);
    await product(late);
    try {
      let cursor = (first.body as Page).nextCursor;
      while (cursor !== null) {
        const res = await asDevice(DEV_AX, `?limit=4&cursor=${encodeURIComponent(cursor)}`);
        expect(res.status).toBe(200);
        seen.push(...(res.body as Page).items.map((i) => i.productId));
        cursor = (res.body as Page).nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([...before, late]);
      expect(seen).not.toContain(early);
    } finally {
      await admin.query(`UPDATE tenant_products SET retired_at = now() WHERE id = ANY($1::uuid[])`, [[early, late]]);
    }
  });
});

describe('refusals', () => {
  it('a missing, unknown or revoked device token is a generic 401', async () => {
    if (skipped()) return;
    const path = '/api/pos/v1/inventory/availability';
    expect((await request(server()).get(path)).status).toBe(401);
    expect((await request(server()).get(path).set('Authorization', 'Bearer not-a-device-token')).status).toBe(401);
    expect((await asDevice(DEV_REVOKED)).status).toBe(401);
  });

  it('a branch_id that is not the device store is a non-disclosing 404, the device own store is accepted', async () => {
    if (skipped()) return;
    for (const other of [STORE_A_Y, STORE_B_X]) {
      const res = await asDevice(DEV_AX, `?branch_id=${other}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(other);
    }
    expect((await asDevice(DEV_AX, `?branch_id=${STORE_A_X}`)).status).toBe(200);
    expect((await asDevice(DEV_AX, `?branch_id=${STORE_A_X.toUpperCase()}`)).status).toBe(200);
  });

  it('a device of another tenant sees none of this tenant products, only its own', async () => {
    if (skipped()) return;
    const { items, pages } = await walk(DEV_BX, 1000);
    expect(pages[0]!.storeId).toBe(STORE_B_X);
    expect(items).toEqual([{ productId: PRODUCT_B, availableToSell: '8.0000', band: 'in_stock' }]);
    expect((await asDevice(DEV_BX, `?branch_id=${STORE_A_X}`)).status).toBe(404);
    // PRODUCT_B_ACTIVE is the fixture's unpriced product of tenant B: absent as in the read-down.
    expect(items.map((i) => i.productId)).not.toContain(PRODUCT_B_ACTIVE);
  });

  it('a cursor issued to another device scope, or malformed, is a non-disclosing 404', async () => {
    if (skipped()) return;
    const first = await asDevice(DEV_AX, '?limit=2');
    const cursor = (first.body as Page).nextCursor!;
    expect(cursor).not.toBeNull();
    expect((await asDevice(DEV_AX, `?limit=2&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
    expect((await asDevice(DEV_AY, `?cursor=${encodeURIComponent(cursor)}`)).status).toBe(404); // same tenant, other store
    expect((await asDevice(DEV_BX, `?cursor=${encodeURIComponent(cursor)}`)).status).toBe(404); // other tenant
    expect((await asDevice(DEV_AX, '?cursor=not-a-cursor')).status).toBe(404);
  });

  it.each([['limit=0'], ['limit=1001'], ['limit=abc'], ['branch_id=not-a-uuid']])('%s is a 400', async (query) => {
    if (skipped()) return;
    const res = await asDevice(DEV_AX, `?${query}`);
    expect(res.status).toBe(400);
    conforms('Error', res.body);
  });
});
