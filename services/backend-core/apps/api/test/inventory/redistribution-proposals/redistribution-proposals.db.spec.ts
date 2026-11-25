/**
 * Jira RT-1600 — the W9 redistribution proposal runtime (`RedistributionProposalsService`) against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 *
 * Proves (RT-1600 acceptance, the numbers of the Jira list):
 *   1. cross-tenant: another tenant's proposal is the non-disclosing 404 for every read and command, and its list is empty;
 *   4. the freshness gate: a store whose active till has an unknown queue, dead-letter / held sales or a stale
 *      heartbeat is excluded as a SOURCE (with its reason and read time on the proposal); revoked tills are ignored;
 *   5. supersede: every compute retires the live proposal (open or partially_accepted; by a newer one, or by one that
 *      finds nothing to move) and audits `supersede` on it; a proposal past its expiry is reported `expired`, its
 *      commands are 409 `proposal_expired`, and a later compute stores `expired` (audited `expire`), never `superseded`;
 *   6. accept is atomic: a failure while creating the second draft Transfer leaves no Transfer, no outcome, no state
 *      change and no audit row;
 *   8. accept drops and reduces lines against current state, records both quantities and the reason;
 *   9. accept makes one draft per store pair, at most 100 lines each;
 *  10. accept creates W3 drafts only: no approval, no reservation, reason `Redistribution proposal <id>`;
 *   plus `proposal_stale` (every line would be dropped: nothing written), `proposal_line_already_decided`,
 *   review / reject and their 409s.
 * Role denial (2), the allowlist 404 (3) and the replayed accept (7) need the HTTP stack: see
 * `redistribution-proposals.http.integration.spec.ts`.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { Pool } from 'pg';

import { transferErpAdapter } from '../../../src/catalog/erpnext-posting/transfer-erp.adapter';
import type { MembershipRepository } from '../../../src/context/membership.repository';
import { resolveRedistributionAllowlist } from '../../../src/inventory/redistribution-proposals/redistribution-allowlist.config';
import {
  RedistributionProposalsService,
  type RedistributionCaller,
} from '../../../src/inventory/redistribution-proposals/redistribution-proposals.service';
import { ShipmentTransfersService } from '../../../src/inventory/shipment-transfers/shipment-transfers.service';
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

const hex = (n: number): string => `0a000000-0000-7000-8000-${(0x160000000000 + n).toString(16).padStart(12, '0')}`;
const STORE_A_Z = hex(0xa5a3);
const OWNER = ACTOR_A;
const HOUR = 60 * 60 * 1000;

interface Line {
  id: string;
  productId: string;
  sourceStoreId: string;
  destinationStoreId: string;
  quantity: string;
  acceptOutcome: { outcome: string; createdQuantity: string | null; transferId: string | null; reason: string | null } | null;
  reviewDecision: { decision: string } | null;
}
interface Proposal {
  id: string;
  state: string;
  acceptEnabled: boolean;
  decidedAt: string | null;
  supersededBy: string | null;
  stores: { storeId: string; eligibleAsSource: boolean; exclusion: string | null; readAt: string }[];
  lines: Line[];
}

let env: PgTestEnv | null = null;
let admin: Pool;
let svc: RedistributionProposalsService;
let transfers: ShipmentTransfersService;
let memberships: MembershipRepository;
let seq = 0;

const skipped = (): boolean => env === null;
const nextId = (): string => hex(0x100000 + ++seq);

const callerOf = (tenantId: string, userId: string): RedistributionCaller => ({
  tenantId,
  userId,
  context: { userId, tenantId, storeId: null, isPlatformAdmin: false, source: 'session', storeAccess: { kind: 'all' } },
});
const ownerA = (): RedistributionCaller => callerOf(TENANT_A, OWNER);
const ownerB = (): RedistributionCaller => callerOf(TENANT_B, ACTOR_B);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    if (typeof r === 'object' && r !== null && typeof (r as { code?: unknown }).code === 'string') return (r as { code: string }).code;
    const status = (e as { getStatus?: () => number }).getStatus?.();
    return status === 404 ? 'not_found' : (e as Error).constructor.name;
  }
  return 'ok';
}

const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await admin.query(sql, params)).rows[0].n);

/** The metadata of every audit row of `action` on proposal `targetId`. */
const audits = async (action: string, targetId: string): Promise<Record<string, unknown>[]> =>
  (await admin.query(`SELECT metadata FROM audit_events WHERE action = $1 AND target_id = $2`, [`inventory.redistribution_proposal.${action}`, targetId]))
    .rows.map((r: { metadata: Record<string, unknown> }) => r.metadata);

