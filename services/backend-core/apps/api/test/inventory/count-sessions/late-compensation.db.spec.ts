/**
 * Jira RT-1424 — the governed late-count compensation (RT-292 G6-5, conditions A to I) against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 *
 * Proves, per the issue's acceptance criteria:
 *   1. a refusal of EACH of A to I leaves no compensation, no compensating effect, no `erp_absorbed` row, no audit
 *      event, no new ERP posting row, and the Health finding stays;
 *   2. a replay and five concurrent calls produce exactly ONE effect (the database UNIQUE keys back it);
 *      cross-tenant and cross-store attempts fail; authorization (reason) and audit are one transaction;
 *   3. the compensation is exactly the negated late event quantity, checked against the ledger quantity the
 *      Connector read; a partial, stale or unrelated divergence refuses;
 *   4. the worked example (Retail 5, ERP 7) resolves to 7 / 7 with no ERP posting and no pending term, for a late
 *      POS sale and for a late ERP-origin receipt; a pending late event and a stale Bin refuse;
 *   5. an invariant failure after the write rolls everything back; no posting signal can move `erp_absorbed`.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { readPendingAwarePositions, runWithTenantContext } from '@data-pulse-2/db';
import { Pool } from 'pg';

import { ErpnextPostingService } from '../../../src/catalog/erpnext-posting/erpnext-posting.service';
import type { MembershipRepository } from '../../../src/context/membership.repository';
import { decideTransition } from '../../../src/inventory/effect-integration/integration-state-machine';
import { CountSessionsService, type CountCaller } from '../../../src/inventory/count-sessions/count-sessions.service';
import { COMPENSATION_ROLES } from '../../../src/inventory/count-sessions/late-compensation.rules';
import { CountLateCompensationService } from '../../../src/inventory/count-sessions/late-compensation.service';
import * as compensationStore from '../../../src/inventory/count-sessions/late-compensation.store';
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

const COUNTER = ACTOR_A;
const APPROVER = '0a000000-0000-7000-8000-00000000c0a1';
const DOC = { doctype: 'Stock Reconciliation', name: 'MAT-RECO-2026-00017' };
const SALE_DOC = JSON.stringify({ doctype: 'Sales Invoice', name: 'SINV-2026-00042' });
const ITEM = 'ITEM-CE-0';
const WAREHOUSE = 'Stores - CE';

let env: PgTestEnv | null = null;
let admin: Pool;
let counts: CountSessionsService;
let compensation: CountLateCompensationService;
let posting: ErpnextPostingService;
let primaryLocation = '';
/** The role the stubbed membership lookup answers for every caller (null: no membership, e.g. a platform admin). */
let role: string | null = 'owner';
let anchorSourceRun = '';
let pageSeq = 0;
let uid = 0;

const as = (userId: string, tenantId = TENANT_A): CountCaller => ({ tenantId, userId });
const skipped = (): boolean => env === null;
const nextId = (): string => `0a000000-0000-7000-8000-${(0x1424000000 + ++uid).toString(16).padStart(12, '0')}`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    return (r as { code?: string } | undefined)?.code ?? (e as Error).constructor.name;
  }
  return 'ok';
}

interface Scenario {
  readonly sessionId: string;
  readonly findingId: string;
  readonly lateId: string;
  readonly countEffectId: string;
  readonly cut: Date;
}

interface Options {
  /** The count's observation; ERP held 10 (so the count correction is counted - 10). */
  readonly counted?: string;
  /** The late event's signed quantity. */
  readonly lateQty?: string;
  readonly lateKind?: 'pos_sale' | 'erp_receipt';
  readonly lateState?: 'confirmed' | 'pending';
  readonly lateLedger?: { readonly qty: string; readonly time: string; readonly date?: string } | 'omit' | 'cancelled';
  readonly countLedger?: 'omit' | 'cancelled';
  /** The late ERP-origin row was imported for another warehouse than the count's. */
  readonly lateWarehouse?: string;
  readonly bin?: { readonly quantity: string; readonly readOffsetMs: number } | 'none';
}

const countStamp = { date: '2026-11-16', time: '10:00:00.000001' };

