/**
 * RT-1322 (RT-249 N-S2, doc 20 §5.1, §9) — `sales.readForHandoff`: Completion
 * reads ITS OWN sale by the exact UNIQUE handoff key plus the payment attempt.
 *
 *   • Gate order: forbidden-key scan → `admitSession` → request check → read.
 *   • No row → `pending`. A row of another scope, or of the same handoff under a
 *     different `payment_attempt_id`, → `sale_not_found` (never `tenant_isolation`,
 *     so existence does not leak, §A4 #6).
 *   • Otherwise the `SaleSummary` plus `short_number`; neither id is echoed (§P15).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createSalesBridge,
  type OperatorSessionForSales,
} from '../../../../src/main/sales/sales-bridge.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from '../../../../src/main/sales/repositories/drawer-events.repository.js';
import type { SaleRawAuditEvent } from '../../../../src/main/sales/audit-emitter.js';
import type { SalesReadForHandoffResponse } from '../../../../src/shared/bridge-api.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b))
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

const session = (
  role: OperatorSessionForSales['role'],
  operator_id: string,
): OperatorSessionForSales => ({
  ...SCOPE,
  role,
  operator_id,
  operator_session_id: `sess-${operator_id}`,
});
const CASHIER_A = session('cashier', 'op-cashier-a');
const CASHIER_B = session('cashier', 'op-cashier-b');
const MANAGER = session('manager', 'op-manager');
const UNKNOWN_ROLE = session('auditor' as OperatorSessionForSales['role'], 'op-auditor');

const HANDOFF = 'handoff-0001';
const ATTEMPT = 'attempt-0001';
const DAY = '2026-10-16';

let db: SqlJsDatabase;

interface Seed {
  id?: string;
  handoff?: string;
  attempt?: string;
  seller?: string;
  tenant?: string;
  branch?: string;
  terminal?: string;
  number?: string;
}

function seed(s: Seed = {}): void {
  const id = s.id ?? 'sale-1';
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (?, ?, ?, ?, ?, 'cart-secret', ?, ?, ?, 'TERM-01',
       ?, 'Cashier Name', 'sess', 2500, 0, 0,
       '[{"tender_type":"cash","amount_applied_minor":2500}]',
       '2026-10-16T08:00:00.000Z', '2026-10-16T08:00:00.400Z', 'TRN-secret', 'Branch', 'Address',
       ?, '[]')`,
    [
      id,
      s.number ?? `TERM-01-${DAY}-000047`,
      `R-${id}`,
      s.handoff ?? HANDOFF,
      s.attempt ?? ATTEMPT,
      s.tenant ?? SCOPE.tenant_id,
      s.branch ?? SCOPE.branch_id,
      s.terminal ?? SCOPE.terminal_id,
      s.seller ?? CASHIER_A.operator_id,
      DAY,
    ],
  );
}

interface Harness {
  locked: boolean;
  audits: SaleRawAuditEvent[];
}
const harness = (): Harness => ({ locked: false, audits: [] });

function bridge(current: OperatorSessionForSales | null, h: Harness = harness()) {
  const handle = makeSqlJsHandle(db);
  return createSalesBridge({
    getCurrentSession: () => current,
    isSessionLocked: () => h.locked,
    auditEmitter: { emitRaw: (e: SaleRawAuditEvent) => void h.audits.push(e) },
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    drawerEventsRepo: bindDrawerEventsRepository(handle),
  });
}

const KEY = { handoff_action_id: HANDOFF, payment_attempt_id: ATTEMPT };

function read(
  who: OperatorSessionForSales | null,
  req: Record<string, unknown> = KEY,
  h: Harness = harness(),
): Promise<SalesReadForHandoffResponse> {
  return bridge(who, h).readForHandoff(req as never);
}

beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
});

describe('RT-1322 — pending, ok and the exact key', () => {
  it('answers pending when no sale has finalized for this handoff', async () => {
    expect(await read(CASHIER_A)).toEqual({ kind: 'pending' });
  });

  it('answers pending, not another sale, while only a different handoff has finalized', async () => {
    seed({ id: 'earlier', handoff: 'handoff-earlier', attempt: 'attempt-earlier' });
    expect(await read(CASHIER_A)).toEqual({ kind: 'pending' });
  });

  it('answers ok with the sale and its short form for the matching row', async () => {
    seed();
    const res = await read(CASHIER_A);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.sale.sale_id).toBe('sale-1');
    expect(res.sale.sale_number).toBe(`TERM-01-${DAY}-000047`);
    expect(res.short_number).toBe('47');
  });

  it('gives short_number null, never an invented one, when the number does not parse', async () => {
    seed({ number: 'FREE-TEXT-NUMBER' });
    const res = await read(CASHIER_A);
    expect(res).toMatchObject({ kind: 'ok', short_number: null });
  });

  it('picks its own sale among others by the exact key', async () => {
    seed({
      id: 'other',
      handoff: 'handoff-other',
      attempt: 'attempt-other',
      number: `TERM-01-${DAY}-000046`,
    });
    seed({ id: 'mine' });
    const res = await read(CASHIER_A);
    expect(res).toMatchObject({ kind: 'ok', short_number: '47' });
    if (res.kind === 'ok') expect(res.sale.sale_id).toBe('mine');
  });

  it('carries neither the handoff nor the attempt id, nor any main-only field (§P15)', async () => {
    seed();
    const wire = JSON.stringify(await read(CASHIER_A));
    for (const secret of [
      HANDOFF,
      ATTEMPT,
      'cart-secret',
      'TRN-secret',
      'envelope_handoff_action_id',
      'payment_attempt_id',
      'envelope_cart_id',
      'tenant_tax_registration_id',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });
});

describe('RT-1322 — scope and attempt confirmation (no existence leak, §A4 #6)', () => {
  it.each([
    ['another terminal', { terminal: 'terminal-2' }],
    ['another branch', { branch: 'branch-2' }],
    ['another tenant', { tenant: 'tenant-2' }],
  ])('answers sale_not_found for the same handoff on %s', async (_n, other) => {
    seed(other);
    expect(await read(CASHIER_A)).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });

  it('answers sale_not_found for the same handoff with a different payment_attempt_id', async () => {
    seed();
    const res = await read(CASHIER_A, { ...KEY, payment_attempt_id: 'attempt-other' });
    expect(res).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });

  it('answers the same for a wrong scope and a wrong attempt, and never tenant_isolation', async () => {
    seed({ terminal: 'terminal-2' });
    const wrongScope = await read(CASHIER_A);
    // `sales` is append-only (migration 0021): a second scenario needs a fresh db.
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of ALL_MIGRATIONS) db.exec(sql);
    seed();
    const wrongAttempt = await read(CASHIER_A, { ...KEY, payment_attempt_id: 'x' });
    expect(wrongScope).toEqual(wrongAttempt);
    expect(JSON.stringify([wrongScope, wrongAttempt])).not.toContain('tenant_isolation');
  });
});

describe('RT-1322 — session, role and request gates', () => {
  it('refuses no session, and a locked session, as no_session', async () => {
    seed();
    expect(await read(null)).toEqual({ kind: 'refused', reason: 'no_session' });
    const h = harness();
    h.locked = true;
    expect(await read(MANAGER, KEY, h)).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('answers no_session before any repository read', async () => {
    const handle = makeSqlJsHandle(db);
    const salesRepo = bindSalesRepository(handle);
    const spy = vi.spyOn(salesRepo, 'findByHandoffActionId');
    const b = createSalesBridge({
      getCurrentSession: () => null,
      salesRepo,
      printEventsRepo: bindPrintEventsRepository(handle),
      drawerEventsRepo: bindDrawerEventsRepository(handle),
    });
    expect(await b.readForHandoff(KEY)).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a role outside the allowlist as role_denied and audits it', async () => {
    seed();
    const h = harness();
    expect(await read(UNKNOWN_ROLE, KEY, h)).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(h.audits[0]).toMatchObject({
      action_category: 'sale.access.refused',
      payload: { action: 'sales.readForHandoff', reason: 'role_denied' },
    });
  });

  it("refuses a cashier another operator's sale as role_denied (RT-741) and audits not_owner", async () => {
    seed({ seller: CASHIER_A.operator_id });
    const h = harness();
    const res = await read(CASHIER_B, KEY, h);
    expect(res).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(h.audits[0]).toMatchObject({
      payload: { action: 'sales.readForHandoff', reason: 'not_owner' },
    });
  });

  it("lets a manager read a cashier's sale by the exact key", async () => {
    seed({ seller: CASHIER_A.operator_id });
    expect(await read(MANAGER)).toMatchObject({ kind: 'ok' });
  });

  it.each(['pan', 'cvv', 'voucher_code', 'envelope_payload', 'auth_payload'])(
    'refuses a request carrying %s as forbidden_field_in_request, before the session',
    async (key) => {
      seed();
      const res = await read(null, { ...KEY, [key]: 'x' });
      expect(res).toEqual({ kind: 'refused', reason: 'forbidden_field_in_request' });
      expect(await read(CASHIER_A, { ...KEY, nested: { [key]: 'x' } })).toEqual({
        kind: 'refused',
        reason: 'forbidden_field_in_request',
      });
    },
  );

  it.each([
    ['a missing handoff id', { payment_attempt_id: ATTEMPT }],
    ['a missing attempt id', { handoff_action_id: HANDOFF }],
    ['an empty handoff id', { ...KEY, handoff_action_id: '' }],
    ['a non-string attempt id', { ...KEY, payment_attempt_id: 7 }],
    ['a non-string handoff id', { ...KEY, handoff_action_id: 7 }],
    ['a null handoff id', { ...KEY, handoff_action_id: null }],
    [
      'an own __proto__ key',
      JSON.parse(
        `{"handoff_action_id":"${HANDOFF}","payment_attempt_id":"${ATTEMPT}","__proto__":{}}`,
      ),
    ],
    ['an empty object', {}],
    ['an unknown key', { ...KEY, terminal_id: 'terminal-2' }],
    ['a role key', { ...KEY, role: 'manager' }],
  ])('refuses %s as invalid_input and reads nothing', async (_n, req) => {
    seed();
    expect(await read(CASHIER_A, req)).toEqual({ kind: 'refused', reason: 'invalid_input' });
  });

  it('is read-only: a successful read adds no audit row', async () => {
    seed();
    const h = harness();
    await read(CASHIER_A, KEY, h);
    expect(h.audits).toEqual([]);
  });
});

describe('RT-1322 — request shapes and a refused cashier carry no sale field', () => {
  it.each([null, undefined, 42, 'x', [HANDOFF, ATTEMPT]])(
    'refuses a non-object request (%j) as invalid_input',
    async (req) => {
      seed();
      const res = await bridge(CASHIER_A).readForHandoff(req as never);
      expect(res).toEqual({ kind: 'refused', reason: 'invalid_input' });
    },
  );

  it("gives a cashier another cashier's sale as a bare refusal with no sale data", async () => {
    seed({ seller: CASHIER_A.operator_id });
    const res = await read(CASHIER_B);
    expect(res).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(JSON.stringify(res)).not.toMatch(/sale_id|sale_number|total|Cashier Name/u);
  });
});
