/**
 * RT-906 (RT-905 decision, comment 14049) — a sale held because its cashier-
 * path discount has no `approver_role` is released once its approver's PIN
 * record has a role, written by `refreshRole` at that manager's online sign-in.
 *
 * On the full migration stack (sql.js), with the real PIN store, the real
 * role-refresh listener, the real audit emitter and the real drain engine:
 *   AC1 — released only after the approver's online manager / admin sign-in on
 *         the same terminal, captured with that role, `cashier_approval` kept;
 *   AC2 — once resolved, a later promotion, demotion or revocation does not
 *         change the body: a retry under the same key is byte-identical;
 *   AC3 — a revoked, disabled or role-less record, a cashier-only sign-in, a
 *         sign-in on another terminal, or any mismatch along the chain stays
 *         held: never sent, never dead-lettered, nothing resolved;
 *   AC4 — the RT-887 counters follow the release (the predicate / SQL
 *         agreement is pinned in `sale-sync-discount-hold.test.ts`).
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { aeadSafeStorage } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { AuditEmitter } from '../../audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../audit/audit-events-store.js';
import type { DatabaseHandle } from '../../db/client.js';
import { createManagerPinStore, type ManagerPinStore } from '../../operator/manager-pin-store.js';
import { createManagerRoleRefresh } from '../../operator/manager-pin-enrollment.js';
import { SessionManager } from '../../operator/session-manager.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createFakeSaleSyncClient, type SaleSyncResult } from '../sale-sync-client-types.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createSaleSyncStatusReader } from '../sale-sync-status-reader.js';
import { createDiscountRoleResolver } from '../discount-role-resolver.js';
import type { SaleDiscountRoles } from '../discount-role-resolutions.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };
const MANAGER_USER = '0190f5a2-3b4c-7d8e-9f01-00000000000a';
const OTHER_USER = '0190f5a2-3b4c-7d8e-9f01-00000000000b';
const APPROVAL_ID = '0190f5a2-3b4c-7d8e-9f01-000000000001';
const PIN = '246810';
const T = '2026-10-27T10:00:00.000Z';
const HELD_ID = 'pos-pulse:handoff-sale-held';
const PLAIN_ID = 'pos-pulse:handoff-sale-plain';

/** A line frozen with a cashier-approval discount and no `approver_role` (RT-858 hold). */
function rolelessLines(over: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      line_id: 'l-1',
      item_ref: 'p-1',
      display_name: 'Panadol',
      quantity: 2,
      unit_price_minor: 4500,
      line_subtotal_minor: 9000,
      note: null,
      discount: {
        kind: 'percent',
        value: 10,
        amount_minor: 900,
        placeholder_id: 'dp-1',
        reason_code: 'promotion',
        authority_source: 'cashier_approval',
        approver_operator_id: MANAGER_USER,
        ...over,
      },
    },
  ]);
}

interface World {
  raw: SqlJsDatabase;
  db: DatabaseHandle;
  store: ManagerPinStore;
  audit: AuditEmitter;
  stateRepo: ReturnType<typeof createSaleSyncStateRepo>;
  roles: SaleDiscountRoles;
}

let w: World;