async function seedHistory(productId: string, quantity: string): Promise<void> {
  const id = nextId();
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

async function seedLedgerRow(o: {
  voucherType: string;
  voucherNo: string;
  qty: string;
  date: string;
  time: string;
  cancelled?: boolean;
  effectId?: string | undefined;
  creation?: Date;
  warehouse?: string;
}): Promise<void> {
  const run = (await admin.query(`SELECT id FROM erp_stock_import_runs WHERE store_id = $1 LIMIT 1`, [STORE_A_X])).rows[0].id as string;
  const page = nextId();
  await admin.query(
    `INSERT INTO erp_stock_import_pages (id, tenant_id, run_id, page_seq, max_rows) VALUES ($1, $2, $3, $4, 100)`,
    [page, TENANT_A, run, ++pageSeq],
  );
  await admin.query(
    `INSERT INTO erp_stock_import_rows
       (id, tenant_id, store_id, page_id, erpnext_warehouse_ref, ledger_entry_ref, entry_index, voucher_type, voucher_no,
        erpnext_item_ref, creation, is_cancelled, actual_qty, stock_uom, outcome, tenant_product_ref, effect_id,
        posting_date, posting_time)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12::numeric, 'each', $13, $14, $15, $16::date, $17)`,
    [
      nextId(),
      TENANT_A,
      STORE_A_X,
      page,
      o.warehouse ?? WAREHOUSE,
      `SLE-${nextId()}`,
      o.voucherType,
      o.voucherNo,
      ITEM,
      o.creation ?? new Date(Date.now() - 120_000),
      o.cancelled ?? false,
      o.qty,
      o.effectId ? 'imported' : 'retail_provenance',
      PRODUCT_A_ACTIVE,
      o.effectId ?? null,
      o.date,
      o.time,
    ],
  );
}

async function seedBin(quantity: string, readOffsetMs: number): Promise<void> {
  const at = new Date(Date.now() + readOffsetMs).toISOString();
  const report = {
    runRef: nextId(),
    erpnextWarehouseRef: WAREHOUSE,
    readAt: at,
    recordedAt: at,
    complete: true,
    entries: [{ erpnextItemRef: { name: ITEM }, quantity, stockUom: 'each' }],
  };
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now(), $4::jsonb)`,
    [nextId(), TENANT_A, STORE_A_X, JSON.stringify({ bin_view_report: report })],
  );
}

async function seedSalePosting(): Promise<string> {
  const saleId = nextId();
  await admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 0, now(), current_date, 'pos', $4, $5, $6)`,
    [saleId, TENANT_A, STORE_A_X, `x-${saleId}`, '0'.repeat(64), COUNTER],
  );
  const r = await admin.query(
    `INSERT INTO erpnext_posting_status (tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
                                         payload_hash, status, document_ref, posted_at)
     VALUES ($1, $2, $3, 'sale_post', $3, 'pos', $4, $5, 'posted', $6, now()) RETURNING id`,
    [TENANT_A, STORE_A_X, saleId, `x-${saleId}`, '0'.repeat(64), SALE_DOC],
  );
  return r.rows[0].id as string;
}

