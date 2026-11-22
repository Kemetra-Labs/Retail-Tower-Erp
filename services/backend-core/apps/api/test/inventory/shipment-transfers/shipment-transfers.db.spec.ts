/**
 * Jira RT-1513 — the shipment Transfer lifecycle, its effects, reservations and ERP legs, against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 *
 * Proves, per the issue's acceptance criteria:
 *   1. each leg is replay-safe (888, 889): one `transfer_dispatch` per Transfer, one `transfer_receive` per receipt;
 *   2. no double deduction: reserve + dispatch moves the source quantity ONCE (the reservation is consumed);
 *   3. no fabricated quantity on a short receipt (the open quantity stays In Transit; a short-close records a loss);
 *   4. RLS isolation across tenants;
 *   5. partial receipt x2, damaged, short-close, over-receipt refusal, cancel before dispatch, the legal-entity seam
 *      and the reachable cross-tenant refusal, and dispatch-before-receipt ordering (a receipt leg is released only after
 *      its dispatch is confirmed, and carries the dispatch document);
 *   6. the dark switch (404), the legacy 409, reservation expiry (audited, back to draft) and the activation switch.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { runWithTenantContext } from '@data-pulse-2/db';
import { Pool } from 'pg';

import { ErpnextPostingService } from '../../../src/catalog/erpnext-posting/erpnext-posting.service';
import type { FeedWorkItem } from '../../../src/catalog/erpnext-posting/posting-work-item.projection';
import { canonicalJson } from '../../../src/common/hashing/canonical-json';
import type { MembershipRepository } from '../../../src/context/membership.repository';
import { listLegacyTransferDrift, readShipmentTransferHealth } from '../../../src/inventory';
import { StockTransferService } from '../../../src/inventory/stock-transfer.service';
import {
  ShipmentTransferActivationService,
} from '../../../src/inventory/shipment-transfers/shipment-transfer-activation.service';
import {
  ShipmentTransfersService,
  type CreateTransferInput,
  type TransferCaller,
  type TransferContext,
} from '../../../src/inventory/shipment-transfers/shipment-transfers.service';
import type { TransferBody } from '../../../src/inventory/shipment-transfers/shipment-transfer.store';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

const OWNER = ACTOR_A;
const MANAGER_X = '0a000000-0000-7000-8000-0000000c1a01';
const MANAGER_Y = '0a000000-0000-7000-8000-0000000c1a02';
const BATCH_PRODUCT = '0a000000-0000-7000-8000-0000000c1b01';
const SERIAL_PRODUCT = '0a000000-0000-7000-8000-0000000c1b02';
const IDENTITY = '0a000000-0000-7000-8000-0000000c1c01';
const DISPATCH_DOC = { doctype: 'Stock Entry', name: 'MAT-STE-2026-00042' };
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

let env: PgTestEnv | null = null;
let admin: Pool;
let svc: ShipmentTransfersService;
let legacy: StockTransferService;
let posting: ErpnextPostingService;
let activation: ShipmentTransferActivationService;
let role = 'owner';
let primaryX = '';
let primaryY = '';

const skipped = (): boolean => env === null;

const ctxFor = (userId: string, access: NonNullable<TransferContext['storeAccess']>, tenantId = TENANT_A): TransferContext => ({
  userId,
  tenantId,
  storeId: null,
  isPlatformAdmin: false,
  source: 'session',
  storeAccess: access,
});
const owner = (): TransferCaller => ({ tenantId: TENANT_A, userId: OWNER, context: ctxFor(OWNER, { kind: 'all' }) });
const managerOf = (userId: string, ...storeIds: string[]): TransferCaller => ({
  tenantId: TENANT_A,
  userId,
  context: ctxFor(userId, { kind: 'specific', storeIds }),
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    return (r as { code?: string } | undefined)?.code ?? (e as Error).constructor.name;
  }
  return 'ok';
}

async function onHand(storeId: string, productId = PRODUCT_A_ACTIVE, status?: string): Promise<string> {
  const r = await admin.query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS q FROM stock_movements
      WHERE store_id = $1 AND tenant_product_ref = $2 AND ($3::text IS NULL OR inventory_status = $3)`,
    [storeId, productId, status ?? null],
  );
  return r.rows[0].q as string;
}

async function seedStock(storeId: string, quantity: string, productId = PRODUCT_A_ACTIVE, location = primaryX): Promise<void> {
  const id = `0a000000-0000-7000-8000-${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`;
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, received_at,
        created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, 'inbound', $4::numeric(19,4), 'each', $5, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
             $6, 'erp_external', 'erp_procurement_receipt', $1, $7, 'sellable')`,
    [id, TENANT_A, storeId, quantity, productId, OWNER, location],
  );
  await admin.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at)
     VALUES ($1, $2, 'external', '2020-01-01T00:00:00Z')`,
    [id, TENANT_A],
  );
}

const draft = (over: Partial<CreateTransferInput> = {}, qty = '10'): CreateTransferInput => ({
  sourceStoreId: STORE_A_X,
  destinationStoreId: STORE_A_Y,
  reason: 'rebalance',
  lines: [{ tenantProductRef: PRODUCT_A_ACTIVE, quantity: qty, stockingUnit: 'each', trackingIdentityId: null }],
  ...over,
});

async function dispatched(qty = '10'): Promise<TransferBody> {
  await seedStock(STORE_A_X, '100');
  const t = await svc.create(owner(), draft({}, qty));
  await svc.approve(owner(), t.id, FAR_FUTURE);
  return await svc.dispatch(owner(), t.id, 'on the truck');
}

const recv = (t: TransferBody, qty: string, over: Record<string, unknown> = {}) => ({
  lines: [{ transferLineId: t.lines[0]!.id, quantity: qty, disposition: 'sellable', stockLocationId: null, ...over }],
  note: null,
});

async function confirmDispatch(transferId: string): Promise<string> {
  const leg = await admin.query(
    `SELECT intent_id FROM transfer_postings WHERE transfer_id = $1 AND receipt_id IS NULL`,
    [transferId],
  );
  const id = leg.rows[0].intent_id as string;
  await posting.ackOutcome({ tenantId: TENANT_A, workItemRef: id, outcome: 'posted', documentRef: DISPATCH_DOC } as never);
  return id;
}

const legs = async (transferId: string): Promise<Array<{ id: string; kind: string; external_id: string; status: string; receipt_id: string | null }>> =>
  (
    await admin.query(
      `SELECT p.id, p.kind, p.external_id, p.status, tp.receipt_id
         FROM transfer_postings tp JOIN erpnext_posting_status p ON p.id = tp.intent_id
        WHERE tp.transfer_id = $1 ORDER BY p.sequence`,
      [transferId],
    )
  ).rows;

const audits = async (transferId: string): Promise<string[]> =>
  (await admin.query(`SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at, id`, [transferId])).rows.map(
    (r) => r.action as string,
  );

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1513 shipment transfers');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'st-owner@fixture.invalid', NULL), ($2, 'st-mx@fixture.invalid', NULL),
            ($3, 'st-my@fixture.invalid', NULL) ON CONFLICT DO NOTHING`,
    [OWNER, MANAGER_X, MANAGER_Y],
  );
  primaryX = (await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])).rows[0].id;
  primaryY = (await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_Y])).rows[0].id;
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $3, 'Batch product', 'standard', $4, $4, 'batch'), ($2, $3, 'Serial product', 'standard', $4, $4, 'serial')
     ON CONFLICT DO NOTHING`,
    [BATCH_PRODUCT, SERIAL_PRODUCT, TENANT_A, OWNER],
  );
  await admin.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $2, $3, 'batch', 'LOT-1', '2099-01-01') ON CONFLICT DO NOTHING`,
    [IDENTITY, TENANT_A, BATCH_PRODUCT],
  );
  await admin.query(
    `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref) VALUES ($1, $2, 'batch', 'LOT-1-ERP')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, IDENTITY],
  );
  for (const [product, ref] of [
    [PRODUCT_A_ACTIVE, 'ITEM-A'],
    [BATCH_PRODUCT, 'ITEM-BATCH'],
  ] as const) {
    await admin.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now()) ON CONFLICT DO NOTHING`,
      [TENANT_A, product, ref, OWNER],
    );
  }
  const memberships = { findRoleCodeForUserInTenant: async () => role } as unknown as MembershipRepository;
  svc = new ShipmentTransfersService(env.app as unknown as Pool, memberships);
  legacy = new StockTransferService(env.app as unknown as Pool);
  posting = new ErpnextPostingService(env.app as unknown as Pool);
  activation = new ShipmentTransferActivationService(env.app as unknown as Pool, memberships);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  role = 'owner';
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
  await admin.query(`DELETE FROM tracking_holds WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, shipment_transfers_enabled, updated_by) VALUES ($1, true, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET shipment_transfers_enabled = true`,
    [TENANT_A, OWNER],
  );
});

describe('dark by default and tenant isolation', () => {
  it('answers the non-disclosing 404 until the tenant is switched on', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    expect(await codeOf(svc.create(owner(), draft()))).toBe('NotFoundException');
    expect(await codeOf(svc.list(owner(), { storeId: null, direction: 'any', state: null }, null, 10))).toBe('NotFoundException');
  });

  it("never shows one tenant's Transfer to another (RLS)", async () => {
    if (skipped()) return;
    await admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, shipment_transfers_enabled, updated_by) VALUES ($1, true, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET shipment_transfers_enabled = true`,
      [TENANT_B, ACTOR_B],
    );
    const t = await svc.create(owner(), draft());
    const other: TransferCaller = { tenantId: TENANT_B, userId: ACTOR_B, context: ctxFor(ACTOR_B, { kind: 'all' }, TENANT_B) };
    expect(await codeOf(svc.get(other, t.id))).toBe('NotFoundException');
    expect((await svc.list(other, { storeId: null, direction: 'any', state: null }, null, 10)).items).toHaveLength(0);
  });
});

describe('create (Draft)', () => {
  it('reserves nothing and changes no quantity', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '100');
    const t = await svc.create(owner(), draft());
    expect(t.state).toBe('draft');
    expect(t.lines[0]).toMatchObject({ lineSeq: 1, quantity: '10.0000', inTransitQuantity: '0.0000', dispatchedQuantity: '0.0000' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM inventory_reservations`)).rows[0].n).toBe(0);
    expect(await onHand(STORE_A_X)).toBe('100.0000');
  });

  it('refuses one store, a store of another tenant (nothing written), a duplicate line and serial products', async () => {
    if (skipped()) return;
    expect(await codeOf(svc.create(owner(), draft({ destinationStoreId: STORE_A_X })))).toBe('validation_error');
    expect(await codeOf(svc.create(owner(), draft({ destinationStoreId: STORE_B_X })))).toBe('NotFoundException');
    const dup = draft();
    expect(await codeOf(svc.create(owner(), { ...dup, lines: [dup.lines[0]!, dup.lines[0]!] }))).toBe('validation_error');
    const serial = draft({ lines: [{ tenantProductRef: SERIAL_PRODUCT, quantity: '1', stockingUnit: 'each', trackingIdentityId: null }] });
    expect(await codeOf(svc.create(owner(), serial))).toBe('serial_transfer_not_supported');
    expect((await admin.query(`SELECT count(*)::int AS n FROM shipment_transfers`)).rows[0].n).toBe(0);
  });

  it('a tracked line needs its identity (G7-4)', async () => {
    if (skipped()) return;
    const noIdentity = draft({ lines: [{ tenantProductRef: BATCH_PRODUCT, quantity: '2', stockingUnit: 'each', trackingIdentityId: null }] });
    expect(await codeOf(svc.create(owner(), noIdentity))).toBe('tracking_identity_required');
    const ok = draft({ lines: [{ tenantProductRef: BATCH_PRODUCT, quantity: '2', stockingUnit: 'each', trackingIdentityId: IDENTITY }] });
    expect((await svc.create(owner(), ok)).lines[0]!.trackingIdentityId).toBe(IDENTITY);
  });

  it('refuses a quantity an ERP leg cannot carry (14 integer digits)', async () => {
    if (skipped()) return;
    expect(await codeOf(svc.create(owner(), draft({}, '12345678901234')))).toBe('validation_error');
  });
});

describe('approve and cancel (reservations)', () => {
  it('approval reserves the source stock without moving a quantity, and is never refused for lack of stock (743)', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '3');
    const t = await svc.create(owner(), draft({}, '10'));
    const a = await svc.approve(owner(), t.id, FAR_FUTURE);
    expect(a.state).toBe('approved');
    expect(a.reservation).toMatchObject({ reservedBy: OWNER, releasedAt: null });
    expect(await onHand(STORE_A_X)).toBe('3.0000');
    const rows = (await admin.query(`SELECT quantity::text AS q, state, source_type FROM inventory_reservations`)).rows;
    expect(rows).toEqual([{ q: '10.0000', state: 'active', source_type: 'transfer' }]);
    const meta = (await admin.query(`SELECT metadata FROM audit_events WHERE target_id = $1 AND action LIKE '%approve'`, [t.id])).rows[0].metadata;
    expect(meta.availableToSellNegative).toBe(true);
  });

  it('refuses an expiry in the past, and an unmapped transit warehouse or item (fail closed, nothing reserved)', async () => {
    if (skipped()) return;
    const t = await svc.create(owner(), draft());
    expect(await codeOf(svc.approve(owner(), t.id, new Date('2000-01-01T00:00:00Z')))).toBe('validation_error');
    await admin.query(`DELETE FROM erpnext_warehouse_map WHERE purpose = 'transit'`);
    expect(await codeOf(svc.approve(owner(), t.id, FAR_FUTURE))).toBe('transfer_warehouse_unmapped');
    await admin.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref) VALUES (gen_random_uuid(), $1, NULL, 'transit', 'Goods In Transit - T')`,
      [TENANT_A],
    );
    await admin.query(`UPDATE erpnext_item_map SET retired_at = now() WHERE tenant_product_id = $1`, [PRODUCT_A_ACTIVE]);
    expect(await codeOf(svc.approve(owner(), t.id, FAR_FUTURE))).toBe('transfer_item_unmapped');
    await admin.query(`UPDATE erpnext_item_map SET retired_at = NULL WHERE tenant_product_id = $1`, [PRODUCT_A_ACTIVE]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM inventory_reservations`)).rows[0].n).toBe(0);
  });

  it('a held identity cannot be sent (G7-4)', async () => {
    if (skipped()) return;
    await admin.query(
      `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, placed_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'quality_hold', 'inspection', $4)`,
      [TENANT_A, IDENTITY, BATCH_PRODUCT, OWNER],
    );
    const t = await svc.create(owner(), draft({ lines: [{ tenantProductRef: BATCH_PRODUCT, quantity: '2', stockingUnit: 'each', trackingIdentityId: IDENTITY }] }));
    expect(await codeOf(svc.approve(owner(), t.id, FAR_FUTURE))).toBe('tracking_identity_held_or_expired');
  });

  it('cancel before dispatch releases the reservation by an audited event and changes no quantity', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '100');
    const t = await svc.create(owner(), draft());
    await svc.approve(owner(), t.id, FAR_FUTURE);
    const c = await svc.cancel(owner(), t.id, 'changed our mind');
    expect(c.state).toBe('cancelled');
    expect(c.cancellation).toMatchObject({ cancelledBy: OWNER, reason: 'changed our mind' });
    expect((await admin.query(`SELECT state FROM inventory_reservations`)).rows.map((r) => r.state)).toEqual(['released']);
    expect(await onHand(STORE_A_X)).toBe('100.0000');
    expect(await audits(t.id)).toEqual(expect.arrayContaining(['inventory.shipment_transfer.create', 'inventory.shipment_transfer.approve', 'inventory.shipment_transfer.cancel']));
  });

  it('cancel after dispatch is refused (goods already left the source)', async () => {
    if (skipped()) return;
    const t = await dispatched();
    expect(await codeOf(svc.cancel(owner(), t.id, 'too late'))).toBe('shipment_transfer_not_in_state');
  });

  it('an expired reservation is released by an audited event and the Transfer returns to draft; dispatch is then refused (798)', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '100');
    const t = await svc.create(owner(), draft());
    await svc.approve(owner(), t.id, FAR_FUTURE);
    await admin.query(`UPDATE shipment_transfers SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    await admin.query(`UPDATE inventory_reservations SET expires_at = now() - interval '1 minute'`);
    expect(await codeOf(svc.dispatch(owner(), t.id, null))).toBe('shipment_transfer_not_in_state');
    const g = await svc.get(owner(), t.id);
    expect(g).toMatchObject({ state: 'draft', approval: null, reservation: null });
    expect((await admin.query(`SELECT state FROM inventory_reservations`)).rows.map((r) => r.state)).toEqual(['expired']);
    expect(await audits(t.id)).toContain('inventory.shipment_transfer.reservation_expired');
    expect(await onHand(STORE_A_X)).toBe('100.0000');
  });
});

describe('dispatch (no double deduction, replay-safe leg)', () => {
  it('deducts the source ONCE, consumes the reservation and moves the goods In Transit', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    expect(t.state).toBe('in_transit');
    expect(t.lines[0]).toMatchObject({ dispatchedQuantity: '10.0000', receivedQuantity: '0.0000', inTransitQuantity: '10.0000' });
    expect(t.dispatchIntegrationState).toBe('pending');
    // 100 on hand - 10 sent = 90, once: the reservation (10) is NOT also deducted.
    expect(await onHand(STORE_A_X)).toBe('90.0000');
    expect(await onHand(STORE_A_Y)).toBe('0.0000');
    expect((await admin.query(`SELECT state FROM inventory_reservations`)).rows.map((r) => r.state)).toEqual(['consumed']);
    const out = (await admin.query(`SELECT movement_type, quantity::text AS q, event_type, event_ref_id FROM stock_movements WHERE movement_type = 'transfer_out'`)).rows;
    expect(out).toEqual([{ movement_type: 'transfer_out', q: '-10.0000', event_type: 'transfer', event_ref_id: t.id }]);
  });

  it('writes ONE transfer_dispatch work item with the leg key, in the same transaction as the effect, linked pending', async () => {
    if (skipped()) return;
    const t = await dispatched();
    const l = await legs(t.id);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ kind: 'transfer_dispatch', external_id: `transfer_dispatch:${t.id}`, status: 'pending', receipt_id: null });
    const eff = (await admin.query(`SELECT state, posting_status_id FROM inventory_effect_integration WHERE effect_id = $1`, [t.lines[0]!.dispatchMovementId])).rows[0];
    expect(eff).toEqual({ state: 'pending', posting_status_id: l[0]!.id });
  });

  it('a replay changes nothing: a second dispatch is refused and no second leg or movement exists (888)', async () => {
    if (skipped()) return;
    const t = await dispatched();
    expect(await codeOf(svc.dispatch(owner(), t.id, null))).toBe('shipment_transfer_not_in_state');
    expect(await legs(t.id)).toHaveLength(1);
    expect(await onHand(STORE_A_X)).toBe('90.0000');
    // The database backstop: the same leg key cannot be inserted twice (migration 0126).
    await expect(
      admin.query(
        `INSERT INTO erpnext_posting_status (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status)
         VALUES (gen_random_uuid(), $1, $2, NULL, 'transfer_dispatch', gen_random_uuid(), 'retail-tower', $3, repeat('a', 64), 'pending')`,
        [TENANT_A, STORE_A_X, `transfer_dispatch:${t.id}`],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('receipts: partial x2, damaged, short, over', () => {
  it('records two partial receipts and ends received, with no receipt leg before the dispatch is confirmed', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    const r1 = await svc.receive(owner(), t.id, recv(t, '4'));
    expect(r1.transfer).toMatchObject({ state: 'partially_received', receiptCount: 1 });
    expect(r1.transfer.lines[0]).toMatchObject({ receivedQuantity: '4.0000', inTransitQuantity: '6.0000' });
    expect(r1.receipt.integrationState).toBe('not_posted');
    const r2 = await svc.receive(owner(), t.id, recv(t, '6'));
    expect(r2.transfer).toMatchObject({ state: 'received', receiptCount: 2 });
    expect(r2.transfer.lines[0]!.inTransitQuantity).toBe('0.0000');
    expect(await onHand(STORE_A_Y)).toBe('10.0000');
    expect((await legs(t.id)).map((x) => x.kind)).toEqual(['transfer_dispatch']);
    const page = await svc.listReceipts(owner(), t.id, null, 10);
    expect(page.items.map((r) => r.id)).toEqual([r1.receipt.id, r2.receipt.id]);
  });

  it('lands a damaged receipt in the damaged status at the destination (811)', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    const r = await svc.receive(owner(), t.id, recv(t, '3', { disposition: 'damaged' }));
    expect(r.receipt.lines[0]!.inventoryStatus).toBe('damaged');
    expect(await onHand(STORE_A_Y, PRODUCT_A_ACTIVE, 'damaged')).toBe('3.0000');
    expect(await onHand(STORE_A_Y, PRODUCT_A_ACTIVE, 'sellable')).toBe('0.0000');
  });

  it('refuses an over-receipt and writes nothing (813, O5)', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    expect(await codeOf(svc.receive(owner(), t.id, recv(t, '11')))).toBe('over_receipt_requires_approval');
    const after = await svc.get(owner(), t.id);
    expect(after).toMatchObject({ state: 'in_transit', receiptCount: 0 });
    expect(await onHand(STORE_A_Y)).toBe('0.0000');
    await svc.receive(owner(), t.id, recv(t, '10'));
    expect(await codeOf(svc.receive(owner(), t.id, recv(t, '1')))).toBe('shipment_transfer_not_in_state');
  });

  it('a short receipt fabricates nothing: the open quantity stays In Transit', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    const r = await svc.receive(owner(), t.id, recv(t, '7'));
    expect(r.transfer.lines[0]).toMatchObject({ receivedQuantity: '7.0000', inTransitQuantity: '3.0000', shortClosedQuantity: '0.0000' });
    expect(await onHand(STORE_A_Y)).toBe('7.0000');
  });

  it('a receipt of a held identity lands in the hold status (G7-4)', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '10', BATCH_PRODUCT);
    const t = await svc.create(owner(), draft({ lines: [{ tenantProductRef: BATCH_PRODUCT, quantity: '2', stockingUnit: 'each', trackingIdentityId: IDENTITY }] }));
    await svc.approve(owner(), t.id, FAR_FUTURE);
    const d = await svc.dispatch(owner(), t.id, null);
    await admin.query(
      `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, placed_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'quality_hold', 'inspection', $4)`,
      [TENANT_A, IDENTITY, BATCH_PRODUCT, OWNER],
    );
    const r = await svc.receive(owner(), d.id, recv(d, '2'));
    expect(r.receipt.lines[0]!.inventoryStatus).toBe('quality_hold');
  });

  it('a receipt lands only at the destination store: the source manager cannot receive', async () => {
    if (skipped()) return;
    role = 'store_manager';
    const t = await dispatched();
    expect(await codeOf(svc.receive(managerOf(MANAGER_X, STORE_A_X), t.id, recv(t, '1')))).toBe('forbidden');
    const r = await svc.receive(managerOf(MANAGER_Y, STORE_A_Y), t.id, recv(t, '1'));
    expect(r.transfer.state).toBe('partially_received');
  });
});

describe('dispatch-before-receipt ordering (886, 889)', () => {
  it('releases each waiting receipt leg only when the dispatch is confirmed, carrying the dispatch document', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    const r1 = await svc.receive(owner(), t.id, recv(t, '4'));
    const r2 = await svc.receive(owner(), t.id, recv(t, '6'));
    const dispatchId = await confirmDispatch(t.id);
    const all = await legs(t.id);
    expect(all.map((l) => l.kind)).toEqual(['transfer_dispatch', 'transfer_receive', 'transfer_receive']);
    expect(all.slice(1).map((l) => l.external_id)).toEqual([`transfer_receipt:${r1.receipt.id}`, `transfer_receipt:${r2.receipt.id}`]);
    const posted = await admin.query(`SELECT dispatch_document_ref FROM transfer_postings WHERE receipt_id IS NOT NULL`);
    expect(posted.rows.map((r) => JSON.parse(r.dispatch_document_ref))).toEqual([DISPATCH_DOC, DISPATCH_DOC]);
    // The receipt legs are pending and the dispatch effect is confirmed: an ack changes integration state, never quantity.
    const states = (await admin.query(`SELECT state FROM inventory_effect_integration WHERE effect_id = $1`, [t.lines[0]!.dispatchMovementId])).rows[0].state;
    expect(states).toBe('confirmed');
    expect((await svc.listReceipts(owner(), t.id, null, 10)).items.map((r) => r.integrationState)).toEqual(['pending', 'pending']);
    expect((await svc.get(owner(), t.id)).state).toBe('received');
    expect(await onHand(STORE_A_Y)).toBe('10.0000');
    // The dispatch ack is replayed: it echoes, and releases nothing twice (889).
    const replay = await posting.ackOutcome({ tenantId: TENANT_A, workItemRef: dispatchId, outcome: 'posted', documentRef: DISPATCH_DOC } as never);
    expect(replay.replayed).toBe(true);
    expect(await legs(t.id)).toHaveLength(3);
  });

  it('writes the receipt leg in the receipt transaction when the dispatch is already confirmed', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    await confirmDispatch(t.id);
    const r = await svc.receive(owner(), t.id, recv(t, '5'));
    const all = await legs(t.id);
    expect(all.map((l) => l.kind)).toEqual(['transfer_dispatch', 'transfer_receive']);
    expect(all[1]!.external_id).toBe(`transfer_receipt:${r.receipt.id}`);
    expect(r.receipt.integrationState).toBe('pending');
  });

  it('the feed offers the dispatch, and the receipt only after confirmation, in the contract wire shape', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    await svc.receive(owner(), t.id, recv(t, '4'));
    const first = await posting.pullPostings<FeedWorkItem>({ tenantId: TENANT_A, since: null, limit: 500 });
    const dispatchItem = first.items.find((i) => i.kind === 'transfer_dispatch');
    expect(first.items.map((i) => i.kind)).toEqual(['transfer_dispatch']);
    expect(dispatchItem).toMatchObject({ externalId: `transfer_dispatch:${t.id}`, sourceSystem: 'retail-tower' });
    const body = (dispatchItem as { transfer: Record<string, unknown> }).transfer;
    expect(body).toMatchObject({
      transferRef: t.id, sourceStoreId: STORE_A_X, destinationStoreId: STORE_A_Y,
      sourceWarehouseRef: { doctype: 'Warehouse', name: 'Store X - T' },
      transitWarehouseRef: { doctype: 'Warehouse', name: 'Goods In Transit - T' },
      lines: [{ lineSeq: 1, erpnextItemRef: { doctype: 'Item', name: 'ITEM-A' }, erpnextBatchRef: null, quantity: '10.0000', unit: 'each' }],
    });
    expect(body['postingDatetime']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // The offered body hashes to the stored payload hash: it is rebuilt from the frozen rows only.
    expect((dispatchItem as { payloadHash: string }).payloadHash).toBe(createHash('sha256').update(canonicalJson(body)).digest('hex'));
    await confirmDispatch(t.id);
    const second = await posting.pullPostings<FeedWorkItem>({ tenantId: TENANT_A, since: first.cursor === null ? null : BigInt(first.cursor), limit: 500 });
    const receive = second.items.find((i) => i.kind === 'transfer_receive') as { receipt: Record<string, unknown>; payloadHash: string; externalId: string };
    expect(receive.receipt).toMatchObject({
      transferRef: t.id, dispatchDocumentRef: DISPATCH_DOC,
      destinationWarehouseRef: { doctype: 'Warehouse', name: 'Store Y - T' },
      lines: [{ lineSeq: 1, dispatchLineSeq: 1, quantity: '4.0000' }],
    });
    expect(receive.payloadHash).toBe(createHash('sha256').update(canonicalJson(receive.receipt)).digest('hex'));
    // The new leg sits past the Connector's cursor: a held leg could never be skipped.
    const seq = (await admin.query(`SELECT external_id, sequence::text AS s FROM erpnext_posting_status WHERE kind IN ('transfer_dispatch','transfer_receive')`)).rows;
    const of = (prefix: string): bigint => BigInt(seq.find((r) => (r.external_id as string).startsWith(prefix))!.s as string);
    expect(of('transfer_receipt:')).toBeGreaterThan(of('transfer_dispatch:'));
    expect(BigInt(second.items[0]!.itemCursor)).toBeGreaterThan(BigInt(first.cursor!));
  });
});

describe('close and short-close (812)', () => {
  it('closes a fully received Transfer with no reason', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    await svc.receive(owner(), t.id, recv(t, '10'));
    const c = await svc.close(owner(), t.id, null);
    expect(c).toMatchObject({ state: 'closed', shortClose: null });
    expect(c.closure).toMatchObject({ by: OWNER });
  });

  it('refuses to close while quantity is in transit without a reason', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    expect(await codeOf(svc.close(owner(), t.id, null))).toBe('short_close_reason_required');
  });

  it('short-closes what is still in transit as an approved loss, fabricating nothing, with no ERP leg (drift listed)', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    await svc.receive(owner(), t.id, recv(t, '4'));
    const c = await svc.close(owner(), t.id, 'lost in transit');
    expect(c.state).toBe('closed');
    expect(c.shortClose).toMatchObject({ approvedBy: OWNER, reason: 'lost in transit' });
    expect(c.lines[0]).toMatchObject({ receivedQuantity: '4.0000', shortClosedQuantity: '6.0000', inTransitQuantity: '0.0000' });
    // Only the 4 that arrived are at the destination: the 6 written off are NOT fabricated into stock.
    expect(await onHand(STORE_A_Y)).toBe('4.0000');
    const disc = (await admin.query(`SELECT quantity::text AS q, reason, erp_state FROM shipment_transfer_discrepancies`)).rows;
    expect(disc).toEqual([{ q: '6.0000', reason: 'lost in transit', erp_state: 'not_emitted' }]);
    // The ERP leg of a short-close is not decided: nothing but the dispatch leg exists.
    expect((await legs(t.id)).map((x) => x.kind)).toEqual(['transfer_dispatch']);
  });

  it('a short-close needs the discrepancy capability: a store_manager is forbidden, a fully received close is allowed', async () => {
    if (skipped()) return;
    role = 'store_manager';
    const t = await dispatched('10');
    expect(await codeOf(svc.close(managerOf(MANAGER_Y, STORE_A_Y), t.id, 'lost'))).toBe('forbidden');
    await svc.receive(managerOf(MANAGER_Y, STORE_A_Y), t.id, recv(t, '10'));
    expect((await svc.close(managerOf(MANAGER_Y, STORE_A_Y), t.id, null)).state).toBe('closed');
  });
});

describe('authority (962) and the same person (owner decision 2026-11-19)', () => {
  it('a store_manager acts for its own store only; an unrelated store sees a non-disclosing 404', async () => {
    if (skipped()) return;
    role = 'store_manager';
    const t = await svc.create(managerOf(MANAGER_X, STORE_A_X, STORE_A_Y), draft());
    expect(await codeOf(svc.approve(managerOf(MANAGER_Y, STORE_A_Y), t.id, FAR_FUTURE))).toBe('forbidden');
    const outsider = managerOf(MANAGER_Y, STORE_B_X);
    expect(await codeOf(svc.get(outsider, t.id))).toBe('NotFoundException');
    expect((await svc.list(outsider, { storeId: null, direction: 'any', state: null }, null, 10)).items).toHaveLength(0);
  });

  it('one person may create, approve and dispatch: each step is audited with its actor', async () => {
    if (skipped()) return;
    const t = await dispatched();
    expect(await audits(t.id)).toEqual([
      'inventory.shipment_transfer.create', 'inventory.shipment_transfer.approve', 'inventory.shipment_transfer.dispatch',
    ]);
    const metas = (await admin.query(`SELECT actor_user_id, metadata FROM audit_events WHERE target_id = $1`, [t.id])).rows;
    expect(metas.every((m) => m.actor_user_id === OWNER && m.metadata.selfActioned === true)).toBe(true);
  });

  it('lists newest first with keyset pages, filtered by store direction and state', async () => {
    if (skipped()) return;
    const a = await svc.create(owner(), draft());
    const b = await svc.create(owner(), draft());
    const p1 = await svc.list(owner(), { storeId: STORE_A_X, direction: 'outbound', state: 'draft' }, null, 1);
    expect(p1.items.map((x) => x.id)).toEqual([b.id]);
    const p2 = await svc.list(owner(), { storeId: STORE_A_X, direction: 'outbound', state: 'draft' }, p1.nextCursor, 1);
    expect(p2.items.map((x) => x.id)).toEqual([a.id]);
    expect(p2.nextCursor).toBeNull();
    expect((await svc.list(owner(), { storeId: STORE_A_X, direction: 'inbound', state: null }, null, 10)).items).toHaveLength(0);
    expect(await codeOf(svc.list(owner(), { storeId: STORE_A_X, direction: 'outbound', state: null }, p1.nextCursor, 1))).toBe('validation_error');
  });
});

describe('legacy instant transfer (976, 970)', () => {
  const legacyInput = {
    tenantId: TENANT_A, userId: OWNER, sourceStoreId: STORE_A_X, destinationStoreId: STORE_A_Y,
    tenantProductRef: PRODUCT_A_ACTIVE, quantity: '1', stockingUnit: 'each', reason: null,
  } as never;

  it('still works while the tenant has not activated shipment transfers', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    expect(await codeOf(legacy.createStockTransfer(legacyInput))).toBe('ok');
  });

  it('answers 409 transfer_workflow_required once activated, and writes nothing', async () => {
    if (skipped()) return;
    expect(await codeOf(legacy.createStockTransfer(legacyInput))).toBe('transfer_workflow_required');
    expect((await admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE movement_type IN ('transfer_out','transfer_in')`)).rows[0].n).toBe(0);
  });
});

describe('the activation switch (fails closed)', () => {
  const admin_ = { tenantId: TENANT_A, userId: OWNER, isPlatformAdmin: false };

  async function connectorEvidence(kinds: string[] | null, role_: string | null): Promise<void> {
    await admin.query(`DELETE FROM connector_health WHERE tenant_id = $1`, [TENANT_A]);
    await admin.query(`DELETE FROM connector_registration WHERE tenant_id = $1`, [TENANT_A]);
    const reg = '0c200000-0000-7000-8000-00000c1300a1';
    await admin.query(
      `INSERT INTO connector_registration (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
       VALUES ($1, $2, 'T', 'erp-t.test', 'pilot', $3)`,
      [reg, TENANT_A, OWNER],
    );
    await admin.query(
      `INSERT INTO connector_health (id, tenant_id, connector_registration_id, last_seen_at, accepted_work_item_kinds,
                                     back_dated_role_status, back_dated_role_reported_at)
       VALUES (gen_random_uuid(), $1, $2, now(), $3::text[], $4, now())`,
      [TENANT_A, reg, kinds, role_],
    );
  }

  it('refuses to switch on while the Connector has not reported the transfer kinds, then switches on when ready', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    await connectorEvidence(['sale_post', 'reversal', 'inventory_count'], 'verified');
    expect(await codeOf(activation.setEnabled(admin_, true))).toBe('shipment_transfers_readiness_unmet');
    expect((await activation.getState(admin_)).unmetReadiness.map((u) => u.code)).toEqual(['connector_version_unlisted']);
    await connectorEvidence(['sale_post', 'reversal', 'inventory_count', 'transfer_dispatch', 'transfer_receive'], 'verified');
    const on = await activation.setEnabled(admin_, true);
    expect(on).toMatchObject({ enabled: true, changedBy: OWNER, delayedTransferThresholdDays: 3, unmetReadiness: [] });
    expect(await audits(TENANT_A)).toContain('inventory.shipment_transfers.update');
  });

  it('is refused without a transit warehouse, and switching off is refused while a Transfer is in flight', async () => {
    if (skipped()) return;
    await connectorEvidence(['transfer_dispatch', 'transfer_receive'], 'verified');
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    await admin.query(`DELETE FROM erpnext_warehouse_map WHERE purpose = 'transit'`);
    expect(await codeOf(activation.setEnabled(admin_, true))).toBe('shipment_transfers_readiness_unmet');
    await admin.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref) VALUES (gen_random_uuid(), $1, NULL, 'transit', 'Goods In Transit - T')`,
      [TENANT_A],
    );
    await activation.setEnabled(admin_, true);
    await svc.create(owner(), draft());
    expect(await codeOf(activation.setEnabled(admin_, false))).toBe('shipment_transfers_in_flight');
  });

  it('only an owner or tenant_admin may read or change it', async () => {
    if (skipped()) return;
    role = 'store_manager';
    expect(await codeOf(activation.getState(admin_))).toBe('forbidden');
  });
});

describe('review findings (regressions)', () => {
  it('pages receipts one at a time with no repeat and no gap: the cursor keeps microseconds', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    const ids: string[] = [];
    for (const q of ['1', '2', '3']) ids.push((await svc.receive(owner(), t.id, recv(t, q))).receipt.id);
    // A millisecond-truncated cursor would hand the same row back forever at limit 1.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const page = await svc.listReceipts(owner(), t.id, cursor, 1);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(ids);
    expect(cursor).toBeNull();
  });

  it('pages the Transfer list without losing rows created in the same millisecond', async () => {
    if (skipped()) return;
    const made: string[] = [];
    for (let i = 0; i < 4; i += 1) made.push((await svc.create(owner(), draft())).id);
    // Collapse every created_at onto one millisecond, with distinct microseconds: only a microsecond key orders them.
    await admin.query(
      `UPDATE shipment_transfers t SET created_at = timestamptz '2026-11-20 10:00:00.123000+00' + (r.n * interval '100 microseconds')
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM shipment_transfers) r WHERE r.id = t.id`,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const page = await svc.list(owner(), { storeId: null, direction: 'any', state: null }, cursor, 1);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(seen).size).toBe(4);
    expect(seen).toHaveLength(4);
    expect([...seen].sort()).toEqual([...made].sort());
  });

  it('a reader outside the Transfer scope neither sees it nor triggers its expiry', async () => {
    if (skipped()) return;
    role = 'store_manager';
    await seedStock(STORE_A_X, '100');
    const t = await svc.create(owner(), draft());
    await svc.approve(owner(), t.id, FAR_FUTURE);
    await admin.query(`UPDATE shipment_transfers SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    const outsider = managerOf(MANAGER_Y, STORE_B_X);
    expect(await codeOf(svc.get(outsider, t.id))).toBe('NotFoundException');
    expect((await svc.list(outsider, { storeId: null, direction: 'any', state: null }, null, 10)).items).toHaveLength(0);
    const row = (await admin.query(`SELECT state FROM shipment_transfers WHERE id = $1`, [t.id])).rows[0];
    expect(row.state).toBe('approved');
    expect((await admin.query(`SELECT state FROM inventory_reservations`)).rows.map((r) => r.state)).toEqual(['active']);
    // Someone who can see it expires it, and the audit names the trigger, not a self-action.
    await svc.get(owner(), t.id);
    const meta = (await admin.query(`SELECT metadata FROM audit_events WHERE target_id = $1 AND action LIKE '%reservation_expired'`, [t.id])).rows[0].metadata;
    expect(meta).toMatchObject({ trigger: 'lazy_expiry', triggeredBy: OWNER, selfActioned: null });
  });

  it('a reservation that lapses after the sweep is still refused at dispatch, under the row lock (798)', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '100');
    const t = await svc.create(owner(), draft());
    await svc.approve(owner(), t.id, FAR_FUTURE);
    await admin.query(`UPDATE shipment_transfers SET reservation_expires_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
    const sweep = jest.spyOn(svc, 'expireDue').mockResolvedValue(0);
    try {
      expect(await codeOf(svc.dispatch(owner(), t.id, null))).toBe('shipment_transfer_not_in_state');
    } finally {
      sweep.mockRestore();
    }
    expect(await onHand(STORE_A_X)).toBe('100.0000');
    expect((await admin.query(`SELECT state FROM shipment_transfers WHERE id = $1`, [t.id])).rows[0].state).toBe('approved');
    expect((await legs(t.id))).toHaveLength(0);
  });

  it('a receipt leg that cannot be linked is rolled back whole: the dispatch is still confirmed and nothing half-built commits', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    const r = await svc.receive(owner(), t.id, recv(t, '4'));
    // An effect that is no longer a fresh not_posted one: linking the receipt's leg will refuse AFTER the leg's first writes.
    await admin.query(`UPDATE inventory_effect_integration SET state = 'erp_neutral' WHERE effect_id = $1`, [r.receipt.lines[0]!.movementId]);
    const dispatchId = await confirmDispatch(t.id);
    expect((await admin.query(`SELECT status FROM erpnext_posting_status WHERE id = $1`, [dispatchId])).rows[0].status).toBe('posted');
    expect((await legs(t.id)).map((l) => l.kind)).toEqual(['transfer_dispatch']);
    expect((await admin.query(`SELECT count(*)::int AS n FROM transfer_posting_lines tl JOIN transfer_postings tp ON tp.intent_id = tl.intent_id WHERE tp.receipt_id IS NOT NULL`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM erpnext_posting_status WHERE kind = 'transfer_receive'`)).rows[0].n).toBe(0);
  });
});

describe('delayed-transfer health facts (RT-1516)', () => {
  const health = (tenantId = TENANT_A) =>
    runWithTenantContext(env!.app as unknown as Pool, { tenantId, isPlatformAdmin: false }, (client) =>
      readShipmentTransferHealth((sql, params) => client.query(sql, params)),
    );

  // The file's beforeEach upserts only the activation switch: put the threshold back so a failed test cannot leak it.
  beforeEach(async () => {
    if (skipped()) return;
    await admin.query(`UPDATE tenant_inventory_settings SET delayed_transfer_threshold_days = 3 WHERE tenant_id = $1`, [TENANT_A]);
  });

  it('reports the tenant threshold (default 3, overridable) and nothing open before any Transfer', async () => {
    if (skipped()) return;
    expect(await health()).toEqual({ delayedThresholdDays: 3, openTransferAgesSeconds: [], workItems: [], unreleasedReceiptAgesSeconds: [] });
    await admin.query(`UPDATE tenant_inventory_settings SET delayed_transfer_threshold_days = 5 WHERE tenant_id = $1`, [TENANT_A]);
    expect((await health()).delayedThresholdDays).toBe(5);
  });

  it('lists a dispatched Transfer as open and its dispatch work item as pending; both clear as it is confirmed and received', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    const afterDispatch = await health();
    expect(afterDispatch.openTransferAgesSeconds).toHaveLength(1);
    expect(afterDispatch.openTransferAgesSeconds[0]).toBeLessThan(600);
    expect(afterDispatch.workItems).toEqual([{ state: 'pending', ageSeconds: expect.any(Number) }]);

    await confirmDispatch(t.id);
    const afterConfirm = await health();
    expect(afterConfirm.workItems).toEqual([]);
    expect(afterConfirm.openTransferAgesSeconds).toHaveLength(1);

    await svc.receive(owner(), t.id, recv(t, '10'));
    const afterReceipt = await health();
    // Received: the Transfer is no longer open; its receipt leg is now a pending work item until it is confirmed.
    expect(afterReceipt.openTransferAgesSeconds).toEqual([]);
    expect(afterReceipt.workItems).toEqual([{ state: 'pending', ageSeconds: expect.any(Number) }]);
    const receiptLeg = (await legs(t.id)).find((l) => l.receipt_id !== null)!;
    await posting.ackOutcome({
      tenantId: TENANT_A,
      workItemRef: receiptLeg.id,
      outcome: 'posted',
      documentRef: { doctype: 'Stock Entry', name: 'MAT-STE-2026-00043' },
    } as never);
    expect(await health()).toEqual({ delayedThresholdDays: 3, openTransferAgesSeconds: [], workItems: [], unreleasedReceiptAgesSeconds: [] });
  });

  it('measures ages on the database clock from dispatch and from the work item state change', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    await admin.query(`UPDATE shipment_transfers SET dispatched_at = now() - interval '4 days' WHERE id = $1`, [t.id]);
    await admin.query(
      `UPDATE inventory_effect_integration SET updated_at = now() - interval '2 hours'
        WHERE effect_id IN (SELECT id FROM stock_movements WHERE transfer_group_id = $1)`,
      [t.id],
    );
    const h = await health();
    expect(h.openTransferAgesSeconds[0]).toBeGreaterThanOrEqual(4 * 86_400 - 5);
    expect(h.workItems[0]!.ageSeconds).toBeGreaterThanOrEqual(2 * 3_600 - 5);
  });

  it('lists a rejected work item with its state', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    await admin.query(
      `UPDATE inventory_effect_integration SET state = 'rejected'
        WHERE effect_id IN (SELECT id FROM stock_movements WHERE transfer_group_id = $1)`,
      [t.id],
    );
    expect((await health()).workItems).toEqual([{ state: 'rejected', ageSeconds: expect.any(Number) }]);
  });

  it('lists a receipt still not_posted after its dispatch was confirmed (a release that failed), aged from the confirmation', async () => {
    if (skipped()) return;
    const t = await dispatched('10');
    await svc.receive(owner(), t.id, recv(t, '4'));
    // Before the dispatch is confirmed a waiting receipt is normal: not listed.
    expect((await health()).unreleasedReceiptAgesSeconds).toEqual([]);
    // Simulate a release that failed: the dispatch is confirmed but the receipt stayed not_posted.
    await admin.query(
      `UPDATE inventory_effect_integration
          SET state = 'confirmed', erp_confirmed_at = now() - interval '2 hours',
              erp_document_ref = '{"doctype":"Stock Entry","name":"MAT-STE-2026-00099"}'
        WHERE effect_id IN (SELECT id FROM stock_movements WHERE transfer_group_id = $1 AND movement_type = 'transfer_out')`,
      [t.id],
    );
    await admin.query(
      `UPDATE inventory_effect_integration SET created_at = now() - interval '3 hours'
        WHERE effect_id IN (SELECT id FROM stock_movements WHERE transfer_group_id = $1 AND movement_type = 'transfer_in')`,
      [t.id],
    );
    const h = await health();
    expect(h.unreleasedReceiptAgesSeconds).toHaveLength(1);
    expect(h.unreleasedReceiptAgesSeconds[0]).toBeGreaterThanOrEqual(2 * 3_600 - 5);
    expect(h.unreleasedReceiptAgesSeconds[0]).toBeLessThan(3 * 3_600 - 5);
  });

  it("is tenant-scoped by RLS alone: another tenant's context sees none of tenant A's Transfers or work items", async () => {
    if (skipped()) return;
    await dispatched('10');
    expect((await health(TENANT_A)).openTransferAgesSeconds).toHaveLength(1);
    const other = await health(TENANT_B);
    expect(other.openTransferAgesSeconds).toEqual([]);
    expect(other.workItems).toEqual([]);
  });
});

describe('legacy transfer drift report (RT-1517)', () => {
  const legacyInput = (quantity: string) =>
    ({
      tenantId: TENANT_A, userId: OWNER, sourceStoreId: STORE_A_X, destinationStoreId: STORE_A_Y,
      tenantProductRef: PRODUCT_A_ACTIVE, quantity, stockingUnit: 'each', reason: null,
    }) as never;
  const drift = (tenantId = TENANT_A, contextTenantId = tenantId) =>
    runWithTenantContext(env!.app as unknown as Pool, { tenantId: contextTenantId, isPlatformAdmin: false }, (client) =>
      listLegacyTransferDrift(client, tenantId),
    );

  it('lists every legacy leg still not_posted, per store, with item, quantity, unit and date, and nothing else', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '100');
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    const first = await legacy.createStockTransfer(legacyInput('4'));
    const second = await legacy.createStockTransfer(legacyInput('2.5'));
    // A legacy leg whose effect is no longer not_posted is not drift.
    const done = await legacy.createStockTransfer(legacyInput('1'));
    await admin.query(
      `UPDATE inventory_effect_integration SET state = 'external', erp_confirmed_at = now()
        WHERE effect_id IN (SELECT id FROM stock_movements WHERE transfer_group_id = $1)`,
      [(done as { transferGroupId: string }).transferGroupId],
    );
    // A shipment Transfer receipt stays not_posted until its dispatch is confirmed, but it is not a legacy leg.
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = true WHERE tenant_id = $1`, [TENANT_A]);
    const shipment = await svc.create(owner(), draft({}, '3'));
    await svc.approve(owner(), shipment.id, FAR_FUTURE);
    const inTransit = await svc.dispatch(owner(), shipment.id, 'on the truck');
    await svc.receive(owner(), shipment.id, recv(inTransit, '3'));
    const shipmentNotPosted = await admin.query(
      `SELECT count(*)::int AS n FROM stock_movements sm JOIN inventory_effect_integration i ON i.effect_id = sm.id
        WHERE sm.transfer_group_id = $1 AND sm.movement_type = 'transfer_in' AND i.state = 'not_posted'`,
      [shipment.id],
    );
    expect(shipmentNotPosted.rows[0].n).toBe(1);

    const rows = await drift();
    const groups = [first, second].map((t) => (t as { transferGroupId: string }).transferGroupId);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.transferGroupId))).toEqual(new Set(groups));
    // Ordered by store, then time: every source-store leg comes before every destination-store leg.
    const sourceFirst = [STORE_A_X, STORE_A_Y].sort()[0];
    expect(rows.slice(0, 2).every((r) => r.storeId === sourceFirst)).toBe(true);
    for (const r of rows) {
      expect(r.tenantProductRef).toBe(PRODUCT_A_ACTIVE);
      expect(r.stockingUnit).toBe('each');
      expect(r.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.movementType === 'transfer_out' ? r.storeId : STORE_A_X).toBe(STORE_A_X);
      expect(r.movementType === 'transfer_in' ? r.storeId : STORE_A_Y).toBe(STORE_A_Y);
    }
    const qty = rows.map((r) => `${r.movementType}:${r.quantity}`).sort();
    expect(qty).toEqual(['transfer_in:2.5000', 'transfer_in:4.0000', 'transfer_out:-2.5000', 'transfer_out:-4.0000']);
  });

  it('is empty for a tenant with no legacy drift, and never shows another tenant\'s legs (RLS)', async () => {
    if (skipped()) return;
    await seedStock(STORE_A_X, '100');
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    await legacy.createStockTransfer(legacyInput('4'));
    expect(await drift(TENANT_B)).toEqual([]);
    // Asked for tenant A's legs from inside tenant B's context: RLS, not the WHERE clause, must hide them.
    expect(await drift(TENANT_A, TENANT_B)).toEqual([]);
    expect(await drift(TENANT_A)).toHaveLength(2);
  });
});
