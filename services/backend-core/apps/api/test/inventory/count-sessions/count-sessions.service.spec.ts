/**
 * Jira RT-1420 — the Count Session domain (`CountSessionsService`, contract
 * `inventory/inventory.yaml` 1.15.0-draft) against real Postgres (Testcontainers,
 * every migration, the NOBYPASSRLS `app_test` role).
 *
 * Proves, per the issue's acceptance criteria:
 *   1. dark by default; cross-tenant access is refused; a tracked product is refused;
 *   2. every lifecycle transition, illegal ones, and recount;
 *   3. variance uses effects recorded before the cut only;
 *   4. a late pre-cut event invalidates exactly the affected line before approval,
 *      and raises a finding with no stock movement after it (POS and ERP-origin);
 *   5. the approval policy: counter and submitter refused; the owner-only exception
 *      records its reason and marks the session; a non-owner cannot enable it;
 *   6. approval writes the corrections once (replay and concurrent calls) and no
 *      posting artefact exists afterwards;
 *   7. the barrier refuses a cut while a till's sale queue is not drained.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';

import type { MembershipRepository } from '../../../src/context/membership.repository';
import {
  CountSessionsService,
  type CountCaller,
} from '../../../src/inventory/count-sessions/count-sessions.service';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
  STORE_A_X,
  TENANT_A,
  TENANT_B,
  ACTOR_B,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

const COUNTER = ACTOR_A;
const APPROVER = '0a000000-0000-7000-8000-00000000c0a1';

let env: PgTestEnv | null = null;
let admin: Pool;
let service: CountSessionsService;
let role = 'owner';
let primaryLocation = '';

const as = (userId: string, tenantId = TENANT_A): CountCaller => ({ tenantId, userId });
const skipped = (): boolean => env === null;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    const c = (r as { code?: string } | undefined)?.code;
    return c ?? (e as Error).constructor.name;
  }
  return 'ok';
}

async function seedEffect(
  productId: string,
  quantity: string,
  opts: { receivedAt?: string; occurredAt?: string; confirmed?: boolean; erpOrigin?: boolean } = {},
): Promise<string> {
  const id = `0a000000-0000-7000-8000-${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`;
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at, received_at,
        created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, 'inbound', $4::numeric(19,4), 'each', $5, COALESCE($6::timestamptz, now()),
             COALESCE($7::timestamptz, now()), $8, $9, $10, $11, $12, 'sellable')`,
    [
      id, TENANT_A, STORE_A_X, quantity, productId, opts.occurredAt ?? null, opts.receivedAt ?? null, COUNTER,
      opts.erpOrigin ? 'erp_external' : 'retail',
      opts.erpOrigin ? 'erp_procurement_receipt' : null,
      opts.erpOrigin ? id : null,
      primaryLocation,
    ],
  );
  // A confirmed Retail effect needs an ERP posting intent (a fixture of its own), so history is
  // seeded only for an ERP-origin effect, which carries the `external` state and no intent.
  if (opts.confirmed && opts.erpOrigin) {
    await admin.query(
      `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at)
       VALUES ($1, $2, 'external', COALESCE($3::timestamptz, now()))`,
      [id, TENANT_A, opts.occurredAt ?? null],
    );
  }
  return id;
}

async function openSession(products: string[] = [PRODUCT_A_ACTIVE]): Promise<string> {
  return (await service.createSession(as(COUNTER), STORE_A_X, products, 'test')).id;
}

async function observe(sessionId: string, product: string, quantity: string, user = COUNTER): Promise<void> {
  await service.recordObservations(as(user), STORE_A_X, sessionId, [
    { productId: product, locationId: primaryLocation, inventoryStatus: 'sellable', countedQuantity: quantity, stockingUnit: 'each' },
  ]);
}

/** open -> observe -> cut -> submit, returning the session id. */
async function submitted(product = PRODUCT_A_ACTIVE, quantity = '7'): Promise<string> {
  const id = await openSession([product]);
  await observe(id, product, quantity);
  await service.takeCut(as(COUNTER), STORE_A_X, id);
  await service.submit(as(COUNTER), STORE_A_X, id);
  return id;
}