/** A sellable product of tenant A (priced, untracked) with a tenant-default reorder level. */
async function product(level = '10'): Promise<string> {
  const productId = nextId();
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, default_price, default_currency_code, created_by, updated_by, tracking_mode)
     VALUES ($1, $2, $3, 'standard', 10.00, 'EGP', $4, $4, 'none')`,
    [productId, TENANT_A, `RT1600 ${productId.slice(-6)}`, OWNER],
  );
  await admin.query(
    `INSERT INTO product_stock_levels (id, tenant_id, product_id, store_id, reorder_level, created_by, updated_by)
     VALUES ($1, $2, $3, NULL, $4::numeric, $5, $5)`,
    [nextId(), TENANT_A, productId, level, OWNER],
  );
  return productId;
}

/** A manual inbound movement in the unit `piece` (establishes the unit at the store). */
async function stock(storeId: string, productId: string, quantity: string): Promise<void> {
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, 'inbound', $4::numeric, 'piece', $5, 'rt1600 seed', now(), $6,
             (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), 'sellable')`,
    [nextId(), TENANT_A, storeId, quantity, productId, OWNER],
  );
}

/** A till at `storeId`: `health` null leaves it with no stored beat (unknown queue). */
async function till(
  storeId: string,
  health: { lastSeenMinutesAgo: number; deadLetter?: number; held?: number } | null,
  revoked = false,
): Promise<void> {
  const deviceId = nextId();
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash, revoked_at)
     VALUES ($1, $2, $3, decode(md5($1::text) || md5($1::text), 'hex'), $4)`,
    [deviceId, TENANT_A, storeId, revoked ? new Date() : null],
  );
  if (health === null) return;
  await admin.query(
    `INSERT INTO device_health (device_id, tenant_id, last_seen_at, sale_queue_pending, sale_queue_dead_letter, sale_queue_held)
     VALUES ($1, $2, now() - make_interval(mins => $3), 0, $4, $5)`,
    [deviceId, TENANT_A, health.lastSeenMinutesAgo, health.deadLetter ?? 0, health.held ?? 0],
  );
}

/** One product: X 50 (surplus 39), Y 2 (gap 8), Z 0 (gap 10) -> lines X->Y 8 and X->Z 10. */
async function twoLineScenario(): Promise<string> {
  const p = await product();
  await stock(STORE_A_X, p, '50');
  await stock(STORE_A_Y, p, '2');
  return p;
}

async function compute(caller = ownerA()): Promise<{ status: number; body: Record<string, unknown> }> {
  return await svc.compute(caller, undefined);
}

async function proposed(): Promise<Proposal> {
  const r = await compute();
  expect(r.status).toBe(201);
  return r.body as unknown as Proposal;
}

const get = async (id: string, caller = ownerA()): Promise<Proposal> => (await svc.get(caller, id)) as unknown as Proposal;
const lineTo = (p: Proposal, storeId: string): Line => p.lines.find((l) => l.destinationStoreId === storeId)!;

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1600 redistribution proposals');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt1600-a@fixture.invalid', NULL), ($2, 'rt1600-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [OWNER, ACTOR_B],
  );
  await admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'AZ', 'RT1600 Store A-Z')`, [STORE_A_Z, TENANT_A]);
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
  const allowlist = resolveRedistributionAllowlist({ REDISTRIBUTION_LIVE_TENANT_ALLOWLIST: `${TENANT_A},${TENANT_B}` });
  svc = new RedistributionProposalsService(env.app as unknown as Pool, memberships, { liveAndNamedStores }, allowlist);
  transfers = new ShipmentTransfersService(env.app as unknown as Pool, memberships, transferErpAdapter);
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (!env) return;
  svc.clock = () => Date.now();
  await admin.query(`DELETE FROM redistribution_proposal_lines`);
  await admin.query(`DELETE FROM redistribution_proposals`);
  for (const t of ['shipment_transfer_lines', 'inventory_reservations', 'shipment_transfers']) await admin.query(`DELETE FROM ${t}`);
  await admin.query(`DELETE FROM stock_movements WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`DELETE FROM product_stock_levels WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`DELETE FROM device_health WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`DELETE FROM devices WHERE tenant_id = $1`, [TENANT_A]);
  await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = true`);
});