/** open -> observe -> cut -> submit -> approve -> chunk acked posted -> a late event -> its finding. */
async function scenario(o: Options = {}): Promise<Scenario> {
  const counted = o.counted ?? '7';
  const lateQty = o.lateQty ?? '-2';
  const lateKind = o.lateKind ?? 'pos_sale';
  await seedHistory(PRODUCT_A_ACTIVE, '10');
  const sessionId = (await counts.createSession(as(COUNTER), STORE_A_X, [PRODUCT_A_ACTIVE], 'test')).id;
  await counts.recordObservations(as(COUNTER), STORE_A_X, sessionId, [
    { productId: PRODUCT_A_ACTIVE, locationId: primaryLocation, inventoryStatus: 'sellable', countedQuantity: counted, stockingUnit: 'each' },
  ]);
  await counts.takeCut(as(COUNTER), STORE_A_X, sessionId);
  await counts.submit(as(COUNTER), STORE_A_X, sessionId);
  const lines = await counts.listVarianceLines(as(COUNTER), STORE_A_X, sessionId, null, null, 50);
  const acks = lines.items
    .filter((l) => l.acknowledgementRequired)
    .map((l) => ({ productId: l.productId, lineVersion: l.lineVersion, note: null }));
  await counts.approve(as(APPROVER), STORE_A_X, sessionId, acks);
  const chunk = (await admin.query(`SELECT id FROM erpnext_posting_status WHERE count_session_id = $1`, [sessionId])).rows[0].id as string;
  await posting.ackOutcome({
    tenantId: TENANT_A,
    workItemRef: chunk,
    outcome: 'posted',
    documentRef: DOC,
    lines: [{ lineSeq: 1, result: 'adjusted', verifiedQtyAfter: `${counted}.0000`, refusal: null }],
  } as never);
  const cut = (await admin.query(`SELECT cut_at FROM count_sessions WHERE id = $1`, [sessionId])).rows[0].cut_at as Date;
  const countEffectId = (
    await admin.query(`SELECT correction_effect_ids[1] AS id FROM count_session_lines WHERE session_id = $1`, [sessionId])
  ).rows[0].id as string;

  // The late pre-cut event: stamped before the cut, learned after it.
  const lateId = nextId();
  const before = new Date(cut.getTime() - 60_000).toISOString();
  if (lateKind === 'pos_sale') {
    await admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, created_by,
          origin, event_type, event_ref_id, source_system, external_id, stock_location_id, inventory_status)
       VALUES ($1, $2, $3, 'outbound', $4::numeric(19,4), 'each', $5, $6, $7, 'retail', 'sale', $8, 'pos', 'late-sale-1', $9, 'sellable')`,
      [lateId, TENANT_A, STORE_A_X, lateQty, PRODUCT_A_ACTIVE, before, COUNTER, nextId(), primaryLocation],
    );
    const state = o.lateState ?? 'confirmed';
    const intent = await seedSalePosting();
    await admin.query(
      `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, posting_status_id, erp_document_ref, erp_confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [lateId, TENANT_A, state, intent, state === 'confirmed' ? SALE_DOC : null, state === 'confirmed' ? new Date(Date.now() - 30_000) : null],
    );
  } else {
    await admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, created_by,
          origin, event_type, event_ref_id, source_system, external_id, stock_location_id, inventory_status)
       VALUES ($1, $2, $3, 'inbound', $4::numeric(19,4), 'each', $5, $6, $7, 'erp_external', 'erp_procurement_receipt', $1,
               'erpnext', 'late-receipt-1', $8, 'sellable')`,
      [lateId, TENANT_A, STORE_A_X, lateQty, PRODUCT_A_ACTIVE, before, COUNTER, primaryLocation],
    );
    await admin.query(
      `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at) VALUES ($1, $2, 'external', $3)`,
      [lateId, TENANT_A, before],
    );
  }

  // The Connector's read-back: the count's ledger row and the late event's ledger row.
  if (o.countLedger !== 'omit') {
    await seedLedgerRow({
      voucherType: DOC.doctype,
      voucherNo: DOC.name,
      qty: '-1',
      date: countStamp.date,
      time: countStamp.time,
      cancelled: o.countLedger === 'cancelled',
    });
  }
  const ledger = o.lateLedger ?? { qty: lateQty, time: '09:59:00' };
  if (ledger !== 'omit') {
    const cancelled = ledger === 'cancelled';
    const l = cancelled ? { qty: lateQty, time: '09:59:00' } : ledger;
    await seedLedgerRow({
      voucherType: lateKind === 'pos_sale' ? 'Sales Invoice' : 'Purchase Receipt',
      voucherNo: lateKind === 'pos_sale' ? 'SINV-2026-00042' : 'MAT-PRE-1',
      qty: l.qty,
      date: 'date' in l && l.date ? l.date : '2026-11-16',
      time: l.time,
      cancelled,
      effectId: lateKind === 'erp_receipt' ? lateId : undefined,
      ...(o.lateWarehouse ? { warehouse: o.lateWarehouse } : {}),
    });
  }
  const bin = o.bin ?? { quantity: counted, readOffsetMs: 300_000 };
  if (bin !== 'none') await seedBin(bin.quantity, bin.readOffsetMs);

  const findings = await counts.listLateEventFindings(as(COUNTER), STORE_A_X, sessionId, null, 50);
  expect(findings.items).toHaveLength(1);
  return { sessionId, findingId: findings.items[0]!.id, lateId, countEffectId, cut };
}

const resolve = (s: Scenario, reason = 'Verified in ERPNext: the count already holds the late sale.', caller = as(APPROVER), storeId = STORE_A_X) =>
  compensation.resolve(caller, storeId, s.sessionId, s.findingId, reason);

async function snapshot(): Promise<Record<string, number>> {
  const n = async (sql: string): Promise<number> => (await admin.query(sql)).rows[0].n as number;
  return {
    compensations: await n(`SELECT count(*)::int AS n FROM count_late_compensations`),
    compensating: await n(`SELECT count(*)::int AS n FROM stock_movements WHERE compensates_effect_id IS NOT NULL`),
    absorbed: await n(`SELECT count(*)::int AS n FROM inventory_effect_integration WHERE state = 'erp_absorbed'`),
    audits: await n(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inventory.count_session.late_compensation'`),
    postings: await n(`SELECT count(*)::int AS n FROM erpnext_posting_status`),
    outbox: await n(`SELECT count(*)::int AS n FROM outbox_events`),
    findings: await n(`SELECT count(*)::int AS n FROM count_late_event_findings`),
    movements: await n(`SELECT count(*)::int AS n FROM stock_movements`),
  };
}

