/**
 * Jira RT-1576 (RT-1511 S1) — Available To Sell on `getOnHand`, against real Postgres (Testcontainers, every migration,
 * the NOBYPASSRLS `app_test` role).
 *
 * One test per acceptance criterion:
 *   1. only the primary location counts (A-1);
 *   2. an expired lot is excluded, the expiry day itself is not (A-1, 859, G7-5);
 *   3. an active reservation reduces ATS and a lapsed one does not (A-2);
 *   4. a transfer that is reserved and then dispatched reduces the source ATS exactly once (A-5, no double deduction);
 *   5. In Transit stays out of the destination ATS until it is received (A-6);
 *   6. a negative ATS is preserved (A-4);
 *   7. another tenant reads nothing (RLS).
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { Pool } from 'pg';

import { ErpnextPostingService } from '../../../src/catalog/erpnext-posting/erpnext-posting.service';
import { transferErpAdapter } from '../../../src/catalog/erpnext-posting/transfer-erp.adapter';
import type { MembershipRepository } from '../../../src/context/membership.repository';
import { InventoryService } from '../../../src/inventory/inventory.service';
import {
  ShipmentTransfersService,
  type TransferCaller,
  type TransferContext,
} from '../../../src/inventory/shipment-transfers/shipment-transfers.service';
import type { TransferBody } from '../../../src/inventory/shipment-transfers/shipment-transfer.store';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

const OWNER = ACTOR_A;
const BATCH_PRODUCT = '0a000000-0000-7000-8000-0000000d1b01';
const LOT_EXPIRED = '0a000000-0000-7000-8000-0000000d1c01';
const LOT_EXPIRES_TODAY = '0a000000-0000-7000-8000-0000000d1c02';
const LOT_VALID = '0a000000-0000-7000-8000-0000000d1c03';
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');
const DISPATCH_DOC = { doctype: 'Stock Entry', name: 'MAT-STE-2026-00099' };

let env: PgTestEnv | null = null;
let admin: Pool;
let inventory: InventoryService;
let transfers: ShipmentTransfersService;
let posting: ErpnextPostingService;
let primaryX = '';
let primaryY = '';
let storageX = '';
let seq = 0;

const skipped = (): boolean => env === null;
const nextId = (): string => `0a000000-0000-7000-8000-${(0xd2000000 + ++seq).toString(16).padStart(12, '0')}`;

const ctx: TransferContext = {
  userId: OWNER,
  tenantId: TENANT_A,
  storeId: null,
  isPlatformAdmin: false,
  source: 'session',
  storeAccess: { kind: 'all' },
};
const owner = (): TransferCaller => ({ tenantId: TENANT_A, userId: OWNER, context: ctx });

async function seedStock(
  storeId: string,
  quantity: string,
  opts: { productId?: string; location?: string; status?: string; identity?: string | null } = {},
): Promise<void> {
  const id = nextId();
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, received_at,
        created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status, tracking_identity_id)
     VALUES ($1, $2, $3, 'inbound', $4::numeric(19,4), 'each', $5, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
             $6, 'erp_external', 'erp_procurement_receipt', $1, $7, $8, $9)`,
    [
      id, TENANT_A, storeId, quantity, opts.productId ?? PRODUCT_A_ACTIVE, OWNER,
      opts.location ?? primaryX, opts.status ?? 'sellable', opts.identity ?? null,
    ],
  );
  await admin.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at)
     VALUES ($1, $2, 'external', '2020-01-01T00:00:00Z')`,
    [id, TENANT_A],
  );
}

async function seedReservation(quantity: string, expiresAt: string, productId = PRODUCT_A_ACTIVE): Promise<void> {
  await admin.query(
    `INSERT INTO inventory_reservations
       (id, tenant_id, store_id, stock_location_id, tenant_product_ref, quantity, expires_at, source_type, source_id,
        source_line_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::numeric(19,4), $7, 'transfer', $8, $9, $10)`,
    [nextId(), TENANT_A, STORE_A_X, primaryX, productId, quantity, expiresAt, nextId(), nextId(), OWNER],
  );
}

const ats = async (storeId = STORE_A_X, productId = PRODUCT_A_ACTIVE, tenantId = TENANT_A) =>
  (await inventory.getOnHand({ tenantId, storeId, productId })).availability;

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1576 available to sell');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'ats-owner@fixture.invalid', NULL) ON CONFLICT DO NOTHING`,
    [OWNER],
  );
  primaryX = (await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])).rows[0].id;
  primaryY = (await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_Y])).rows[0].id;
  storageX = nextId();
  await admin.query(
    `INSERT INTO stock_locations (id, tenant_id, store_id, code, name, kind) VALUES ($1, $2, $3, 'BACK', 'Back room', 'storage')`,
    [storageX, TENANT_A, STORE_A_X],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $2, 'ATS batch product', 'standard', $3, $3, 'batch') ON CONFLICT DO NOTHING`,
    [BATCH_PRODUCT, TENANT_A, OWNER],
  );
  await admin.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date) VALUES
       ($1, $4, $5, 'batch', 'ATS-EXPIRED', '2000-01-01'),
       ($2, $4, $5, 'batch', 'ATS-TODAY', (SELECT store_business_date($6))),
       ($3, $4, $5, 'batch', 'ATS-VALID', '2099-01-01')
     ON CONFLICT DO NOTHING`,
    [LOT_EXPIRED, LOT_EXPIRES_TODAY, LOT_VALID, TENANT_A, BATCH_PRODUCT, STORE_A_X],
  );
  await admin.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ITEM-A', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, OWNER],
  );
  const memberships = { findRoleCodeForUserInTenant: async () => 'owner' } as unknown as MembershipRepository;
  inventory = new InventoryService(env.app as unknown as Pool);
  transfers = new ShipmentTransfersService(env.app as unknown as Pool, memberships, transferErpAdapter);
  posting = new ErpnextPostingService(env.app as unknown as Pool);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (!env) return;
  await admin.query(`DELETE FROM transfer_posting_lines`);
  await admin.query(`DELETE FROM transfer_postings`);
  await admin.query(`DELETE FROM inventory_effect_integration WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`DELETE FROM erpnext_posting_status WHERE kind IN ('transfer_dispatch', 'transfer_receive')`);
  for (const t of [
    'shipment_transfer_discrepancies', 'shipment_transfer_receipt_lines', 'shipment_transfer_receipts',
    'shipment_transfer_lines', 'inventory_reservations', 'shipment_transfers',
  ]) {
    await admin.query(`DELETE FROM ${t}`);
  }
  await admin.query(`DELETE FROM stock_movements WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`DELETE FROM erpnext_warehouse_map WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref) VALUES
       (gen_random_uuid(), $1, $2, 'stock', 'Store X - T'), (gen_random_uuid(), $1, $3, 'stock', 'Store Y - T'),
       (gen_random_uuid(), $1, NULL, 'transit', 'Goods In Transit - T')`,
    [TENANT_A, STORE_A_X, STORE_A_Y],
  );
  await admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, shipment_transfers_enabled, updated_by) VALUES ($1, true, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET shipment_transfers_enabled = true`,
    [TENANT_A, OWNER],
  );
});

describe('empty position and shape', () => {
  it('reports zero ATS, the primary location, no On Order and an as-of instant', async () => {
    if (skipped()) return;
    const a = await ats();
    expect(a).toMatchObject({
      primaryLocationId: primaryX,
      primarySellable: '0.0000',
      expiredTrackedSellable: '0.0000',
      activeReserved: '0.0000',
      safetyProtection: '0.0000',
      availableToSell: '0.0000',
      inTransitInbound: '0.0000',
      inTransitOutbound: '0.0000',
      onOrder: null,
    });
    expect(Number.isNaN(Date.parse(a.asOf))).toBe(false);
  });
});

describe('A-1 primary location only', () => {
  it('counts the primary location and leaves a storage location and a non-sellable status out', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '10');
    await seedStock(STORE_A_X, '7', { location: storageX });
    await seedStock(STORE_A_X, '4', { status: 'quality_hold' });
    const onHand = await inventory.getOnHand({ tenantId: TENANT_A, storeId: STORE_A_X, productId: PRODUCT_A_ACTIVE });
    expect(onHand.quantity).toBe('21.0000');
    expect(onHand.sellableQuantity).toBe('17.0000');
    expect(onHand.availability.primarySellable).toBe('10.0000');
    expect(onHand.availability.availableToSell).toBe('10.0000');
  });
});

describe('A-1 expired tracked lots', () => {
  it('excludes a lot whose expiry is before the store business date, not the expiry day itself', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '5', { productId: BATCH_PRODUCT, identity: LOT_EXPIRED });
    await seedStock(STORE_A_X, '3', { productId: BATCH_PRODUCT, identity: LOT_EXPIRES_TODAY });
    await seedStock(STORE_A_X, '8', { productId: BATCH_PRODUCT, identity: LOT_VALID });
    const a = await ats(STORE_A_X, BATCH_PRODUCT);
    expect(a.primarySellable).toBe('16.0000');
    expect(a.expiredTrackedSellable).toBe('5.0000');
    expect(a.availableToSell).toBe('11.0000');
  });
});

describe('A-2 reservations', () => {
  it('an active reservation reduces ATS and a lapsed one does not', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '50');
    await seedReservation('12', '2099-01-01T00:00:00Z');
    await seedReservation('30', '2020-01-01T00:00:00Z'); // lapsed, never swept: still state 'active'
    const a = await ats();
    expect(a.primarySellable).toBe('50.0000');
    expect(a.activeReserved).toBe('12.0000');
    expect(a.availableToSell).toBe('38.0000');
  });
});

describe('A-4 negative ATS', () => {
  it('is reported as computed and never clamped', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '3');
    await seedReservation('10', '2099-01-01T00:00:00Z');
    expect((await ats()).availableToSell).toBe('-7.0000');
  });
});

describe('A-5 and A-6 transfers', () => {
  const approved = async (qty: string): Promise<TransferBody> => {
    await seedStock(STORE_A_X, '100');
    const t = await transfers.create(owner(), {
      sourceStoreId: STORE_A_X,
      destinationStoreId: STORE_A_Y,
      reason: 'rebalance',
      lines: [{ tenantProductRef: PRODUCT_A_ACTIVE, quantity: qty, stockingUnit: 'each', trackingIdentityId: null }],
    });
    await transfers.approve(owner(), t.id, FAR_FUTURE);
    return t;
  };

  it('reserved then dispatched reduces the source ATS exactly once', async () => {
    if (skipped()) return;
    const t = await approved('10');
    const reserved = await ats();
    expect(reserved).toMatchObject({ primarySellable: '100.0000', activeReserved: '10.0000', availableToSell: '90.0000' });

    await transfers.dispatch(owner(), t.id, 'on the truck');
    const sent = await ats();
    expect(sent).toMatchObject({
      primarySellable: '90.0000',
      activeReserved: '0.0000',
      availableToSell: '90.0000', // not 80: the reservation was consumed with the dispatch
      inTransitOutbound: '10.0000',
    });
  });

  it('keeps In Transit out of the destination ATS until it is received', async () => {
    if (skipped()) return;
    const t = await approved('10');
    const sent = await transfers.dispatch(owner(), t.id, 'on the truck');

    const before = await ats(STORE_A_Y);
    expect(before).toMatchObject({ primaryLocationId: primaryY, primarySellable: '0.0000', availableToSell: '0.0000', inTransitInbound: '10.0000' });

    const leg = await admin.query(`SELECT intent_id FROM transfer_postings WHERE transfer_id = $1 AND receipt_id IS NULL`, [t.id]);
    await posting.ackOutcome({ tenantId: TENANT_A, workItemRef: leg.rows[0].intent_id, outcome: 'posted', documentRef: DISPATCH_DOC } as never);
    await transfers.receive(owner(), t.id, {
      lines: [{ transferLineId: sent.lines[0]!.id, quantity: '10', disposition: 'sellable', stockLocationId: null }],
      note: null,
    });

    const after = await ats(STORE_A_Y);
    expect(after).toMatchObject({ primarySellable: '10.0000', availableToSell: '10.0000', inTransitInbound: '0.0000' });
    expect((await ats()).inTransitOutbound).toBe('0.0000');
  });
});

describe('tenant isolation (RLS)', () => {
  it("reads nothing of another tenant's store or product", async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '10');
    await expect(ats(STORE_A_X, PRODUCT_A_ACTIVE, TENANT_B)).rejects.toMatchObject({ status: 404 });
  });
});