beforeEach(() => {
  const raw = freshSalesSyncDb();
  const db = handleFor(raw);
  const audit = new AuditEmitter(bindAuditEventsStoreDb(db));
  let seq = 0;
  w = {
    raw,
    db,
    store: createManagerPinStore({ db, safeStorage: aeadSafeStorage() }),
    audit,
    stateRepo: createSaleSyncStateRepo(db),
    roles: createDiscountRoleResolver({
      db,
      emit: (event) => {
        audit.emit(event);
      },
      now: () => T,
      newEventId: () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`,
    }),
  };
});

afterEach(() => {
  w.raw.close();
});

async function enrol(
  terminalId = SCOPE.terminalId,
  role?: 'manager' | 'admin',
  userId = MANAGER_USER,
): Promise<void> {
  await w.store.enrol({
    scope: { ...SCOPE, terminalId },
    userId,
    displayName: 'Mona Manager',
    sealed: await w.store.seal(PIN),
    now: T,
    onlineAt: T,
    ...(role === undefined ? {} : { role }),
    guard: () => undefined,
  });
}

/** The approval the cashier's discount consumed (0048), granted by `approver`. */
function seedApproval(
  o: { approver?: string; terminalId?: string; consumed?: boolean } = {},
): void {
  w.raw.run(
    `INSERT INTO manager_approvals
       (approval_id, tenant_id, branch_id, terminal_id, action_kind, subject_ref, subject_version,
        amount_minor, reason_code, requester_operator_id, approver_user_id, policy_version,
        issued_at, expires_at, consumed_at)
     VALUES (?, 'tenant-1', 'branch-1', ?, 'cart.discount.manual', 'cart-1:l-1', 'v1', 900,
             'promotion', 'op-1', ?, 'p1', ?, ?, ?)`,
    [
      APPROVAL_ID,
      o.terminalId ?? SCOPE.terminalId,
      o.approver ?? MANAGER_USER,
      T,
      T,
      o.consumed === false ? null : T,
    ],
  );
}

/** The discount's `cart.discount.manager_authorized` row, as the cart bridge emits it. */
function seedAuthorized(o: { supervisor?: string; approvalId?: string | null } = {}): void {
  const approvalId = o.approvalId === undefined ? APPROVAL_ID : o.approvalId;
  w.audit.emit({
    event_id: '00000000-0000-4000-8000-0000000000aa',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    originating_terminal_id: SCOPE.terminalId,
    acting_operator_id: 'op-1',
    session_id: 'sess-1',
    shift_id: null,
    action_category: 'cart.discount.manager_authorized',
    created_at: T,
    approving_supervisor_id: o.supervisor ?? MANAGER_USER,
    payload: {
      cart_id: 'cart-1',
      cart_line_id: 'l-1',
      placeholder_id: 'dp-1',
      ...(approvalId === null ? {} : { approval_id: approvalId }),
      reason_code: 'promotion',
      kind: 'percent',
      value: 10,
      amount_minor: 900,
    },
  });
}

function seedHeldSale(lines = rolelessLines(), terminalId = SCOPE.terminalId): void {
  seedSale(w.raw, {
    sale_id: 'sale-held',
    subtotal_minor: 8100,
    lines_json: lines,
    terminal_id: terminalId,
  });
  seedOutbox(w.raw, {
    sale_id: 'sale-held',
    terminal_id: terminalId,
    enqueued_at: '2026-10-27T09:00:00.000Z',
  });
  seedSale(w.raw, { sale_id: 'sale-plain' });
  seedOutbox(w.raw, { sale_id: 'sale-plain', enqueued_at: '2026-10-27T09:01:00.000Z' });
}

/** The whole chain the RT-858 hold leaves behind: sale, audit row, approval, role-less record. */
async function heldWorld(): Promise<void> {
  seedHeldSale();
  seedAuthorized();
  seedApproval();
  await enrol();
}

function signIn(role: 'cashier' | 'manager' | 'admin', terminalId = SCOPE.terminalId): void {
  const record = new SessionManager().create({
    operator_id: 'clerk-mgr',
    display_name: 'Mona',
    role,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    backend_session_id: 'backend-1',
    manager_user_id: MANAGER_USER,
  });
  createManagerRoleRefresh({ store: w.store, currentTerminalId: () => terminalId })(record);
}

function engineDeps(results: SaleSyncResult[], over: Partial<SaleSyncEngineDeps> = {}) {
  const client = createFakeSaleSyncClient(results);
  const deadLetters: string[] = [];
  const deps: SaleSyncEngineDeps = {
    client,
    stateRepo: w.stateRepo,
    salesRepo: bindSalesRepository(w.db),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    getOperatorToken: () => 'tok-1',
    now: () => T,
    backoff: { baseMs: 1000, maxMs: 300_000 },
    onDeadLetter: (saleId) => deadLetters.push(saleId),
    discountCaptureSupported: true,
    discountRoles: w.roles,
    ...over,
  };
  return { deps, client, deadLetters };
}

async function tick(deps: SaleSyncEngineDeps, now = T): Promise<void> {
  const admission = createSaleSyncEngine({ ...deps, now: () => now }).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

const OK: SaleSyncResult = { kind: 'ok', saleRef: null };

function sentOf(client: ReturnType<typeof createFakeSaleSyncClient>, externalId = HELD_ID) {
  return client.calls.filter((call) => call.externalId === externalId);
}

function resolutions(): unknown[][] {
  return w.raw.exec('SELECT * FROM sale_discount_role_resolutions')[0]?.values ?? [];
}

function resolvedEvents(): Record<string, unknown>[] {
  const rows =
    w.raw.exec(
      `SELECT acting_operator_id, approving_supervisor_id, originating_terminal_id, payload
       FROM audit_events WHERE action_category = 'sale.discount.approver_role_resolved'`,
    )[0]?.values ?? [];
  return rows.map(([actor, supervisor, terminal, payload]) => ({
    actor,
    supervisor,
    terminal,
    payload: JSON.parse(String(payload)) as unknown,
  }));
}

async function heldCount(): Promise<number> {
  const status = await createSaleSyncStatusReader({
    stateRepo: w.stateRepo,
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    pausedReason: () => null,
    discountCaptureSupported: true,
  })();
  return status.held?.count ?? 0;
}

describe('RT-906 AC1 — released only after the approver’s online sign-in', () => {
  it('stays held while the record has no role; a cashier sign-in changes nothing', async () => {
    await heldWorld();
    const h = engineDeps([OK, OK]);
    await tick(h.deps);
    signIn('cashier');
    await tick(h.deps, '2026-10-27T11:00:00.000Z');
    expect(sentOf(h.client)).toEqual([]);
    expect(sentOf(h.client, PLAIN_ID)).toHaveLength(1);
    expect(w.stateRepo.read('sale-held')).toBeNull();
    expect(resolutions()).toEqual([]);
    expect(await heldCount()).toBe(1);
    expect(h.deadLetters).toEqual([]);
  });

  it.each(['manager', 'admin'] as const)(
    'a %s sign-in on this terminal releases it: captured once with that role',
    async (role) => {
      await heldWorld();
      const h = engineDeps([OK, OK]);
      await tick(h.deps);
      expect(await heldCount()).toBe(1);
      expect(w.stateRepo.readOldestUnheldPendingAt(SCOPE, true)).toBeNull();

      signIn(role);
      await tick(h.deps, '2026-10-27T11:00:00.000Z');
      await tick(h.deps, '2027-01-01T00:00:00.000Z');

      const sent = sentOf(h.client);
      expect(sent).toHaveLength(1);
      expect(nn(sent[0]).lines).toEqual([
        expect.objectContaining({
          lineAmountMinor: 8100,
          discount: {
            kind: 'percent',
            value: 10,
            amountMinor: 900,
            reasonCode: 'promotion',
            authoritySource: 'cashier_approval',
            approverRole: role,
          },
        }),
      ]);
      expect(nn(w.stateRepo.read('sale-held')).sync_status).toBe('synced');
      expect(resolutions()).toEqual([
        ['sale-held', 'dp-1', APPROVAL_ID, role, 'pin_record_refresh', T],
      ]);
      expect(resolvedEvents()).toEqual([
        {
          actor: 'system:device',
          supervisor: MANAGER_USER,
          terminal: SCOPE.terminalId,
          payload: {
            sale_id: 'sale-held',
            placeholder_id: 'dp-1',
            approval_id: APPROVAL_ID,
            approver_role: role,
            source: 'pin_record_refresh',
            resolved_at: T,
          },
        },
      ]);
      expect(h.deadLetters).toEqual([]);
    },
  );

  it('AC4: the RT-887 counters follow the release before the POST', async () => {
    await heldWorld();
    signIn('manager');
    expect(await heldCount()).toBe(1);
    // Paused (no credential): the tick still freezes the role, so the counters move.
    const h = engineDeps([OK, OK], { getOperatorToken: () => null });
    await tick(h.deps);
    expect(h.client.calls).toEqual([]);
    expect(await heldCount()).toBe(0);
    expect(w.stateRepo.readOldestUnheldPendingAt(SCOPE, true)).toBe('2026-10-27T09:00:00.000Z');
  });

  it('resolves once: a repeat writes no row and no event', async () => {
    await heldWorld();
    signIn('manager');
    expect(w.roles.resolve(SCOPE)).toBe(1);
    expect(w.roles.resolve(SCOPE)).toBe(0);
    expect(resolutions()).toHaveLength(1);
    expect(resolvedEvents()).toHaveLength(1);
    expect(w.roles.rolesFor('sale-held')).toEqual(new Map([['dp-1', 'manager']]));
    expect(w.roles.rolesFor('sale-plain')).toEqual(new Map());
  });
});

describe('RT-906 AC2 — a later role change never changes the body', () => {
  it.each([
    [
      'a promotion',
      'manager',
      () => {
        signIn('admin');
      },
    ],
    [
      'a demotion',
      'admin',
      () => {
        signIn('manager');
      },
    ],
    [
      'a revocation',
      'manager',
      () => {
        w.raw.run(`UPDATE manager_pin_records SET revoked_at = ?, revoke_reason = 'self'`, [T]);
      },
    ],
  ] as const)('after %s, the retry is byte-identical', async (_name, first, change) => {
    await heldWorld();
    signIn(first);
    const h = engineDeps([{ kind: 'transient' }, OK, OK]);
    await tick(h.deps);
    change();
    await tick(h.deps, '2027-01-01T00:00:00.000Z');
    const sent = sentOf(h.client);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]));
    expect(nn(nn(sent[0]).lines[0]).discount?.approverRole).toBe(first);
    expect(resolutions()).toEqual([
      ['sale-held', 'dp-1', APPROVAL_ID, first, 'pin_record_refresh', T],
    ]);
    expect(nn(w.stateRepo.read('sale-held')).sync_status).toBe('synced');
  });
});

describe('RT-906 AC3 — anything short of the full chain stays held', () => {
  const cases: [string, () => Promise<void>][] = [
    [
      'a revoked record',
      async () => {
        await heldWorld();
        signIn('manager');
        w.raw.run(`UPDATE manager_pin_records SET revoked_at = ?, revoke_reason = 'self'`, [T]);
      },
    ],
    [
      'a disabled record',
      async () => {
        await heldWorld();
        signIn('manager');
        w.raw.run(`UPDATE manager_pin_records SET disabled_at = ?`, [T]);
      },
    ],
    ['a record with no role', heldWorld],
    [
      'a cashier-only sign-in',
      async () => {
        await heldWorld();
        signIn('cashier');
      },
    ],
    [
      'a sign-in only on another terminal',
      async () => {
        await heldWorld();
        await enrol('term-2', 'manager');
        signIn('admin', 'term-2');
      },
    ],
    [
      'no PIN record on the sale’s terminal',
      async () => {
        seedHeldSale();
        seedAuthorized();
        seedApproval();
        await enrol('term-2', 'manager');
      },
    ],
    [
      'an approval issued on another terminal',
      async () => {
        seedHeldSale();
        seedAuthorized();
        seedApproval({ terminalId: 'term-2' });
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
    [
      'an approval never consumed',
      async () => {
        seedHeldSale();
        seedAuthorized();
        seedApproval({ consumed: false });
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
    [
      'an approval granted by someone else',
      async () => {
        seedHeldSale();
        seedAuthorized();
        seedApproval({ approver: OTHER_USER });
        await enrol(SCOPE.terminalId, 'manager');
        await enrol(SCOPE.terminalId, 'manager', OTHER_USER);
      },
    ],
    [
      'an audit row naming another approver',
      async () => {
        seedHeldSale();
        seedAuthorized({ supervisor: OTHER_USER });
        seedApproval();
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
    [
      'an audit row with no approval',
      async () => {
        seedHeldSale();
        seedAuthorized({ approvalId: null });
        seedApproval();
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
    [
      'no audit row at all',
      async () => {
        seedHeldSale();
        seedApproval();
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
    [
      'a manager-session discount with no role',
      async () => {
        seedHeldSale(rolelessLines({ authority_source: 'manager_session' }));
        seedAuthorized();
        seedApproval();
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
    [
      'a frozen role the contract refuses',
      async () => {
        seedHeldSale(rolelessLines({ approver_role: 'cashier' }));
        seedAuthorized();
        seedApproval();
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
    [
      'an unreadable snapshot',
      async () => {
        seedHeldSale('not json');
        seedAuthorized();
        seedApproval();
        await enrol(SCOPE.terminalId, 'manager');
      },
    ],
  ];

  it.each(cases)(
    '%s: never sent, never dead-lettered, nothing resolved',
    async (_name, arrange) => {
      await arrange();
      const h = engineDeps([OK, OK]);
      await tick(h.deps);
      await tick(h.deps, '2027-01-01T00:00:00.000Z');
      expect(sentOf(h.client)).toEqual([]);
      expect(sentOf(h.client, PLAIN_ID)).toHaveLength(1);
      expect(w.stateRepo.read('sale-held')).toBeNull();
      expect(h.deadLetters).toEqual([]);
      expect(resolutions()).toEqual([]);
      expect(resolvedEvents()).toEqual([]);
      expect(await heldCount()).toBe(1);
    },
  );

  it('a sale of an earlier pairing is never resolved, even with a role on its terminal', async () => {
    seedHeldSale(rolelessLines(), 'term-old');
    seedAuthorized();
    seedApproval({ terminalId: 'term-old' });
    await enrol('term-old', 'manager');
    expect(w.roles.resolve(SCOPE)).toBe(0);
    expect(resolutions()).toEqual([]);
  });

  it('a resolver that throws holds the sale, never the tick: the plain sale still drains', async () => {
    await heldWorld();
    signIn('manager');
    const failures: number[] = [];
    const throwing: SaleDiscountRoles = {
      resolve: () => {
        throw new Error('disk I/O error');
      },
      rolesFor: (saleId) => w.roles.rolesFor(saleId),
    };
    const h = engineDeps([OK, OK], {
      discountRoles: throwing,
      onDependencyFailure: () => failures.push(1),
    });
    await tick(h.deps);
    expect(sentOf(h.client)).toEqual([]);
    expect(sentOf(h.client, PLAIN_ID)).toHaveLength(1);
    expect(failures).toEqual([1]);
    expect(h.deadLetters).toEqual([]);
  });

  it('a held sale whose lookup throws never keeps a later held sale from resolving', async () => {
    await heldWorld();
    signIn('manager');
    seedSale(w.raw, {
      sale_id: 'sale-old',
      subtotal_minor: 8100,
      lines_json: rolelessLines({ placeholder_id: 'dp-old' }),
    });
    seedOutbox(w.raw, { sale_id: 'sale-old', enqueued_at: '2026-10-27T08:00:00.000Z' });
    // The older sale's audit lookup fails (a store error); the newer one's does not.
    const failing: DatabaseHandle = {
      ...w.db,
      prepare: (sql: string) => {
        const stmt = w.db.prepare(sql) as { get: (...p: unknown[]) => unknown };
        if (!sql.includes('cart.discount.manager_authorized')) return stmt;
        return {
          get: (...params: unknown[]) => {
            if (params[2] === 'dp-old') throw new Error('disk I/O error');
            return stmt.get(...params);
          },
        };
      },
    };
    const roles = createDiscountRoleResolver({
      db: failing,
      emit: (event) => {
        w.audit.emit(event);
      },
      now: () => T,
      newEventId: () => '00000000-0000-4000-8000-0000000000bb',
    });
    expect(() => roles.resolve(SCOPE)).toThrow('disk I/O error');
    expect(resolutions()).toEqual([
      ['sale-held', 'dp-1', APPROVAL_ID, 'manager', 'pin_record_refresh', T],
    ]);
  });

  it('a resolution read that throws holds that sale only: the rest of the tick drains', async () => {
    await heldWorld();
    signIn('manager');
    w.roles.resolve(SCOPE);
    const failures: number[] = [];
    const unreadable: SaleDiscountRoles = {
      resolve: () => 0,
      rolesFor: () => {
        throw new Error('disk I/O error');
      },
    };
    const h = engineDeps([OK, OK], {
      discountRoles: unreadable,
      onDependencyFailure: () => failures.push(1),
    });
    await tick(h.deps);
    expect(sentOf(h.client)).toEqual([]);
    expect(sentOf(h.client, PLAIN_ID)).toHaveLength(1);
    expect(w.stateRepo.read('sale-held')).toBeNull();
    expect(failures).toEqual([1]);
    expect(h.deadLetters).toEqual([]);
  });
});