async function book(): Promise<{ operational: number; expected: number; pendingErp: number; pendingRetail: number }> {
  const rows = await runWithTenantContext(env!.app as unknown as Pool, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
    readPendingAwarePositions(c, STORE_A_X),
  );
  const p = rows.find((r) => r.tenantProductRef === PRODUCT_A_ACTIVE)!;
  return {
    operational: Number(p.operationalPosition),
    expected: Number(p.expectedErpBook),
    pendingErp: Number(p.pendingErp),
    pendingRetail: Number(p.pendingRetail),
  };
}

/** A refusal: the typed code, and not one row written anywhere; the finding stays. */
async function expectRefused(s: Scenario, expected: string, over?: () => Promise<unknown>): Promise<void> {
  const before = await snapshot();
  expect(await code((over ?? (() => resolve(s)))())).toBe(expected);
  expect(await snapshot()).toEqual(before);
  expect(before['findings']).toBe(1);
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1424 late compensation');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'lc-counter@fixture.invalid', NULL), ($2, 'lc-approver@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [COUNTER, APPROVER],
  );
  primaryLocation = (
    await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])
  ).rows[0].id as string;
  await admin.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now()) ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, ITEM, COUNTER],
  );
  await admin.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref)
     VALUES (gen_random_uuid(), $1, $2, 'stock', $3) ON CONFLICT DO NOTHING`,
    [TENANT_A, STORE_A_X, WAREHOUSE],
  );
  await admin.query(
    `INSERT INTO erp_stock_import_runs
       (id, tenant_id, store_id, warehouse_map_id, erpnext_warehouse_ref, status, settle_seconds, overlap_seconds, ended_at)
     SELECT gen_random_uuid(), tenant_id, store_id, id, erpnext_warehouse_ref, 'completed', 0, 0, now() + interval '10 years'
       FROM erpnext_warehouse_map WHERE store_id = $1 AND purpose = 'stock' AND retired_at IS NULL`,
    [STORE_A_X],
  );
  // The store is pending-aware: an activated tenant with an anchor whose line is the Bin of 10 at the history.
  anchorSourceRun = nextId();
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now(), '{}'::jsonb)`,
    [anchorSourceRun, TENANT_A, STORE_A_X],
  );
  const anchorId = nextId();
  await admin.query(
    `INSERT INTO inventory_anchors
       (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id, snapshot_read_at,
        snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES ($1, $2, $3, $4, 'sellable', 1, $5, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', $6, '2025-01-01T00:00:00Z',
             '{}'::jsonb, $7)`,
    [anchorId, TENANT_A, STORE_A_X, primaryLocation, anchorSourceRun, WAREHOUSE, COUNTER],
  );
  await admin.query(
    `INSERT INTO inventory_anchor_lines (id, anchor_id, tenant_id, tenant_product_ref, quantity, erp_stock_uom, erpnext_item_ref)
     VALUES ($1, $2, $3, $4, 10, 'each', $5)`,
    [nextId(), anchorId, TENANT_A, PRODUCT_A_ACTIVE, ITEM],
  );
  await admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, count_sessions_enabled, sale_effects_activated_at, sale_effects_activated_by, updated_by)
     VALUES ($1, true, '2025-01-01T00:00:00Z', $2, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET count_sessions_enabled = true, sale_effects_activated_at = '2025-01-01T00:00:00Z',
       sale_effects_activated_by = $2`,
    [TENANT_A, COUNTER],
  );
  const memberships = { findRoleCodeForUserInTenant: async () => role } as unknown as MembershipRepository;
  counts = new CountSessionsService(env.app as unknown as Pool, memberships);
  compensation = new CountLateCompensationService(env.app as unknown as Pool, memberships);
  posting = new ErpnextPostingService(env.app as unknown as Pool);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  jest.restoreAllMocks();
  role = 'owner';
  if (!env) return;
  await admin.query(`DELETE FROM count_late_compensations`);
  await admin.query(`DELETE FROM erp_stock_import_rows`);
  await admin.query(`DELETE FROM erp_stock_import_pages`);
  await admin.query(`DELETE FROM erpnext_reconciliation_run WHERE id <> $1`, [anchorSourceRun]);
  await admin.query(`DELETE FROM count_posting_lines`);
  await admin.query(`DELETE FROM inventory_effect_integration WHERE tenant_id = $1 AND (posting_status_id IS NOT NULL OR effect_id IN (SELECT id FROM stock_movements WHERE store_id = $2))`, [TENANT_A, STORE_A_X]);
  await admin.query(`DELETE FROM erpnext_posting_status WHERE store_id = $1`, [STORE_A_X]);
  for (const t of ['count_late_event_findings', 'count_observations', 'count_session_expected', 'count_session_lines', 'count_sessions']) {
    await admin.query(`DELETE FROM ${t}`);
  }
  await admin.query(`DELETE FROM stock_movements WHERE store_id = $1 AND tenant_product_ref = $2`, [STORE_A_X, PRODUCT_A_ACTIVE]);
  await admin.query(`DELETE FROM stock_counts WHERE store_id = $1`, [STORE_A_X]);
  await admin.query(`DELETE FROM sales WHERE store_id = $1`, [STORE_A_X]);
  await admin.query(`UPDATE tenant_inventory_settings SET count_sessions_enabled = true WHERE tenant_id = $1`, [TENANT_A]);
});

describe('the worked example: Retail 5, ERP 7 resolves to 7 / 7 (AC4)', () => {
  it('a late POS sale already absorbed by the count: +2, erp_absorbed with the count document, no ERP posting', async () => {
    if (skipped()) return;
    const s = await scenario();
    expect(await book()).toMatchObject({ operational: 5, expected: 5 });
    const before = await snapshot();
    const r = await resolve(s);
    expect(r).toMatchObject({
      sessionId: s.sessionId,
      findingId: s.findingId,
      lateEffectId: s.lateId,
      countEffectId: s.countEffectId,
      integrationState: 'erp_absorbed',
      absorbingDocument: DOC,
    });
    expect(Number(r.quantity)).toBe(2);
    const after = await snapshot();
    // ONE new effect, ONE integration row, ONE compensation, ONE audit; no ERP posting row, no outbox event for ERP.
    expect(after['movements']).toBe(before['movements']! + 1);
    expect(after['compensations']).toBe(1);
    expect(after['absorbed']).toBe(1);
    expect(after['audits']).toBe(before['audits']! + 1);
    expect(after['postings']).toBe(before['postings']);
    const eff = (
      await admin.query(
        `SELECT m.quantity::text AS q, m.movement_type, m.compensates_effect_id, i.state, i.posting_status_id, i.erp_confirmed_at,
                i.erp_document_ref, i.state_reason, m.created_by
           FROM stock_movements m JOIN inventory_effect_integration i ON i.effect_id = m.id WHERE m.id = $1`,
        [r.compensationEffectId],
      )
    ).rows[0];
    expect(eff).toMatchObject({
      movement_type: 'count_correction',
      compensates_effect_id: s.countEffectId,
      state: 'erp_absorbed',
      posting_status_id: null,
      erp_confirmed_at: null,
      created_by: APPROVER,
    });
    expect(Number(eff.q)).toBe(2);
    expect(JSON.parse(eff.erp_document_ref)).toEqual(DOC);
    // 7 / 7: operational 7, no pending term, expected 7 = the Bin 7 (class match).
    expect(await book()).toEqual({ operational: 7, expected: 7, pendingErp: 0, pendingRetail: 0 });
    const audit = (await admin.query(`SELECT metadata FROM audit_events WHERE action = 'inventory.count_session.late_compensation'`)).rows[0].metadata;
    expect(audit).toMatchObject({ findingId: s.findingId, lateEffectId: s.lateId, reason: expect.stringContaining('Verified'), erpDocumentCreated: false });
  });

  it('a late ERP-origin receipt (external) absorbed by the count: -2, the ledger row linked by effect id', async () => {
    if (skipped()) return;
    const s = await scenario({ counted: '12', lateQty: '2', lateKind: 'erp_receipt', lateLedger: { qty: '2', time: '09:59:00' } });
    const r = await resolve(s);
    expect(Number(r.quantity)).toBe(-2);
    expect(await book()).toMatchObject({ operational: 12, expected: 12 });
  });

  it('the finding shows its compensation in the list; no original effect was updated', async () => {
    if (skipped()) return;
    const s = await scenario();
    const effects = (await admin.query(`SELECT id, quantity::text AS q, occurred_at, received_at FROM stock_movements WHERE id = ANY($1::uuid[])`, [[s.lateId, s.countEffectId]])).rows;
    const r = await resolve(s);
    const list = await counts.listLateEventFindings(as(COUNTER), STORE_A_X, s.sessionId, null, 50);
    expect(list.items[0]!.compensation).toMatchObject({ id: r.id, integrationState: 'erp_absorbed', absorbingDocument: DOC });
    expect((await admin.query(`SELECT id, quantity::text AS q, occurred_at, received_at FROM stock_movements WHERE id = ANY($1::uuid[])`, [[s.lateId, s.countEffectId]])).rows).toEqual(effects);
  });
});

describe('every one of A to I refuses and writes nothing (AC1)', () => {
  it('A: a finding whose references differ from the late event', async () => {
    if (skipped()) return;
    const s = await scenario();
    await admin.query(`UPDATE count_late_event_findings SET external_id = 'tampered' WHERE id = $1`, [s.findingId]);
    await expectRefused(s, 'compensation_link_invalid');
  });

  it('A: a count with no correction at the late event position', async () => {
    if (skipped()) return;
    const s = await scenario();
    await admin.query(`UPDATE count_session_lines SET correction_effect_ids = '{}' WHERE session_id = $1`, [s.sessionId]);
    await expectRefused(s, 'compensation_link_invalid');
  });

  it('A: a late event learned before the cut', async () => {
    if (skipped()) return;
    const s = await scenario();
    await admin.query(`UPDATE stock_movements SET received_at = $2 WHERE id = $1`, [s.lateId, new Date(s.cut.getTime() - 3_600_000)]);
    await expectRefused(s, 'compensation_link_invalid');
  });

  it('B: no ledger row of the count was read back', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ countLedger: 'omit' }), 'compensation_erp_evidence_missing');
  });

  it('B: no ledger row of the late event was read back', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ lateLedger: 'omit' }), 'compensation_erp_evidence_missing');
  });

  it('B: a late ledger row cancelled after it was read', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ lateLedger: 'cancelled' }), 'compensation_erp_evidence_missing');
  });

  it('B: a ledger row imported before migration 0118 has no posting stamp', async () => {
    if (skipped()) return;
    const s = await scenario();
    await admin.query(`UPDATE erp_stock_import_rows SET posting_date = NULL, posting_time = NULL WHERE voucher_type = 'Sales Invoice'`);
    await expectRefused(s, 'compensation_erp_evidence_missing');
  });

  it('B: the count chunk was not posted by ERP', async () => {
    if (skipped()) return;
    const s = await scenario();
    await admin.query(`UPDATE count_posting_lines SET result = 'verified_noop' WHERE intent_id IN (SELECT id FROM erpnext_posting_status WHERE count_session_id = $1)`, [s.sessionId]);
    await expectRefused(s, 'compensation_erp_evidence_missing');
  });

  it('B: an ERP-origin late row imported for another warehouse than the count is not evidence', async () => {
    if (skipped()) return;
    const s = await scenario({ counted: '12', lateQty: '2', lateKind: 'erp_receipt', lateLedger: { qty: '2', time: '09:59:00' }, lateWarehouse: 'Other - CE' });
    await expectRefused(s, 'compensation_erp_evidence_missing');
  });

  it('D: a second uncompensated late event of the same product refuses (nothing is masked)', async () => {
    if (skipped()) return;
    const s = await scenario();
    await admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, created_by,
          origin, event_type, event_ref_id, source_system, external_id, stock_location_id, inventory_status)
       VALUES ($1, $2, $3, 'outbound', -1, 'each', $4, $5, $6, 'retail', 'sale', $7, 'pos', 'late-sale-2', $8, 'sellable')`,
      [nextId(), TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, new Date(s.cut.getTime() - 30_000).toISOString(), COUNTER, nextId(), primaryLocation],
    );
    await expectRefused(s, 'compensation_book_inconsistent');
  });

  it('C: a late event still pending in ERP (compensating would misstate expected ERP book)', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ lateState: 'pending' }), 'compensation_erp_order_unproven');
  });

  it('C: the late ledger posting is not earlier than the count posting', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ lateLedger: { qty: '-2', time: '10:00:05' } }), 'compensation_erp_order_unproven');
  });

  it('D: unrelated divergence: the Bin is 9, not the 7 the compensation implies', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ bin: { quantity: '9', readOffsetMs: 300_000 } }), 'compensation_book_inconsistent');
  });

  it('D: a stale Bin, read before the late event and the count were confirmed', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ bin: { quantity: '7', readOffsetMs: -3_600_000 } }), 'compensation_book_inconsistent');
  });

  it('D: no Bin snapshot at all', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ bin: 'none' }), 'compensation_book_inconsistent');
  });

  it('E: a blank reason is a 400 and writes nothing; a store_manager is not an authorized role', async () => {
    if (skipped()) return;
    const s = await scenario();
    await expectRefused(s, 'validation_error', () => resolve(s, '   '));
    await expectRefused(s, 'validation_error', () => resolve(s, 'x'.repeat(501)));
    expect(COMPENSATION_ROLES).toEqual(['owner', 'tenant_admin']);
  });

  it('E: a store_manager, and a caller with no membership (a platform admin), are refused 403 and write nothing', async () => {
    if (skipped()) return;
    const s = await scenario();
    for (const r of ['store_manager', 'cashier', null]) {
      role = r;
      await expectRefused(s, 'count_compensation_role_forbidden');
    }
    role = 'tenant_admin';
    expect((await resolve(s)).integrationState).toBe('erp_absorbed');
  });

  it('H: a ledger quantity that is only a part of the late event', async () => {
    if (skipped()) return;
    await expectRefused(await scenario({ lateLedger: { qty: '-1', time: '09:59:00' } }), 'compensation_quantity_mismatch');
  });

  it('I: an invariant that fails after the write rolls the whole transaction back', async () => {
    if (skipped()) return;
    const s = await scenario();
    const real = compensationStore.readBook;
    let calls = 0;
    jest.spyOn(compensationStore, 'readBook').mockImplementation(async (client, storeId) => {
      const book = await real(client, storeId);
      calls += 1;
      if (calls === 2) {
        const p = book.get(PRODUCT_A_ACTIVE)!;
        return new Map(book).set(PRODUCT_A_ACTIVE, { ...p, pendingRetail: '2' });
      }
      return book;
    });
    await expectRefused(s, 'compensation_invariant_failed');
  });
});