describe('compute', () => {
  it('stores a proposal with its lines, read times and objective (201), 24 hours to expiry', async () => {
    if (skipped()) return;
    const p = await twoLineScenario();
    const proposal = await proposed();
    expect(proposal.state).toBe('open');
    expect(proposal.acceptEnabled).toBe(true);
    expect(proposal.lines.map((l) => [l.productId, l.sourceStoreId, l.destinationStoreId, l.quantity])).toEqual(
      expect.arrayContaining([
        [p, STORE_A_X, STORE_A_Y, '8.0000'],
        [p, STORE_A_X, STORE_A_Z, '10.0000'],
      ]),
    );
    const body = proposal as unknown as { createdAt: string; expiresAt: string };
    expect(Date.parse(body.expiresAt) - Date.parse(body.createdAt)).toBe(24 * HOUR);
    expect(proposal.stores.every((s) => s.exclusion === null && !Number.isNaN(Date.parse(s.readAt)))).toBe(true);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'inventory.redistribution_proposal.create' AND target_id = $1`, [proposal.id])).toBe(1);
  });

  it('answers nothing_to_move (200) and stores nothing when no store is below its level', async () => {
    if (skipped()) return;
    const p = await product();
    await stock(STORE_A_X, p, '50');
    await stock(STORE_A_Y, p, '50');
    await stock(STORE_A_Z, p, '50');
    const r = await compute();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: 'nothing_to_move', supersededProposalId: null });
    expect(await count(`SELECT count(*) AS n FROM redistribution_proposals`)).toBe(0);
  });

  it('refuses a store scope naming a store of another tenant (400), without saying it exists', async () => {
    if (skipped()) return;
    expect(await codeOf(svc.compute(ownerA(), [STORE_A_X, STORE_B_X]))).toBe('validation_error');
  });
});

describe('the freshness gate (4)', () => {
  it.each([
    ['an active till with no stored beat', null, 'pos_queue_unknown'],
    ['dead-letter sales', { lastSeenMinutesAgo: 1, deadLetter: 1 }, 'pos_queue_dead_letter_or_held'],
    ['held sales', { lastSeenMinutesAgo: 1, held: 2 }, 'pos_queue_dead_letter_or_held'],
    ['a heartbeat older than 15 minutes', { lastSeenMinutesAgo: 20 }, 'device_heartbeat_stale'],
  ] as const)('excludes the source store with %s, and proposes nothing from it', async (_label, health, exclusion) => {
    if (skipped()) return;
    await twoLineScenario();
    await till(STORE_A_X, health);
    const r = await compute();
    expect(r.status).toBe(200);
    const stores = (r.body as unknown as Proposal).stores;
    expect(stores.find((s) => s.storeId === STORE_A_X)).toMatchObject({ eligibleAsSource: false, exclusion });
    expect(stores.find((s) => s.storeId === STORE_A_Y)).toMatchObject({ eligibleAsSource: true, exclusion: null });
    expect((r.body as { warnings: { code: string; storeId?: string }[] }).warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'store_excluded_as_source', storeId: STORE_A_X })]),
    );
  });

  it('keeps a store with a fresh till eligible and ignores a revoked till with no beat', async () => {
    if (skipped()) return;
    await twoLineScenario();
    await till(STORE_A_X, { lastSeenMinutesAgo: 1 });
    await till(STORE_A_X, null, true);
    const proposal = await proposed();
    expect(proposal.stores.find((s) => s.storeId === STORE_A_X)).toMatchObject({ eligibleAsSource: true, exclusion: null });
  });

  it('an excluded store still receives: it stays a destination', async () => {
    if (skipped()) return;
    await twoLineScenario();
    await till(STORE_A_Y, null);
    const proposal = await proposed();
    expect(lineTo(proposal, STORE_A_Y).quantity).toBe('8.0000');
  });
});

describe('supersede and expiry (5)', () => {
  it('a newer compute supersedes the live proposal and names it', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const first = await proposed();
    const second = await proposed();
    const old = await get(first.id);
    expect([old.state, old.supersededBy, old.decidedAt !== null]).toEqual(['superseded', second.id, true]);
    expect(await codeOf(svc.reject(ownerA(), first.id, 'late'))).toBe('proposal_superseded');
    expect(await audits('supersede', first.id)).toEqual([{ supersededBy: second.id }]);
    expect(await audits('create', second.id)).toHaveLength(1);
  });

  it('a compute supersedes a partially_accepted proposal too', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const first = await proposed();
    const partial = (await svc.accept(ownerA(), first.id, [lineTo(first, STORE_A_Y).id])) as { proposal: Proposal };
    expect(partial.proposal.state).toBe('partially_accepted');
    const second = await proposed();
    expect(second.lines.map((l) => l.destinationStoreId)).toEqual([STORE_A_Z]);
    const old = await get(first.id);
    expect([old.state, old.supersededBy]).toEqual(['superseded', second.id]);
    // The accepted line keeps its outcome and its draft Transfer.
    expect(lineTo(old, STORE_A_Y).acceptOutcome).toMatchObject({ outcome: 'created' });
    expect(await count(`SELECT count(*) AS n FROM shipment_transfers`)).toBe(1);
  });

  it('a compute that finds nothing to move still supersedes the live proposal', async () => {
    if (skipped()) return;
    const p = await twoLineScenario();
    const first = await proposed();
    await stock(STORE_A_Y, p, '20');
    await stock(STORE_A_Z, p, '20');
    const r = await compute();
    expect(r).toMatchObject({ status: 200, body: { result: 'nothing_to_move', supersededProposalId: first.id } });
    const old = await get(first.id);
    expect([old.state, old.supersededBy]).toEqual(['superseded', null]);
    expect(await audits('supersede', first.id)).toEqual([{ supersededBy: null }]);
  });

  it('a proposal past its expiry is reported expired, refuses commands, and a later compute stores expired, not superseded', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const first = await proposed();
    const later = Date.now() + 25 * HOUR;
    svc.clock = () => later;
    expect((await get(first.id)).state).toBe('expired');
    expect(await codeOf(svc.review(ownerA(), first.id, [{ lineId: first.lines[0]!.id, decision: 'would_accept' }]))).toBe('proposal_expired');
    expect(await codeOf(svc.accept(ownerA(), first.id, [first.lines[0]!.id]))).toBe('proposal_expired');
    const listed = (await svc.list(ownerA(), { state: 'expired', cursor: null, limit: 20 })) as { items: { id: string }[] };
    expect(listed.items.map((i) => i.id)).toEqual([first.id]);
    await compute();
    const stored = await admin.query(`SELECT state, superseded_by, decided_at FROM redistribution_proposals WHERE id = $1`, [first.id]);
    expect(stored.rows[0]).toEqual({ state: 'expired', superseded_by: null, decided_at: null });
    expect(await audits('expire', first.id)).toHaveLength(1);
    expect(await audits('supersede', first.id)).toEqual([]);
  });
});

describe('cross-tenant isolation (1)', () => {
  it("answers another tenant's proposal with the non-disclosing 404 for every read and command", async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    const line = proposal.lines[0]!.id;
    expect(await codeOf(svc.get(ownerB(), proposal.id))).toBe('not_found');
    expect(await codeOf(svc.review(ownerB(), proposal.id, [{ lineId: line, decision: 'would_accept' }]))).toBe('not_found');
    expect(await codeOf(svc.accept(ownerB(), proposal.id, [line]))).toBe('not_found');
    expect(await codeOf(svc.reject(ownerB(), proposal.id, 'not mine'))).toBe('not_found');
    expect(await svc.list(ownerB(), { state: null, cursor: null, limit: 20 })).toEqual({ items: [], nextCursor: null });
    expect((await get(proposal.id)).state).toBe('open');
  });
});

describe('review and reject (shadow)', () => {
  it('records a decision per line, replaces it on a second review, and moves the proposal to reviewed', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    const [a, b] = proposal.lines;
    await svc.review(ownerA(), proposal.id, [{ lineId: a!.id, decision: 'would_accept' }, { lineId: b!.id, decision: 'would_reject', note: 'seasonal' }]);
    const reviewed = (await svc.review(ownerA(), proposal.id, [{ lineId: a!.id, decision: 'would_reject' }])) as unknown as Proposal;
    expect(reviewed.state).toBe('reviewed');
    expect(reviewed.lines.map((l) => l.reviewDecision?.decision)).toEqual(['would_reject', 'would_reject']);
    expect(await count(`SELECT count(*) AS n FROM shipment_transfers`)).toBe(0);
    expect(await codeOf(svc.review(ownerA(), proposal.id, [{ lineId: hex(0xdead), decision: 'would_accept' }]))).toBe('validation_error');
  });

  it('rejects with a reason; a second command is 409 proposal_state_conflict', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    const rejected = (await svc.reject(ownerA(), proposal.id, 'Seasonal stock is on order.')) as unknown as Proposal & { rejectReason: string };
    expect([rejected.state, rejected.rejectReason, rejected.decidedAt !== null]).toEqual(['rejected', 'Seasonal stock is on order.', true]);
    expect(await codeOf(svc.reject(ownerA(), proposal.id, 'again'))).toBe('proposal_state_conflict');
    expect(await codeOf(svc.accept(ownerA(), proposal.id, [proposal.lines[0]!.id]))).toBe('proposal_state_conflict');
  });
});

describe('accept (live)', () => {
  it('creates W3 drafts only: no approval, no reservation, the proposal reason (10)', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    const result = (await svc.accept(ownerA(), proposal.id, proposal.lines.map((l) => l.id))) as {
      lines: { lineId: string; outcome: { outcome: string; transferId: string } }[];
      transferIds: string[];
      proposal: Proposal;
    };
    expect(result.lines.map((l) => l.outcome.outcome)).toEqual(['created', 'created']);
    expect(result.transferIds).toHaveLength(2);
    expect(result.proposal.state).toBe('accepted');
    expect(result.proposal.decidedAt).not.toBeNull();
    const rows = await admin.query(`SELECT state, reason, approved_at FROM shipment_transfers ORDER BY destination_store_id`);
    expect(rows.rows).toEqual([
      { state: 'draft', reason: `Redistribution proposal ${proposal.id}`, approved_at: null },
      { state: 'draft', reason: `Redistribution proposal ${proposal.id}`, approved_at: null },
    ]);
    expect(await count(`SELECT count(*) AS n FROM inventory_reservations`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'inventory.redistribution_proposal.accept' AND target_id = $1`, [proposal.id])).toBe(1);
  });

  it('accepts line by line: partially_accepted, then accepted; a decided line is 409 proposal_line_already_decided', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    const [a, b] = proposal.lines;
    const first = (await svc.accept(ownerA(), proposal.id, [a!.id])) as { proposal: Proposal };
    expect(first.proposal.state).toBe('partially_accepted');
    expect(first.proposal.decidedAt).toBeNull();
    expect(await codeOf(svc.accept(ownerA(), proposal.id, [a!.id]))).toBe('proposal_line_already_decided');
    expect(await codeOf(svc.review(ownerA(), proposal.id, [{ lineId: a!.id, decision: 'would_reject' }]))).toBe('proposal_line_already_decided');
    const second = (await svc.accept(ownerA(), proposal.id, [b!.id])) as { proposal: Proposal };
    expect(second.proposal.state).toBe('accepted');
  });

  it('drops and reduces lines against current state, recording both quantities and the reason (8)', async () => {
    if (skipped()) return;
    const p = await twoLineScenario();
    const proposal = await proposed();
    // A draft X -> Y of 32 since the compute: X can give only 39 - 32 = 7 more, and Y's gap is closed by the inbound.
    await transfers.create(ownerA(), {
      sourceStoreId: STORE_A_X,
      destinationStoreId: STORE_A_Y,
      reason: null,
      lines: [{ tenantProductRef: p, quantity: '32', stockingUnit: 'piece', trackingIdentityId: null }],
    });
    const result = (await svc.accept(ownerA(), proposal.id, proposal.lines.map((l) => l.id))) as { proposal: Proposal; transferIds: string[] };
    const toY = lineTo(result.proposal, STORE_A_Y).acceptOutcome;
    const toZ = lineTo(result.proposal, STORE_A_Z).acceptOutcome;
    expect(toY).toMatchObject({ outcome: 'dropped', proposedQuantity: '8.0000', createdQuantity: null, transferId: null, reason: 'destination_gap_closed' });
    expect(toZ).toMatchObject({ outcome: 'reduced', proposedQuantity: '10.0000', createdQuantity: '7.0000', reason: 'source_available_insufficient' });
    expect(result.transferIds).toEqual([toZ!.transferId]);
    const created = await admin.query(`SELECT quantity::text AS q FROM shipment_transfer_lines WHERE transfer_id = $1`, [toZ!.transferId]);
    expect(created.rows).toEqual([{ q: '7.0000' }]);
  });

  it('drops every line of a source that is no longer fresh (here all of them: 409 proposal_stale)', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    await till(STORE_A_X, null);
    expect(await codeOf(svc.accept(ownerA(), proposal.id, proposal.lines.map((l) => l.id)))).toBe('proposal_stale');
  });

  it('answers 409 proposal_stale and writes nothing when every listed line would be dropped', async () => {
    if (skipped()) return;
    const p = await twoLineScenario();
    const proposal = await proposed();
    await stock(STORE_A_Y, p, '20');
    await stock(STORE_A_Z, p, '20');
    expect(await codeOf(svc.accept(ownerA(), proposal.id, proposal.lines.map((l) => l.id)))).toBe('proposal_stale');
    expect(await count(`SELECT count(*) AS n FROM shipment_transfers`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM redistribution_proposal_lines WHERE accept_outcome IS NOT NULL`)).toBe(0);
    expect((await get(proposal.id)).state).toBe('open');
  });

  it('is atomic: a failure on the second draft leaves no Transfer, no outcome, no state change and no audit (6)', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    await admin.query(`CREATE OR REPLACE FUNCTION rt1600_fail_draft() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'rt1600 injected failure'; END $$`);
    await admin.query(
      `CREATE TRIGGER rt1600_fail_draft BEFORE INSERT ON shipment_transfers FOR EACH ROW
         WHEN (NEW.destination_store_id = '${STORE_A_Z}'::uuid) EXECUTE FUNCTION rt1600_fail_draft()`,
    );
    try {
      await expect(svc.accept(ownerA(), proposal.id, proposal.lines.map((l) => l.id))).rejects.toThrow(/rt1600 injected failure/);
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS rt1600_fail_draft ON shipment_transfers`);
      await admin.query(`DROP FUNCTION IF EXISTS rt1600_fail_draft()`);
    }
    expect(await count(`SELECT count(*) AS n FROM shipment_transfers`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM shipment_transfer_lines`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM redistribution_proposal_lines WHERE accept_outcome IS NOT NULL`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'inventory.redistribution_proposal.accept' AND target_id = $1`, [proposal.id])).toBe(0);
    expect((await get(proposal.id)).state).toBe('open');
    // The same accept then succeeds: the failure was the injected one only.
    const retried = (await svc.accept(ownerA(), proposal.id, proposal.lines.map((l) => l.id))) as { transferIds: string[] };
    expect(retried.transferIds).toHaveLength(2);
  });

  it('makes one draft per store pair with at most 100 lines each (9)', async () => {
    if (skipped()) return;
    // 101 products, X 20 each (surplus 9), Y and Z empty: the engine fills the X -> Y pair to its 100-line limit and
    // sends the 101st product to Z, so the accept makes one Transfer of 100 lines and one of 1.
    for (let i = 0; i < 101; i += 1) {
      const p = await product();
      await stock(STORE_A_X, p, '20');
    }
    const proposal = await proposed();
    expect(proposal.lines).toHaveLength(101);
    const result = (await svc.accept(ownerA(), proposal.id, proposal.lines.map((l) => l.id))) as { transferIds: string[] };
    expect(result.transferIds).toHaveLength(2);
    const sizes = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM shipment_transfer_lines GROUP BY transfer_id ORDER BY count(*)`,
    );
    expect(sizes.rows.map((r) => r.n)).toEqual([1, 100]);
  }, 120_000);

  it('answers the non-disclosing 404 while W3 shipment transfers are off for the tenant', async () => {
    if (skipped()) return;
    await twoLineScenario();
    const proposal = await proposed();
    await admin.query(`UPDATE tenant_inventory_settings SET shipment_transfers_enabled = false WHERE tenant_id = $1`, [TENANT_A]);
    expect(await codeOf(svc.accept(ownerA(), proposal.id, [proposal.lines[0]!.id]))).toBe('not_found');
    expect((await get(proposal.id)).acceptEnabled).toBe(false);
  });
});