async function corrections(sessionId: string): Promise<number> {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM stock_movements m
       JOIN count_session_lines l ON m.id = ANY(l.correction_effect_ids) WHERE l.session_id = $1`,
    [sessionId],
  );
  return r.rows[0].n as number;
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1420 count sessions');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'cs-counter@fixture.invalid', NULL), ($2, 'cs-approver@fixture.invalid', NULL), ($3, 'cs-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [COUNTER, APPROVER, ACTOR_B],
  );
  primaryLocation = (
    await admin.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A_X])
  ).rows[0].id as string;
  for (const [i, p] of [PRODUCT_A_ACTIVE, PRODUCT_A_RETIRED].entries()) {
    await admin.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now()) ON CONFLICT DO NOTHING`,
      [TENANT_A, p, `ITEM-CS-${i}`, COUNTER],
    );
  }
  // RT-1423: an approved line with a variance becomes an ERP intent, which needs the store's stock warehouse.
  await admin.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'Stores - CS') ON CONFLICT DO NOTHING`,
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
  service = new CountSessionsService(env.app as unknown as Pool, memberships);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  role = 'owner';
  if (!env) return;
  // RT-1423: an approval now writes chunks (posting rows, frozen lines, effect links); they reference the
  // session and the effects, so they go first.
  await admin.query(`DELETE FROM count_posting_lines`);
  await admin.query(
    `DELETE FROM inventory_effect_integration WHERE posting_status_id IN
       (SELECT id FROM erpnext_posting_status WHERE kind = 'inventory_count')`,
  );
  await admin.query(`DELETE FROM erpnext_posting_status WHERE kind = 'inventory_count'`);
  await admin.query(`DELETE FROM count_late_event_findings`);
  await admin.query(`DELETE FROM count_observations`);
  await admin.query(`DELETE FROM count_session_expected`);
  await admin.query(`DELETE FROM count_session_lines`);
  await admin.query(`DELETE FROM count_sessions`);
  await admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, count_sessions_enabled, count_self_approval_enabled, updated_by)
     VALUES ($1, true, false, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET count_sessions_enabled = true, count_self_approval_enabled = false,
       count_self_approval_reason = NULL, count_self_approval_changed_at = NULL, count_self_approval_changed_by = NULL`,
    [TENANT_A, COUNTER],
  );
  // A clean ledger for the counted products: the count tests seed their own effects.
  const products = [PRODUCT_A_ACTIVE, PRODUCT_A_RETIRED];
  await admin.query(`DELETE FROM inventory_effect_integration WHERE tenant_id = $1 AND effect_id IN (
                       SELECT id FROM stock_movements WHERE store_id = $2 AND tenant_product_ref = ANY($3::uuid[]))`,
    [TENANT_A, STORE_A_X, products]);
  await admin.query(`DELETE FROM stock_movements WHERE store_id = $1 AND tenant_product_ref = ANY($2::uuid[])`, [STORE_A_X, products]);
  await admin.query(`DELETE FROM stock_counts WHERE store_id = $1`, [STORE_A_X]);
});