describe('deduplication and isolation (AC2)', () => {
  it('G: a replay returns the existing compensation and writes nothing', async () => {
    if (skipped()) return;
    const s = await scenario();
    const first = await resolve(s);
    const before = await snapshot();
    const again = await resolve(s, 'A second, different reason must not matter.');
    expect(again).toEqual(first);
    expect(await snapshot()).toEqual(before);
  });

  it('G: five concurrent calls write exactly one effect and all return it', async () => {
    if (skipped()) return;
    const s = await scenario();
    const before = await snapshot();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => resolve(s)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const after = await snapshot();
    expect(after['compensations']).toBe(1);
    expect(after['compensating']).toBe(1);
    expect(after['absorbed']).toBe(1);
    expect(after['audits']).toBe(before['audits']! + 1);
    expect(await book()).toMatchObject({ operational: 7 });
  });

  it('G: the database refuses a second compensation row of the same late event, whatever the key', async () => {
    if (skipped()) return;
    const s = await scenario();
    const first = await resolve(s);
    await expect(
      admin.query(
        `INSERT INTO count_late_compensations (id, tenant_id, store_id, session_id, tenant_product_ref, late_effect_id, count_effect_id,
            compensation_effect_id, quantity, absorbing_document_ref, reason, approved_by, idempotency_key, evidence)
         SELECT $1, tenant_id, store_id, session_id, tenant_product_ref, late_effect_id, count_effect_id, compensation_effect_id,
                quantity, absorbing_document_ref, reason, approved_by, $2, evidence FROM count_late_compensations WHERE id = $3`,
        [nextId(), 'f'.repeat(64), first.id],
      ),
    ).rejects.toThrow(/uq_count_late_compensations/);
  });

  it('cross-tenant and cross-store attempts fail and write nothing', async () => {
    if (skipped()) return;
    const s = await scenario();
    await expectRefused(s, 'NotFoundException', () => resolve(s, 'because', as(APPROVER, TENANT_B)));
    await expectRefused(s, 'NotFoundException', () => resolve(s, 'because', as(APPROVER), STORE_A_Y));
  });

  it('is dark: a tenant that switched Count Sessions off gets the non-disclosing 404', async () => {
    if (skipped()) return;
    const s = await scenario();
    await admin.query(`UPDATE tenant_inventory_settings SET count_sessions_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    await expectRefused(s, 'NotFoundException');
  });

  it('the compensation table is append-only for the application role', async () => {
    if (skipped()) return;
    const s = await scenario();
    const r = await resolve(s);
    const app = env!.app as unknown as Pool;
    // No UPDATE or DELETE policy: row security filters every row, so nothing changes.
    await runWithTenantContext(app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (c) => {
      expect((await c.query(`UPDATE count_late_compensations SET reason = 'x' WHERE id = $1`, [r.id])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM count_late_compensations WHERE id = $1`, [r.id])).rowCount).toBe(0);
    });
    expect((await admin.query(`SELECT reason FROM count_late_compensations WHERE id = $1`, [r.id])).rows[0].reason).toBe(r.reason);
  });
});

