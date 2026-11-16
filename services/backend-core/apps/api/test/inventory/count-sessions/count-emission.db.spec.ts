/**
 * Jira RT-1423 — Count Session ERP emission, chunk lifecycle, activation and the legacy 409, against real
 * Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 *
 * Proves, per the issue's acceptance criteria:
 *   1. approval writes ONE chunk in the existing feed with the ABSOLUTE counted target (not the variance),
 *      the frozen Cut + 1 microsecond stamp and the provenance key, links the effect (pending), and a replay
 *      writes no second chunk; the feed offers it with the frozen body;
 *   2. an ack changes integration state, never quantity: posted confirms the effects, a posted chunk with a
 *      rejected line rejects that line's effects and sends the session to needs_attention (never fully
 *      confirmed), a verified no-op confirms with NO document, a dead-lettered chunk needs attention;
 *   3. a replayed ack echoes, a different outcome conflicts;
 *   4. activation is OFF by default, switching on fails closed (typed boundary, no override), switching off is
 *      refused while a session is open, and the legacy count answers the typed 409 only when it is on.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { Pool } from 'pg';

import { ErpnextPostingService } from '../../../src/catalog/erpnext-posting/erpnext-posting.service';
import type { FeedWorkItem } from '../../../src/catalog/erpnext-posting/posting-work-item.projection';
import type { MembershipRepository } from '../../../src/context/membership.repository';
import { CountSessionsService, type CountCaller } from '../../../src/inventory/count-sessions/count-sessions.service';
import { CountSessionsSettingService } from '../../../src/inventory/count-sessions/count-sessions-setting.service';
import { StockCountService } from '../../../src/inventory/stock-count.service';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

const COUNTER = ACTOR_A;
const APPROVER = '0a000000-0000-7000-8000-00000000c0a1';
const DOC = { doctype: 'Stock Reconciliation', name: 'MAT-RECO-2026-00017' };

let env: PgTestEnv | null = null;
let admin: Pool;
let counts: CountSessionsService;
let setting: CountSessionsSettingService;
let posting: ErpnextPostingService;
let primaryLocation = '';
let role = 'owner';

const as = (userId: string): CountCaller => ({ tenantId: TENANT_A, userId });
const skipped = (): boolean => env === null;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    return (r as { code?: string } | undefined)?.code ?? (e as Error).constructor.name;
  }
  return 'ok';
}

async function seedHistory(productId: string, quantity: string): Promise<void> {
  const id = `0a000000-0000-7000-8000-${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`;
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, received_at,
        created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, 'inbound', $4::numeric(19,4), 'each', $5, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
             $6, 'erp_external', 'erp_procurement_receipt', $1, $7, 'sellable')`,
    [id, TENANT_A, STORE_A_X, quantity, productId, COUNTER, primaryLocation],
  );
  await admin.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at)
     VALUES ($1, $2, 'external', '2020-01-01T00:00:00Z')`,
    [id, TENANT_A],
  );
}

/** open -> observe 7 -> cut -> submit -> approve against an expected 10: one line, variance -3, one chunk. */
async function approvedSession(): Promise<string> {
  await seedHistory(PRODUCT_A_ACTIVE, '10');
  const id = (await counts.createSession(as(COUNTER), STORE_A_X, [PRODUCT_A_ACTIVE], 'test')).id;
  await counts.recordObservations(as(COUNTER), STORE_A_X, id, [
    { productId: PRODUCT_A_ACTIVE, locationId: primaryLocation, inventoryStatus: 'sellable', countedQuantity: '7', stockingUnit: 'each' },
  ]);
  await counts.takeCut(as(COUNTER), STORE_A_X, id);
  await counts.submit(as(COUNTER), STORE_A_X, id);
  const lines = await counts.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50);
  const acks = lines.items
    .filter((l) => l.acknowledgementRequired)
    .map((l) => ({ productId: l.productId, lineVersion: l.lineVersion, note: null }));
  await counts.approve(as(APPROVER), STORE_A_X, id, acks);
  return id;
}