describe('dark by default, scope and isolation (AC1)', () => {
  it('answers 404 until the tenant is switched on', async () => {
    if (skipped()) return;
    await admin.query(`UPDATE tenant_inventory_settings SET count_sessions_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    expect(await code(service.createSession(as(COUNTER), STORE_A_X, [PRODUCT_A_ACTIVE], null))).toBe('NotFoundException');
  });

  it("refuses another tenant's session and a store outside the tenant (non-disclosing 404)", async () => {
    if (skipped()) return;
    const id = await openSession();
    await admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, count_sessions_enabled, updated_by) VALUES ($1, true, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET count_sessions_enabled = true`,
      [TENANT_B, ACTOR_B],
    );
    expect(await code(service.getSession(as(ACTOR_B, TENANT_B), STORE_A_X, id))).toBe('NotFoundException');
    expect(await code(service.createSession(as(ACTOR_B, TENANT_B), STORE_A_X, [PRODUCT_A_ACTIVE], null))).toBe('NotFoundException');
  });

  it('the app role sees no session without a tenant context (FORCE RLS)', async () => {
    if (skipped()) return;
    await openSession();
    const r = await (env!.app as unknown as Pool).query('SELECT count(*)::int AS n FROM count_sessions');
    expect(r.rows[0].n).toBe(0);
  });

  it('refuses a product already in a live session of the store', async () => {
    if (skipped()) return;
    await openSession();
    expect(await code(service.createSession(as(COUNTER), STORE_A_X, [PRODUCT_A_ACTIVE], null))).toBe('count_scope_in_use');
  });
});

