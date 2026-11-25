/**
 * Jira RT-1597 — the two shipment-Transfer ports the W9 redistribution proposals use, against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 *
 * Proves (RT-1597 acceptance 3, 4 and 5):
 *   - `readOpenTransferQuantities`: outbound draft and inbound draft / approved / in-transit quantities match fixtures in
 *     every open state (a partly received Transfer counts its remaining In Transit quantity; cancelled and received ones
 *     count nothing), filtered by store, and invisible to another tenant (RLS);
 *   - `createDraftTransfer` runs in the CALLER's transaction: committed, it writes the Draft and its audit row; inside an
 *     outer transaction that rolls back, it leaves no Transfer, no line and no audit row;
 *   - it keeps the create rules: the dark gate (404), a store of another tenant (404, nothing written), the duplicate-line
 *     and line-count rules (400 `validation_error`).
 *
 * The HTTP `create` path, which now calls the same port, stays covered unchanged by `shipment-transfers.db.spec.ts`.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { runWithTenantContext } from '@data-pulse-2/db';
import { Pool, type PoolClient } from 'pg';

import type { MembershipRepository } from '../../../src/context/membership.repository';
import {
  createDraftTransfer,
  readOpenTransferQuantities,
  type CreateTransferInput,
  type TransferCaller,
} from '../../../src/inventory';
import { ShipmentTransfersService, type TransferContext } from '../../../src/inventory/shipment-transfers/shipment-transfers.service';
import { transferErpAdapter } from '../../../src/catalog/erpnext-posting/transfer-erp.adapter';
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
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

let env: PgTestEnv | null = null;
let admin: Pool;
let svc: ShipmentTransfersService;
let memberships: MembershipRepository;
let primaryX = '';
let seq = 0;

const skipped = (): boolean => env === null;

const ctxFor = (userId: string, tenantId: string): TransferContext => ({
  userId,
  tenantId,
  storeId: null,
  isPlatformAdmin: false,
  source: 'session',
  storeAccess: { kind: 'all' },
});
const owner = (): TransferCaller => ({ tenantId: TENANT_A, userId: OWNER, context: ctxFor(OWNER, TENANT_A) });
const ownerB = (): TransferCaller => ({ tenantId: TENANT_B, userId: ACTOR_B, context: ctxFor(ACTOR_B, TENANT_B) });

const draft = (qty: string, over: Partial<CreateTransferInput> = {}): CreateTransferInput => ({
  sourceStoreId: STORE_A_X,
  destinationStoreId: STORE_A_Y,
  reason: 'Redistribution proposal (RT-1597 fixture)',
  lines: [{ tenantProductRef: PRODUCT_A_ACTIVE, quantity: qty, stockingUnit: 'each', trackingIdentityId: null }],
  ...over,
});

async function asTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return await runWithTenantContext(env!.app as unknown as Pool, { tenantId, isPlatformAdmin: false }, fn);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    return (r as { code?: string } | undefined)?.code ?? (e as Error).constructor.name;
  }
  return 'ok';
}

async function seedStock(storeId: string, quantity: string): Promise<void> {
  const movementId = `0a000000-0000-7000-8000-${(0x15990000000 + ++seq).toString(16).padStart(12, '0')}`;
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, received_at,
        created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, 'inbound', $4::numeric(19,4), 'each', $5, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
             $6, 'erp_external', 'erp_procurement_receipt', $1, $7, 'sellable')`,
    [movementId, TENANT_A, storeId, quantity, PRODUCT_A_ACTIVE, OWNER, primaryX],
  );
  await admin.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at)
     VALUES ($1, $2, 'external', '2020-01-01T00:00:00Z')`,
    [movementId, TENANT_A],
  );
}

const count = async (sql: string, params: unknown[] = []): Promise<number> => (await admin.query(sql, params)).rows[0].n as number;

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1597 shipment transfer ports');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt1597-st-a@fixture.invalid', NULL), ($2, 'rt1597-st-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [OWNER, ACTOR_B],
  );
  primaryX = (await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])).rows[0].id;
  await admin.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ITEM-A', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, OWNER],
  );
  await admin.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref) VALUES
       (gen_random_uuid(), $1, $2, 'stock', 'Store X - T'), (gen_random_uuid(), $1, $3, 'stock', 'Store Y - T'),
       (gen_random_uuid(), $1, NULL, 'transit', 'Goods In Transit - T')`,
    [TENANT_A, STORE_A_X, STORE_A_Y],
  );
  for (const [tenant, actor] of [
    [TENANT_A, OWNER],
    [TENANT_B, ACTOR_B],
  ] as const) {
    await admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, shipment_transfers_enabled, updated_by) VALUES ($1, true, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET shipment_transfers_enabled = true`,
      [tenant, actor],
    );
  }
  memberships = { findRoleCodeForUserInTenant: async () => 'owner' } as unknown as MembershipRepository;
  svc = new ShipmentTransfersService(env.app as unknown as Pool, memberships, transferErpAdapter);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (!env) return;
  await admin.query(`DELETE FROM transfer_posting_lines`);
  await admin.query(`DELETE FROM transfer_postings`);
  // The effect integration rows reference the dispatch work items (ON DELETE RESTRICT): delete them first.
  await admin.query(`DELETE FROM inventory_effect_integration WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`DELETE FROM erpnext_posting_status WHERE kind IN ('transfer_dispatch', 'transfer_receive')`);
  for (const t of [
    'shipment_transfer_discrepancies', 'shipment_transfer_receipt_lines', 'shipment_transfer_receipts',
    'shipment_transfer_lines', 'inventory_reservations', 'shipment_transfers',
  ]) {
    await admin.query(`DELETE FROM ${t}`);
  }
  await admin.query(`DELETE FROM stock_movements WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = true`);
  await seedStock(STORE_A_X, '1000');
});

describe('readOpenTransferQuantities', () => {
  /** One Transfer in each open state, plus a cancelled and a fully received one that must count nothing. */
  async function seedEveryState(): Promise<void> {
    await svc.create(owner(), draft('4')); // X -> Y draft
    await svc.approve(owner(), (await svc.create(owner(), draft('3'))).id, FAR_FUTURE); // X -> Y approved
    const transit = await svc.create(owner(), draft('5'));
    await svc.approve(owner(), transit.id, FAR_FUTURE);
    await svc.dispatch(owner(), transit.id, null); // X -> Y in_transit: 5
    const partial = await svc.create(owner(), draft('6'));
    await svc.approve(owner(), partial.id, FAR_FUTURE);
    const sent = await svc.dispatch(owner(), partial.id, null);
    const recvd = await svc.receive(owner(), partial.id, {
      lines: [{ transferLineId: sent.lines[0]!.id, quantity: '2', disposition: 'sellable', stockLocationId: null }],
      note: null,
    });
    expect(recvd.transfer.state).toBe('partially_received'); // remaining In Transit: 4
    const full = await svc.create(owner(), draft('8'));
    await svc.approve(owner(), full.id, FAR_FUTURE);
    const fullSent = await svc.dispatch(owner(), full.id, null);
    await svc.receive(owner(), full.id, {
      lines: [{ transferLineId: fullSent.lines[0]!.id, quantity: '8', disposition: 'sellable', stockLocationId: null }],
      note: null,
    }); // received: nothing open
    await svc.cancel(owner(), (await svc.create(owner(), draft('100'))).id, 'not needed'); // cancelled: nothing open
    await svc.create(owner(), draft('7', { sourceStoreId: STORE_A_Y, destinationStoreId: STORE_A_X })); // Y -> X draft
  }

  it('matches the draft, approved, in_transit and partially_received fixtures per store x product', async () => {
    if (skipped()) return;
    await seedEveryState();
    const rows = await asTenant(TENANT_A, (client) => readOpenTransferQuantities(client));
    expect(rows).toEqual(
      [
        {
          storeId: STORE_A_X,
          productId: PRODUCT_A_ACTIVE,
          stockingUnit: 'each',
          outboundDraft: '4.0000',
          inboundDraft: '7.0000',
          inboundApproved: '0.0000',
          inboundInTransit: '0.0000',
          inbound: '7.0000',
        },
        {
          storeId: STORE_A_Y,
          productId: PRODUCT_A_ACTIVE,
          stockingUnit: 'each',
          outboundDraft: '7.0000',
          inboundDraft: '4.0000',
          inboundApproved: '3.0000',
          inboundInTransit: '9.0000',
          inbound: '16.0000',
        },
      ].sort((a, b) => a.storeId.localeCompare(b.storeId)),
    );
  });

  it('counts an approved Transfer whose reservation lapsed as outbound (ATS no longer subtracts it, A-2)', async () => {
    if (skipped()) return;
    const t = await svc.create(owner(), draft('6'));
    await svc.approve(owner(), t.id, FAR_FUTURE);
    const before = await asTenant(TENANT_A, (client) => readOpenTransferQuantities(client, { storeIds: [STORE_A_X] }));
    expect(before).toEqual([]); // reserved: already out of the source's ATS, nothing to net
    // The reservation lapses; no command has swept it back to draft yet.
    await admin.query(`UPDATE shipment_transfers SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    await admin.query(`UPDATE inventory_reservations SET expires_at = now() - interval '1 minute' WHERE source_id = $1`, [t.id]);
    const after = await asTenant(TENANT_A, (client) => readOpenTransferQuantities(client));
    expect(after.find((r) => r.storeId === STORE_A_X)?.outboundDraft).toBe('6.0000');
    expect(after.find((r) => r.storeId === STORE_A_Y)).toMatchObject({ inboundApproved: '6.0000', inbound: '6.0000' });
  });

  it('filters by store, and an empty list reads nothing', async () => {
    if (skipped()) return;
    await seedEveryState();
    const onlyY = await asTenant(TENANT_A, (client) => readOpenTransferQuantities(client, { storeIds: [STORE_A_Y] }));
    expect(onlyY.map((r) => [r.storeId, r.outboundDraft, r.inbound])).toEqual([[STORE_A_Y, '7.0000', '16.0000']]);
    expect(await asTenant(TENANT_A, (client) => readOpenTransferQuantities(client, { storeIds: [] }))).toEqual([]);
  });

  it("never shows one tenant's Transfers to another (RLS)", async () => {
    if (skipped()) return;
    await seedEveryState();
    expect(await asTenant(TENANT_B, (client) => readOpenTransferQuantities(client))).toEqual([]);
    expect(await asTenant(TENANT_B, (client) => readOpenTransferQuantities(client, { storeIds: [STORE_A_X, STORE_A_Y] }))).toEqual([]);
  });
});

describe("createDraftTransfer on the caller's client", () => {
  it('committed with the caller: writes the Draft, its line and its create audit, and reserves nothing', async () => {
    if (skipped()) return;
    const t = await asTenant(TENANT_A, (client) => createDraftTransfer(client, owner(), draft('10'), { memberships }));
    expect(t).toMatchObject({ state: 'draft', sourceStoreId: STORE_A_X, destinationStoreId: STORE_A_Y });
    expect(t.lines[0]).toMatchObject({ lineSeq: 1, quantity: '10.0000' });
    expect((await svc.get(owner(), t.id)).id).toBe(t.id);
    expect(
      (await admin.query(`SELECT action, actor_user_id FROM audit_events WHERE target_id = $1`, [t.id])).rows,
    ).toEqual([{ action: 'inventory.shipment_transfer.create', actor_user_id: OWNER }]);
    expect(await count(`SELECT count(*)::int AS n FROM inventory_reservations`)).toBe(0);
  });

  it('inside an outer transaction that rolls back: no Transfer, no line and no audit row remain', async () => {
    if (skipped()) return;
    let createdId = '';
    const rollback = asTenant(TENANT_A, async (client) => {
      const t = await createDraftTransfer(client, owner(), draft('10'), { memberships });
      createdId = t.id;
      // The caller's own write fails after the draft: the whole transaction rolls back.
      throw new Error('caller write failed');
    });
    await expect(rollback).rejects.toThrow('caller write failed');
    expect(createdId).not.toBe('');
    expect(await count(`SELECT count(*)::int AS n FROM shipment_transfers WHERE id = $1`, [createdId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM shipment_transfer_lines WHERE transfer_id = $1`, [createdId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1`, [createdId])).toBe(0);
  });

  it('keeps the create rules: dark gate, cross-tenant store (nothing written), duplicate line, line count', async () => {
    if (skipped()) return;
    const run = (caller: TransferCaller, input: CreateTransferInput) =>
      asTenant(caller.tenantId, (client) => createDraftTransfer(client, caller, input, { memberships }));
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    expect(await codeOf(run(owner(), draft('1')))).toBe('NotFoundException');
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = true WHERE tenant_id = $1`, [TENANT_A]);
    // RLS: tenant B cannot name tenant A's stores, and tenant A cannot name tenant B's.
    expect(await codeOf(run(ownerB(), draft('1')))).toBe('NotFoundException');
    expect(await codeOf(run(owner(), draft('1', { destinationStoreId: STORE_B_X })))).toBe('NotFoundException');
    const dup = draft('1');
    expect(await codeOf(run(owner(), { ...dup, lines: [dup.lines[0]!, dup.lines[0]!] }))).toBe('validation_error');
    expect(await codeOf(run(owner(), { ...dup, lines: [] }))).toBe('validation_error');
    expect(await codeOf(run(owner(), draft('1', { destinationStoreId: STORE_A_X })))).toBe('validation_error');
    expect(await count(`SELECT count(*)::int AS n FROM shipment_transfers`)).toBe(0);
  });
});