describe('the state is terminal and reachable by nothing else (AC5)', () => {
  it('no posting signal can move an erp_absorbed effect', () => {
    for (const signal of ['posted', 'failed_transient', 'permanently_rejected', 'reconciliation_required', 'repair_re_post'] as const) {
      expect(decideTransition('erp_absorbed' as never, signal)).toEqual({ kind: 'illegal' });
    }
  });

  it('the database refuses an erp_absorbed row without a document, with an intent, or without a reason', async () => {
    if (skipped()) return;
    const s = await scenario();
    const r = await resolve(s);
    const id = r.compensationEffectId;
    await expect(admin.query(`UPDATE inventory_effect_integration SET erp_document_ref = NULL WHERE effect_id = $1`, [id])).rejects.toThrow(/erp_absorbed_shape/);
    await expect(admin.query(`UPDATE inventory_effect_integration SET state_reason = NULL WHERE effect_id = $1`, [id])).rejects.toThrow(/erp_absorbed_shape/);
    await expect(admin.query(`UPDATE inventory_effect_integration SET erp_confirmed_at = now() WHERE effect_id = $1`, [id])).rejects.toThrow();
    await expect(
      admin.query(`UPDATE inventory_effect_integration SET posting_status_id = (SELECT id FROM erpnext_posting_status LIMIT 1) WHERE effect_id = $1`, [id]),
    ).rejects.toThrow();
  });
});