describe('tracked products are refused (AC1)', () => {
  const P_BATCH = '0a000000-0000-7000-8000-0000000c7001';
  const P_SERIAL = '0a000000-0000-7000-8000-0000000c7002';
  const P_PLAIN = '0a000000-0000-7000-8000-0000000c7003';
  const FIXTURE = [P_BATCH, P_SERIAL, P_PLAIN];

  beforeEach(async () => {
    if (!env) return;
    await admin.query(`DELETE FROM tenant_products WHERE id = ANY($1::uuid[])`, [FIXTURE]);
    await admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
       VALUES ($1, $4, 'CS Batch', 'standard', $5, $5, 'batch'),
              ($2, $4, 'CS Serial', 'standard', $5, $5, 'serial'),
              ($3, $4, 'CS Plain', 'standard', $5, $5, 'none')`,
      [P_BATCH, P_SERIAL, P_PLAIN, TENANT_A, COUNTER],
    );
  });

  afterAll(async () => {
    if (!env) return;
    await admin.query(`DELETE FROM count_session_lines`);
    await admin.query(`DELETE FROM count_sessions`);
    await admin.query(`DELETE FROM tenant_products WHERE id = ANY($1::uuid[])`, [FIXTURE]);
  });

  async function writes(): Promise<{ sessions: number; lines: number; audits: number }> {
    const r = await admin.query(
      `SELECT (SELECT count(*)::int FROM count_sessions) AS sessions,
              (SELECT count(*)::int FROM count_session_lines) AS lines,
              (SELECT count(*)::int FROM audit_events WHERE action = 'inventory.count_session.open') AS audits`,
    );
    return r.rows[0] as { sessions: number; lines: number; audits: number };
  }

  async function refusal(products: string[]): Promise<unknown> {
    try {
      await service.createSession(as(COUNTER), STORE_A_X, products, null);
    } catch (e) {
      return e;
    }
    return null;
  }

  it.each([
    ['batch', P_BATCH],
    ['serial', P_SERIAL],
  ])('refuses a %s-tracked product with 409 count_tracked_product_refused and writes nothing', async (_mode, product) => {
    if (skipped()) return;
    const before = await writes();
    const error = await refusal([product]);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect(((error as ConflictException).getResponse() as { code?: string }).code).toBe('count_tracked_product_refused');
    expect(await writes()).toEqual(before);
  });

  it.each([
    ['batch', P_BATCH],
    ['serial', P_SERIAL],
  ])('refuses the whole scope when a %s-tracked product is included with an untracked one', async (_mode, tracked) => {
    if (skipped()) return;
    const before = await writes();
    const error = await refusal([PRODUCT_A_ACTIVE, tracked]);
    expect(error).toBeInstanceOf(ConflictException);
    expect(((error as ConflictException).getResponse() as { code?: string }).code).toBe('count_tracked_product_refused');
    // No partial session: the untracked product is still free to open on its own.
    expect(await writes()).toEqual(before);
    expect(await code(service.createSession(as(COUNTER), STORE_A_X, [PRODUCT_A_ACTIVE], null))).toBe('ok');
  });

  it('still accepts an untracked product', async () => {
    if (skipped()) return;
    const session = await service.createSession(as(COUNTER), STORE_A_X, [P_PLAIN], null);
    expect(session.state).toBe('open');
    const after = await writes();
    expect(after.sessions).toBe(1);
    expect(after.lines).toBe(1);
  });
});

describe('lifecycle (AC2)', () => {
  it('open -> cut -> submit -> approve, with illegal transitions refused', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true });
    const id = await openSession();
    expect(await code(service.submit(as(COUNTER), STORE_A_X, id))).toBe('count_session_not_in_state');
    expect(await code(service.approve(as(APPROVER), STORE_A_X, id, []))).toBe('count_session_not_in_state');
    await observe(id, PRODUCT_A_ACTIVE, '7');
    expect((await service.takeCut(as(COUNTER), STORE_A_X, id)).state).toBe('cut_taken');
    expect(await code(service.takeCut(as(COUNTER), STORE_A_X, id))).toBe('count_session_not_in_state');
    expect((await service.submit(as(COUNTER), STORE_A_X, id)).state).toBe('submitted');
    expect(await code(service.recordObservations(as(COUNTER), STORE_A_X, id, [
      { productId: PRODUCT_A_ACTIVE, locationId: primaryLocation, inventoryStatus: 'sellable', countedQuantity: '1', stockingUnit: 'each' },
    ]))).toBe('count_session_not_in_state');
    const lines = await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50);
    const ackLine = lines.items[0]!;
    const approved = await service.approve(as(APPROVER), STORE_A_X, id, ackLine.acknowledgementRequired
      ? [{ productId: ackLine.productId, lineVersion: ackLine.lineVersion, note: null }] : []);
    // RT-1423: the approved lines were emitted as chunks in the same transaction, so the session is posting.
    expect(approved.state).toBe('posting');
    expect(approved.approval).toMatchObject({ policy: 'strict_separation', selfApproved: false });
    expect(await code(service.cancel(as(COUNTER), STORE_A_X, id, 'too late'))).toBe('count_session_not_in_state');
  });

  it('cancels from open, cut_taken and submitted, keeping the audit', async () => {
    if (skipped()) return;
    const a = await openSession();
    expect((await service.cancel(as(COUNTER), STORE_A_X, a, 'changed my mind')).state).toBe('cancelled');
    const b = await submitted();
    expect((await service.cancel(as(COUNTER), STORE_A_X, b, 'wrong shelf')).cancellation?.reason).toBe('wrong shelf');
  });

  it('recount returns a submitted session to cut_taken, resets the listed line and refuses a stale acknowledgement', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true });
    const id = await submitted();
    const before = (await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50)).items[0]!;
    const recount = await service.requestRecount(as(APPROVER), STORE_A_X, id, [PRODUCT_A_ACTIVE], 'recount please');
    expect(recount.state).toBe('cut_taken');
    expect(recount.cut?.watermark).toBeTruthy();
    expect(await code(service.submit(as(COUNTER), STORE_A_X, id))).toBe('BadRequestException');
    await observe(id, PRODUCT_A_ACTIVE, '8');
    await service.submit(as(COUNTER), STORE_A_X, id);
    const after = (await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50)).items[0]!;
    expect(Number(after.lineVersion)).toBeGreaterThan(Number(before.lineVersion));
    expect(after.countedQuantity).toBe('8.0000');
    expect(await code(service.approve(as(APPROVER), STORE_A_X, id, [
      { productId: PRODUCT_A_ACTIVE, lineVersion: before.lineVersion, note: null },
    ]))).toBe('count_line_version_stale');
  });
});

describe('variance at the cut (AC3)', () => {
  it('uses effects recorded before the cut only', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true, receivedAt: '2020-01-01T00:00:00Z', occurredAt: '2020-01-01T00:00:00Z' });
    const id = await openSession();
    await observe(id, PRODUCT_A_ACTIVE, '7');
    await service.takeCut(as(COUNTER), STORE_A_X, id);
    await seedEffect(PRODUCT_A_ACTIVE, '5'); // received and occurred after the cut
    await service.submit(as(COUNTER), STORE_A_X, id);
    const line = (await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50)).items[0]!;
    expect(line.expectedQuantity).toBe('10.0000');
    expect(line.varianceQuantity).toBe('-3.0000');
    expect((await service.listLateEventFindings(as(COUNTER), STORE_A_X, id, null, 50)).items).toHaveLength(0);
  });
});

describe('late pre-cut events (AC4)', () => {
  it('before approval invalidates exactly the affected line and returns the session to review (POS)', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true, receivedAt: '2020-01-01T00:00:00Z', occurredAt: '2020-01-01T00:00:00Z' });
    await seedEffect(PRODUCT_A_RETIRED, '4', { confirmed: true, receivedAt: '2020-01-01T00:00:00Z', occurredAt: '2020-01-01T00:00:00Z' });
    const id = await openSession([PRODUCT_A_ACTIVE, PRODUCT_A_RETIRED]);
    await observe(id, PRODUCT_A_ACTIVE, '7');
    await observe(id, PRODUCT_A_RETIRED, '4');
    await service.takeCut(as(COUNTER), STORE_A_X, id);
    await service.submit(as(COUNTER), STORE_A_X, id);
    const reviewed = await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50);
    const versions = Object.fromEntries(reviewed.items.map((l) => [l.productId, l.lineVersion]));
    // A sale of 2 made before the cut reaches Backend-Core after it.
    await seedEffect(PRODUCT_A_ACTIVE, '-2', { occurredAt: '2020-01-02T00:00:00Z' });
    const session = await service.getSession(as(COUNTER), STORE_A_X, id);
    expect(session.state).toBe('cut_taken');
    expect(session.lateEventFindingCount).toBe(1);
    const findings = await service.listLateEventFindings(as(COUNTER), STORE_A_X, id, null, 50);
    expect(findings.items[0]).toMatchObject({ productId: PRODUCT_A_ACTIVE, assessment: 'understated', quantity: '2.0000', oversellRisk: false });
    await observe(id, PRODUCT_A_ACTIVE, '7');
    await service.submit(as(COUNTER), STORE_A_X, id);
    const again = Object.fromEntries(
      (await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50)).items.map((l) => [l.productId, l.lineVersion]),
    );
    expect(Number(again[PRODUCT_A_ACTIVE])).toBeGreaterThan(Number(versions[PRODUCT_A_ACTIVE]));
    expect(again[PRODUCT_A_RETIRED]).toBe(versions[PRODUCT_A_RETIRED]);
  });

  it('after approval raises a finding, moves the session to needs_attention and moves no stock (POS)', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true, receivedAt: '2020-01-01T00:00:00Z', occurredAt: '2020-01-01T00:00:00Z' });
    const id = await submitted();
    await service.approve(as(APPROVER), STORE_A_X, id, await acks(id));
    const movementsBefore = (await admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_A_X])).rows[0].n;
    await seedEffect(PRODUCT_A_ACTIVE, '3', { occurredAt: '2020-01-02T00:00:00Z' }); // a late receipt
    const movementsAfterSeed = movementsBefore + 1;
    const session = await service.getSession(as(COUNTER), STORE_A_X, id);
    expect(session.state).toBe('needs_attention');
    const f = (await service.listLateEventFindings(as(COUNTER), STORE_A_X, id, null, 50)).items[0]!;
    expect(f).toMatchObject({ assessment: 'overstated', quantity: '3.0000', oversellRisk: true, detectedInState: 'posting' });
    const movementsNow = (await admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE store_id = $1`, [STORE_A_X])).rows[0].n;
    expect(movementsNow).toBe(movementsAfterSeed); // the finding added no movement
  });

  it('judges an ERP-origin imported event by its ERP stamp', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true, receivedAt: '2020-01-01T00:00:00Z', occurredAt: '2020-01-01T00:00:00Z' });
    const id = await submitted();
    await seedEffect(PRODUCT_A_ACTIVE, '6', { erpOrigin: true, confirmed: true, occurredAt: '2020-01-02T00:00:00Z' });
    const findings = await service.listLateEventFindings(as(COUNTER), STORE_A_X, id, null, 50);
    expect(findings.items).toHaveLength(1);
    expect(findings.items[0]!.linkedEvent.eventType).toBe('erp_procurement_receipt');
  });
});