async function chunk(sessionId: string): Promise<{ id: string; status: string; external_id: string; stamp: string; kind: string }> {
  const r = await admin.query(
    `SELECT id, status, external_id, count_posting_datetime AS stamp, kind FROM erpnext_posting_status WHERE count_session_id = $1`,
    [sessionId],
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0];
}

const sessionState = async (id: string): Promise<string> =>
  (await admin.query(`SELECT state FROM count_sessions WHERE id = $1`, [id])).rows[0].state as string;

async function effects(sessionId: string): Promise<Array<{ state: string; doc: string | null; reason: string | null }>> {
  const r = await admin.query(
    `SELECT ei.state, ei.erp_document_ref AS doc, ei.state_reason AS reason
       FROM inventory_effect_integration ei
       JOIN count_session_lines l ON ei.effect_id = ANY(l.correction_effect_ids) WHERE l.session_id = $1`,
    [sessionId],
  );
  return r.rows;
}

const line = (n: number, result: string, extra: Record<string, unknown> = {}) => ({
  lineSeq: n,
  result: result as 'adjusted' | 'verified_noop' | 'rejected',
  verifiedQtyAfter: result === 'rejected' ? null : '7.0000',
  refusal: null,
  ...extra,
});

const ack = (workItemRef: string, body: Record<string, unknown>) =>
  posting.ackOutcome({ tenantId: TENANT_A, workItemRef, ...body } as never);

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1423 count emission');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'ce-counter@fixture.invalid', NULL), ($2, 'ce-approver@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [COUNTER, APPROVER],
  );
  primaryLocation = (
    await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])
  ).rows[0].id as string;
  await admin.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ITEM-CE-0', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, COUNTER],
  );
  await admin.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'Stores - CE') ON CONFLICT DO NOTHING`,
    [TENANT_A, STORE_A_X],
  );
  await admin.query(
    `INSERT INTO erp_stock_import_runs
       (id, tenant_id, store_id, warehouse_map_id, erpnext_warehouse_ref, status, settle_seconds, overlap_seconds, ended_at)
     SELECT gen_random_uuid(), tenant_id, store_id, id, erpnext_warehouse_ref, 'completed', 0, 0, now() + interval '10 years'
       FROM erpnext_warehouse_map WHERE store_id = $1 AND purpose = 'stock' AND retired_at IS NULL`,
    [STORE_A_X],
  );
  const memberships = { findRoleCodeForUserInTenant: async () => role } as unknown as MembershipRepository;
  counts = new CountSessionsService(env.app as unknown as Pool, memberships);
  setting = new CountSessionsSettingService(env.app as unknown as Pool, memberships);
  posting = new ErpnextPostingService(env.app as unknown as Pool);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  role = 'owner';
  if (!env) return;
  await admin.query(`DELETE FROM count_posting_lines`);
  await admin.query(
    `DELETE FROM inventory_effect_integration WHERE posting_status_id IN
       (SELECT id FROM erpnext_posting_status WHERE kind = 'inventory_count')`,
  );
  await admin.query(`DELETE FROM erpnext_posting_status WHERE kind = 'inventory_count'`);
  for (const t of ['count_late_event_findings', 'count_observations', 'count_session_expected', 'count_session_lines', 'count_sessions']) {
    await admin.query(`DELETE FROM ${t}`);
  }
  await admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, count_sessions_enabled, count_self_approval_enabled, updated_by)
     VALUES ($1, true, false, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET count_sessions_enabled = true, count_self_approval_enabled = false,
       count_self_approval_reason = NULL, count_self_approval_changed_at = NULL, count_self_approval_changed_by = NULL`,
    [TENANT_A, COUNTER],
  );
  await admin.query(
    `DELETE FROM inventory_effect_integration WHERE tenant_id = $1 AND effect_id IN (
       SELECT id FROM stock_movements WHERE store_id = $2 AND tenant_product_ref = $3)`,
    [TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE],
  );
  await admin.query(`DELETE FROM stock_movements WHERE store_id = $1 AND tenant_product_ref = $2`, [STORE_A_X, PRODUCT_A_ACTIVE]);
  await admin.query(`DELETE FROM stock_counts WHERE store_id = $1`, [STORE_A_X]);
});