async function acks(id: string): Promise<Array<{ productId: string; lineVersion: string; note: string | null }>> {
  const lines = await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50);
  return lines.items.filter((l) => l.acknowledgementRequired).map((l) => ({ productId: l.productId, lineVersion: l.lineVersion, note: null }));
}

describe('approval policy (AC5)', () => {
  it('refuses the counter and the submitter, and the exception is owner-only with a reason', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true });
    const id = await submitted();
    expect(await code(service.approve(as(COUNTER), STORE_A_X, id, await acks(id)))).toBe('count_approver_conflict');

    role = 'tenant_admin';
    expect(await code(service.setSelfApprovalException(as(COUNTER), true, 'small shop'))).toBe('count_self_approval_owner_only');
    expect(await code(service.getSelfApprovalException(as(COUNTER)))).toBe('count_self_approval_owner_only');
    role = 'owner';
    expect(await code(service.setSelfApprovalException(as(COUNTER), true, '   '))).toBe('BadRequestException');
    expect(await service.setSelfApprovalException(as(COUNTER), true, 'one person runs this shop')).toMatchObject({
      enabled: true,
      reason: 'one person runs this shop',
      changedBy: COUNTER,
    });
    expect((await service.getSelfApprovalException(as(COUNTER))).enabled).toBe(true);

    const approved = await service.approve(as(COUNTER), STORE_A_X, id, await acks(id));
    expect(approved.approval).toMatchObject({ policy: 'small_merchant_exception', selfApproved: true, approvedBy: COUNTER });
    const row = (await admin.query(`SELECT approval_reason FROM count_sessions WHERE id = $1`, [id])).rows[0];
    expect(row.approval_reason).toBe('one person runs this shop');
    const audit = await admin.query(
      `SELECT metadata FROM audit_events WHERE action = 'inventory.count_session.approve' AND target_id = $1`, [id]);
    expect(audit.rows[0].metadata).toMatchObject({ selfApproved: true, policy: 'small_merchant_exception' });
  });
});

describe('approval writes the corrections once (AC6)', () => {
  it('appends count_correction effects, links them to ONE chunk (pending), and a replay writes nothing', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true });
    const id = await submitted();
    const postingBefore = (await admin.query(`SELECT count(*)::int AS n FROM erpnext_posting_status`)).rows[0].n;
    await service.approve(as(APPROVER), STORE_A_X, id, await acks(id));
    expect(await corrections(id)).toBe(1);
    const eff = await admin.query(
      `SELECT m.quantity::text AS q, m.movement_type, ei.state FROM stock_movements m
         JOIN inventory_effect_integration ei ON ei.effect_id = m.id
         JOIN count_session_lines l ON m.id = ANY(l.correction_effect_ids) WHERE l.session_id = $1`, [id]);
    // RT-1423: the effect is linked to its chunk in the same transaction, so it is pending, and exactly one
    // chunk was written.
    expect(eff.rows).toEqual([{ q: '-3.0000', movement_type: 'count_correction', state: 'pending' }]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM erpnext_posting_status`)).rows[0].n).toBe(postingBefore + 1);
    expect(await code(service.approve(as(APPROVER), STORE_A_X, id, []))).toBe('count_session_not_in_state');
    expect(await corrections(id)).toBe(1);
  });

  it('writes the corrections once under concurrent approvals', async () => {
    if (skipped()) return;
    await seedEffect(PRODUCT_A_ACTIVE, '10', { confirmed: true });
    const id = await submitted();
    const a = await acks(id);
    const results = await Promise.allSettled([
      service.approve(as(APPROVER), STORE_A_X, id, a),
      service.approve(as(APPROVER), STORE_A_X, id, a),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await corrections(id)).toBe(1);
  });

  it('refuses a count-up with no valuation history on its line and writes no correction for it', async () => {
    if (skipped()) return;
    const id = await submitted(PRODUCT_A_RETIRED, '5'); // nothing in the ledger: counted above expected 0
    const line = (await service.listVarianceLines(as(COUNTER), STORE_A_X, id, null, null, 50)).items[0]!;
    expect(line.refusal?.code).toBe('count_up_without_valuation_history');
    const approved = await service.approve(as(APPROVER), STORE_A_X, id, await acks(id));
    // RT-1423: the only line was refused, so no chunk exists and the session needs attention (it could not post).
    expect(approved.state).toBe('needs_attention');
    expect(await corrections(id)).toBe(0);
  });
});

describe('Count Cut barrier (AC7)', () => {
  it('refuses the cut while a till has a pending sale, naming the device, and allows it once drained', async () => {
    if (skipped()) return;
    const device = '0a000000-0000-7000-8000-00000000de01';
    await admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1, $2, $3, decode(repeat('ab', 32), 'hex'))
       ON CONFLICT (id) DO NOTHING`,
      [device, TENANT_A, STORE_A_X],
    );
    await admin.query(
      `INSERT INTO device_health (device_id, tenant_id, last_seen_at, sale_queue_pending, sale_queue_dead_letter, sale_queue_held)
       VALUES ($1, $2, now() + interval '1 hour', 2, 0, 0)
       ON CONFLICT (device_id) DO UPDATE SET sale_queue_pending = 2, last_seen_at = now() + interval '1 hour'`,
      [device, TENANT_A],
    );
    const id = await openSession();
    const refused = await service.takeCut(as(COUNTER), STORE_A_X, id).catch((e: ConflictException) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({
      code: 'count_cut_barrier_not_met',
      details: { devices: [{ deviceId: device, reason: 'queue_pending' }], warehouses: [] },
    });
    expect((await service.getSession(as(COUNTER), STORE_A_X, id)).state).toBe('open');
    await admin.query(`UPDATE device_health SET sale_queue_pending = 0 WHERE device_id = $1`, [device]);
    expect((await service.takeCut(as(COUNTER), STORE_A_X, id)).state).toBe('cut_taken');
    await admin.query(`DELETE FROM device_health WHERE device_id = $1`, [device]);
    await admin.query(`DELETE FROM devices WHERE id = $1`, [device]);
  });
});

describe('guards', () => {
  it('rejects an observation outside the scope and an unknown location', async () => {
    if (skipped()) return;
    const id = await openSession();
    expect(await code(service.recordObservations(as(COUNTER), STORE_A_X, id, [
      { productId: PRODUCT_A_RETIRED, locationId: primaryLocation, inventoryStatus: 'sellable', countedQuantity: '1', stockingUnit: 'each' },
    ]))).toBe(BadRequestException.name);
    expect(await code(service.recordObservations(as(COUNTER), STORE_A_X, id, [
      { productId: PRODUCT_A_ACTIVE, locationId: '0a000000-0000-7000-8000-0000000000ff', inventoryStatus: 'sellable', countedQuantity: '1', stockingUnit: 'each' },
    ]))).toBe(BadRequestException.name);
    expect(ForbiddenException).toBeDefined();
    expect(NotFoundException).toBeDefined();
  });
});