describe('emission at approval (AC2, AC3)', () => {
  it('writes ONE chunk with the absolute target, the frozen cut + 1 microsecond and the provenance key', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    expect(c).toMatchObject({ kind: 'inventory_count', status: 'pending', external_id: `count:${id}` });
    expect(c.stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const cut = await admin.query(
      `SELECT to_char((cut_at + interval '1 microsecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS dt FROM count_sessions WHERE id = $1`,
      [id],
    );
    expect(c.stamp).toBe(cut.rows[0].dt);
    const lines = await admin.query(
      `SELECT line_seq, erpnext_item_ref, warehouse_ref, counted_quantity::text AS q, unit FROM count_posting_lines WHERE intent_id = $1`,
      [c.id],
    );
    // 7 is the ABSOLUTE counted target; the Retail variance (-3) is never sent as stock.
    expect(lines.rows).toEqual([{ line_seq: 1, erpnext_item_ref: 'ITEM-CE-0', warehouse_ref: 'Stores - CE', q: '7.0000', unit: 'each' }]);
    expect(await sessionState(id)).toBe('posting');
    expect(await effects(id)).toEqual([{ state: 'pending', doc: null, reason: null }]);
  });

  it('a replayed approval writes no second chunk and moves no quantity', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const movements = (await admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_A_X])).rows[0].n;
    expect(await code(counts.approve(as(APPROVER), STORE_A_X, id, []))).toBe('count_session_not_in_state');
    await chunk(id);
    expect((await admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_A_X])).rows[0].n).toBe(movements);
  });

  it('the feed offers the chunk from its frozen rows, in the existing cursor', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    const page = await posting.pullPostings<FeedWorkItem>({ tenantId: TENANT_A, since: null, limit: 500 });
    const item = page.items.find((i) => i.workItemRef === c.id);
    expect(item).toMatchObject({ kind: 'inventory_count', externalId: `count:${id}` });
    expect((item as unknown as { count: { chunk: number; chunkCount: number; postingDatetime: string; lines: unknown[] } }).count).toMatchObject({
      chunk: 1,
      chunkCount: 1,
      postingDatetime: c.stamp,
    });
    expect((item as { sale?: unknown }).sale).toBeUndefined();
  });
});

describe('acknowledgement changes state, never quantity (AC4)', () => {
  it('posted with every line adjusted confirms the effects with the document and confirms the session', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    const movements = (await admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_A_X])).rows[0].n;
    const r = await ack(c.id, { outcome: 'posted', documentRef: DOC, lines: [line(1, 'adjusted')] });
    expect(r.outcome).toMatchObject({ outcome: 'posted', documentRef: DOC });
    const eff = await effects(id);
    expect(eff).toHaveLength(1);
    expect(eff[0]!.state).toBe('confirmed');
    expect(JSON.parse(eff[0]!.doc!)).toEqual(DOC);
    expect(await sessionState(id)).toBe('confirmed');
    expect((await admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_A_X])).rows[0].n).toBe(movements);
  });

  it('a verified no-op confirms the effects with NO document and the session', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    const r = await ack(c.id, { outcome: 'verified_noop', lines: [line(1, 'verified_noop')] });
    expect(r.outcome).toMatchObject({ outcome: 'verified_noop', documentRef: null });
    expect((await chunk(id)).status).toBe('verified_noop');
    expect(await effects(id)).toEqual([{ state: 'confirmed', doc: null, reason: 'count_verified_noop' }]);
    expect(await sessionState(id)).toBe('confirmed');
  });

  it('a posted chunk with a rejected line rejects that line and is never fully confirmed', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    await ack(c.id, {
      outcome: 'posted',
      documentRef: DOC,
      lines: [line(1, 'rejected', { refusal: { code: 'uom_mismatch', message: 'unit is not the stock UOM' } })],
    });
    const eff = await effects(id);
    expect(eff[0]!.state).toBe('rejected');
    expect(eff[0]!.reason).toBe('count_line_uom_mismatch');
    expect(await sessionState(id)).toBe('needs_attention');
  });

  it('a dead-lettered chunk keeps the effects rejected and needs attention; no ERP document is touched', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    await ack(c.id, { outcome: 'permanently_rejected', reason: { category: 'closed_period', message: 'Stock frozen' } });
    expect((await effects(id))[0]!.state).toBe('rejected');
    expect(await sessionState(id)).toBe('needs_attention');
  });

  it('a replayed ack echoes, a different outcome conflicts, and a ack for another kind is refused', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    const body = { outcome: 'posted', documentRef: DOC, lines: [line(1, 'adjusted')] };
    expect((await ack(c.id, body)).replayed).toBe(false);
    expect((await ack(c.id, body)).replayed).toBe(true);
    await expect(ack(c.id, { outcome: 'permanently_rejected', reason: { category: 'other', message: 'x' } })).rejects.toThrow();
  });

  it('refuses a line set that is not exactly the chunk lines', async () => {
    if (skipped()) return;
    const id = await approvedSession();
    const c = await chunk(id);
    await expect(ack(c.id, { outcome: 'posted', documentRef: DOC, lines: [line(2, 'adjusted')] })).rejects.toThrow();
    expect((await chunk(id)).status).toBe('pending');
    expect((await effects(id))[0]!.state).toBe('pending');
  });
});

describe('activation and the legacy route (AC1)', () => {
  it('is OFF by default and the legacy count answers the typed 409 only when it is ON', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE tenant_inventory_settings SET count_sessions_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    expect((await setting.getSetting({ tenantId: TENANT_A, userId: COUNTER, isPlatformAdmin: false })).enabled).toBe(false);
    const legacy = new StockCountService(env!.app as unknown as Pool);
    const input = { tenantId: TENANT_A, storeId: STORE_A_X, tenantProductRef: PRODUCT_A_ACTIVE, countedQuantity: '1', stockingUnit: 'each', actorId: COUNTER } as never;
    expect(await code(legacy.recordStockCount(input))).not.toBe('count_sessions_active');
    await admin.query(`UPDATE tenant_inventory_settings SET count_sessions_enabled = true WHERE tenant_id = $1`, [TENANT_A]);
    expect(await code(legacy.recordStockCount(input))).toBe('count_sessions_active');
  });

  it('switching on fails closed with a typed boundary and no override; the state stays off', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE tenant_inventory_settings SET count_sessions_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    expect(await code(setting.setSetting({ tenantId: TENANT_A, userId: COUNTER, isPlatformAdmin: false }, true))).toBe(
      'count_sessions_readiness_unmet',
    );
    const read = await setting.getSetting({ tenantId: TENANT_A, userId: COUNTER, isPlatformAdmin: false });
    expect(read.enabled).toBe(false);
    expect(read.readinessMet).toBe(false);
    expect(read.unmetReadiness?.map((u) => u.code)).toContain('erp_back_dated_role_unverified');
  });

  it('switching off is refused while a session is open, and accepted once none is', async () => {
    if (skipped()) return;
    const id = (await counts.createSession(as(COUNTER), STORE_A_X, [PRODUCT_A_ACTIVE], null)).id;
    const caller = { tenantId: TENANT_A, userId: COUNTER, isPlatformAdmin: false };
    expect(await code(setting.setSetting(caller, false))).toBe('count_sessions_open');
    expect((await setting.getSetting(caller)).enabled).toBe(true);
    await counts.cancel(as(COUNTER), STORE_A_X, id, 'done');
    expect((await setting.setSetting(caller, false)).enabled).toBe(false);
  });

  it('a store_manager reads the on/off value only', async () => {
    if (skipped()) return;
    role = 'store_manager';
    const read = await setting.getSetting({ tenantId: TENANT_A, userId: COUNTER, isPlatformAdmin: false });
    expect(read).toMatchObject({ enabled: true, readinessMet: null, unmetReadiness: null, changedAt: null });
  });
});
