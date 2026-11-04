/**
 * RT-1189 (RT-249 N-S1, doc 20 §3, §4, §9) — `sales.listRecent`: this
 * terminal's sales on the current Africa/Cairo business day, local only, capped
 * at 300, with the short-form filter applied before the cap.
 *
 *   • Scope and role come from the session: a cashier sees only their own
 *     sales (OD-534-1), a manager or admin every sale on the terminal.
 *   • The window is the Cairo business day of main's injected clock, read from
 *     `finalized_at`; the stored `local_calendar_day` is never used for it.
 *   • The gate order is: forbidden-key scan → `admitSession` → request check.
 *   • The projection carries no main-only id (§P15).
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
import type { SalesListRecentResponse, RecentSaleRow } from '../../../../src/shared/bridge-api.js';
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

/** 2026-10-16 is Cairo summer time (UTC+3): the day runs 2026-10-15T21:00Z → 2026-10-16T21:00Z. */
const NOW = new Date('2026-10-16T10:00:00.000Z');

const [CASHIER_A, CASHIER_B, MANAGER, ADMIN, UNKNOWN_ROLE] = (
  [
    ['cashier', 'op-cashier-a'],
    ['cashier', 'op-cashier-b'],
    ['manager', 'op-manager'],
    ['admin', 'op-admin'],
    ['auditor', 'op-auditor'],
  ] as const
).map(
  ([role, operator_id]): OperatorSessionForSales => ({
    ...SCOPE,
    role: role as OperatorSessionForSales['role'],
    operator_id,
    operator_session_id: `sess-${operator_id}`,
  }),
) as [
  OperatorSessionForSales,
  OperatorSessionForSales,
  OperatorSessionForSales,
  OperatorSessionForSales,
  OperatorSessionForSales,
];

let db: SqlJsDatabase;
let seq = 0;

interface Seed {
  id: string;
  at: string;
  seller?: string;
  /** The stored day; also the date inside the number. Defaults to the UTC date of `at`. */
  day?: string;
  /** The sequence part of the number. Defaults to a running counter. */
  sequence?: string;
  number?: string;
  tenant?: string;
  branch?: string;
  terminal?: string;
  tenders?: string;
  subtotal?: number;
  tax?: number;
}

function seed(s: Seed): void {
  seq += 1;
  const day = s.day ?? s.at.slice(0, 10);
  const sequence = s.sequence ?? String(seq).padStart(6, '0');
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (?, ?, ?, ?, 'pa-secret', 'cart-secret', ?, ?, ?, 'TERM-01',
       ?, ?, 'sess', ?, ?, 0, ?, ?, ?, 'TRN-secret', 'Branch', 'Address', ?, '[]')`,
    [
      s.id,
      s.number ?? `TERM-01-${day}-${sequence}`,
      `R-${String(seq)}`,
      `handoff-${s.id}`,
      s.tenant ?? SCOPE.tenant_id,
      s.branch ?? SCOPE.branch_id,
      s.terminal ?? SCOPE.terminal_id,
      s.seller ?? CASHIER_A.operator_id,
      `Name ${s.seller ?? CASHIER_A.operator_id}`,
      s.subtotal ?? 2500,
      s.tax ?? 0,
      s.tenders ?? '[{"tender_type":"cash","amount_applied_minor":2500}]',
      s.at,
      s.at,
      day,
    ],
  );
}

function printEvent(saleId: string, outcome: string, printedAt: string): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path, acting_operator_id,
       acting_operator_session_id, duplicate_copy_sequence_number, failure_reason,
       previous_failed_print_event_ids, printed_at
     ) VALUES (?, ?, ?, 'first_print', 'os_print', 'op', 'sess', NULL, ?, NULL, ?)`,
    [
      `pe-${saleId}-${printedAt}`,
      saleId,
      outcome,
      outcome === 'failure' ? 'printer_offline' : null,
      printedAt,
    ],
  );
}

interface Harness {
  locked: boolean;
  audits: SaleRawAuditEvent[];
}

const harness = (): Harness => ({ locked: false, audits: [] });

function bridge(current: OperatorSessionForSales | null, h: Harness = harness(), now = NOW) {
  const handle = makeSqlJsHandle(db);
  return createSalesBridge({
    getCurrentSession: () => current,
    isSessionLocked: () => h.locked,
    auditEmitter: { emitRaw: (e: SaleRawAuditEvent) => void h.audits.push(e) },
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    drawerEventsRepo: bindDrawerEventsRepository(handle),
    clock: () => now,
  });
}

function listRecent(
  who: OperatorSessionForSales | null,
  req: Record<string, unknown> = {},
  now = NOW,
): Promise<SalesListRecentResponse> {
  return bridge(who, harness(), now).listRecent(req);
}

function okRes(res: SalesListRecentResponse): Extract<SalesListRecentResponse, { kind: 'ok' }> {
  if (res.kind !== 'ok') throw new Error(`expected ok, got ${res.reason}`);
  return res;
}

const ids = (res: SalesListRecentResponse): string[] => okRes(res).items.map((i) => i.sale_id);

beforeEach(() => {
  seq = 0;
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
});

// ── Scope and role ──────────────────────────────────────────────────────────

describe('RT-1189 — scope and role (OD-534-1)', () => {
  beforeEach(() => {
    seed({ id: 'a1', at: '2026-10-16T08:00:00.000Z', seller: CASHIER_A.operator_id });
    seed({ id: 'b1', at: '2026-10-16T08:10:00.000Z', seller: CASHIER_B.operator_id });
    seed({ id: 'm1', at: '2026-10-16T08:20:00.000Z', seller: MANAGER.operator_id });
    seed({ id: 'other-tenant', at: '2026-10-16T08:30:00.000Z', tenant: 'tenant-2' });
    seed({ id: 'other-branch', at: '2026-10-16T08:31:00.000Z', branch: 'branch-2' });
    seed({ id: 'other-terminal', at: '2026-10-16T08:32:00.000Z', terminal: 'terminal-2' });
  });

  it('shows a cashier only their own sales on this terminal', async () => {
    expect(ids(await listRecent(CASHIER_A))).toEqual(['a1']);
    expect(ids(await listRecent(CASHIER_B))).toEqual(['b1']);
  });

  it.each([
    ['manager', MANAGER],
    ['admin', ADMIN],
  ])('shows a %s every sale on this terminal, and nothing from another scope', async (_r, who) => {
    expect(ids(await listRecent(who))).toEqual(['m1', 'b1', 'a1']);
  });

  it('refuses a role outside the allowlist as role_denied and audits it', async () => {
    const h = harness();
    const res = await bridge(UNKNOWN_ROLE, h).listRecent({});
    expect(res).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action_category: 'sale.access.refused',
      payload: { action: 'sales.listRecent', reason: 'role_denied' },
    });
  });

  it('refuses no session, and a locked session, as no_session', async () => {
    expect(await listRecent(null)).toEqual({ kind: 'refused', reason: 'no_session' });
    const h = harness();
    h.locked = true;
    expect(await bridge(MANAGER, h).listRecent({})).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
  });

  it('answers no_session before any read', async () => {
    const handle = makeSqlJsHandle(db);
    const salesRepo = bindSalesRepository(handle);
    const spy = vi.spyOn(salesRepo, 'listRecentInWindow');
    const b = createSalesBridge({
      getCurrentSession: () => null,
      salesRepo,
      printEventsRepo: bindPrintEventsRepository(handle),
      drawerEventsRepo: bindDrawerEventsRepository(handle),
      clock: () => NOW,
    });
    expect(await b.listRecent({})).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a session without an operator id instead of widening a cashier to everything', async () => {
    const noId = { ...CASHIER_A, operator_id: '' };
    expect(await listRecent(noId)).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it.each([
    ['role', { role: 'manager' }],
    ['operator_id', { operator_id: CASHIER_B.operator_id }],
    ['selling_operator_id', { selling_operator_id: CASHIER_B.operator_id }],
    ['terminal_id', { terminal_id: 'terminal-2' }],
    ['tenant_id', { tenant_id: 'tenant-2' }],
    ['day', { business_day: '2026-10-15' }],
  ])('never honours a request that carries %s', async (_key, extra) => {
    const res = await listRecent(CASHIER_A, extra);
    expect(res).toEqual({ kind: 'refused', reason: 'invalid_input' });
  });

  it('refuses a request with a forbidden key before checking the session', async () => {
    expect(await listRecent(null, { pan: '4111' })).toEqual({
      kind: 'refused',
      reason: 'forbidden_field_in_request',
    });
  });
});

// ── Window ──────────────────────────────────────────────────────────────────

describe('RT-1189 — the current Cairo business day only', () => {
  it('excludes 23:30 Cairo yesterday and includes 00:10 Cairo today (UTC day = yesterday)', async () => {
    // 23:30 Cairo on 10-15 = 20:30Z; 00:10 Cairo on 10-16 = 21:10Z on 10-15.
    seed({ id: 'yesterday-2330', at: '2026-10-15T20:30:00.000Z' });
    seed({ id: 'today-0010', at: '2026-10-15T21:10:00.000Z', day: '2026-10-15' });
    seed({ id: 'today-noon', at: '2026-10-16T09:00:00.000Z' });
    const res = okRes(await listRecent(MANAGER));
    expect(res.items.map((i) => i.sale_id)).toEqual(['today-noon', 'today-0010']);
    expect(res.business_day).toBe('2026-10-16');
  });

  it('uses the system clock when none is injected', async () => {
    seed({ id: 'now-sale', at: '2026-10-16T09:00:00.000Z' });
    vi.useFakeTimers({ now: NOW });
    try {
      const handle = makeSqlJsHandle(db);
      const b = createSalesBridge({
        getCurrentSession: () => MANAGER,
        salesRepo: bindSalesRepository(handle),
        printEventsRepo: bindPrintEventsRepository(handle),
        drawerEventsRepo: bindDrawerEventsRepository(handle),
      });
      const res = okRes(await b.listRecent({}));
      expect(res.business_day).toBe('2026-10-16');
      expect(res.items.map((i) => i.sale_id)).toEqual(['now-sale']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes the first instant of tomorrow', async () => {
    seed({ id: 'last', at: '2026-10-16T20:59:59.999Z' });
    seed({ id: 'tomorrow', at: '2026-10-16T21:00:00.000Z' });
    const res = await listRecent(MANAGER, {}, new Date('2026-10-16T20:59:59.999Z'));
    expect(ids(res)).toEqual(['last']);
  });

  it('follows the clock into the next business day', async () => {
    seed({ id: 'old', at: '2026-10-16T09:00:00.000Z' });
    const res = okRes(await listRecent(MANAGER, {}, new Date('2026-10-16T21:30:00.000Z')));
    expect(res.business_day).toBe('2026-10-17');
    expect(res.items).toEqual([]);
  });

  it('covers the whole 25-hour fall-back day 2026-10-29', async () => {
    seed({ id: 'first', at: '2026-10-28T21:00:00.000Z', day: '2026-10-28' });
    seed({ id: 'late', at: '2026-10-29T21:30:00.000Z' });
    seed({ id: 'next', at: '2026-10-29T22:00:00.000Z' });
    const res = await listRecent(MANAGER, {}, new Date('2026-10-29T12:00:00.000Z'));
    expect(ids(res)).toEqual(['late', 'first']);
  });
});

// ── Short-form filter, order and cap ────────────────────────────────────────

describe('RT-1189 — short form, order and the 300 cap', () => {
  it('returns every match, including the same short form from two UTC runs in one Cairo day', async () => {
    // Number 000002 under the UTC date 10-15 (00:10 Cairo) and under 10-16 (noon).
    seed({ id: 'run1-2', at: '2026-10-15T21:10:00.000Z', day: '2026-10-15', sequence: '000002' });
    seed({ id: 'run2-2', at: '2026-10-16T09:00:00.000Z', day: '2026-10-16', sequence: '000002' });
    seed({ id: 'run2-3', at: '2026-10-16T09:05:00.000Z', day: '2026-10-16', sequence: '000003' });
    const res = okRes(await listRecent(MANAGER, { short_number: '2' }));
    expect(res.items.map((i) => i.sale_id)).toEqual(['run2-2', 'run1-2']);
    expect(res.items.map((i) => i.short_number)).toEqual(['2', '2']);
    expect(res.items.map((i) => i.sale_number)).toEqual([
      'TERM-01-2026-10-16-000002',
      'TERM-01-2026-10-15-000002',
    ]);
  });

  it('returns nothing for a short form with no sale today, and one for a single match', async () => {
    seed({ id: 's47', at: '2026-10-16T09:00:00.000Z', sequence: '000047' });
    expect(okRes(await listRecent(MANAGER, { short_number: '48' })).items).toEqual([]);
    expect(ids(await listRecent(MANAGER, { short_number: '47' }))).toEqual(['s47']);
  });

  it('normalises Arabic-Indic digits, leading zeros and bidi marks before resolving', async () => {
    seed({ id: 's47', at: '2026-10-16T09:00:00.000Z', sequence: '000047' });
    for (const typed of ['٤٧', '۴۷', '٠٤٧', '047', '‎٤٧‏']) {
      expect(ids(await listRecent(MANAGER, { short_number: typed }))).toEqual(['s47']);
    }
  });

  it('matches a seven-digit sequence on its full digits', async () => {
    seed({ id: 'big', at: '2026-10-16T09:00:00.000Z', sequence: '1000000' });
    expect(ids(await listRecent(MANAGER, { short_number: '1000000' }))).toEqual(['big']);
    expect(ids(await listRecent(MANAGER, { short_number: '1' }))).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['letters', 'abc'],
    ['an exact number', 'TERM-01-2026-10-16-000002'],
    ['ten digits', '1234567890'],
    ['null', null],
    ['a number', 42],
    ['an object', { digits: '4' }],
  ])('refuses short_number as %s with invalid_input', async (_label, short_number) => {
    expect(await listRecent(MANAGER, { short_number })).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
  });

  it('applies the filter before the cap: a match older than the newest 300 is still found', async () => {
    seed({ id: 'the-one', at: '2026-10-15T21:05:00.000Z', day: '2026-10-15', sequence: '000042' });
    for (let i = 0; i < 305; i += 1) {
      const at = new Date(Date.UTC(2026, 9, 16, 6, 0, 0) + i * 1000).toISOString();
      seed({ id: `n${String(i)}`, at, sequence: String(1000 + i).padStart(6, '0') });
    }
    const unfiltered = okRes(await listRecent(MANAGER));
    expect(unfiltered.items).toHaveLength(300);
    expect(unfiltered.items.some((i) => i.sale_id === 'the-one')).toBe(false);
    const filtered = okRes(await listRecent(MANAGER, { short_number: '42' }));
    expect(filtered.items.map((i) => i.sale_id)).toEqual(['the-one']);
    expect(filtered.truncated).toBe(false);
  });

  it('caps at 300 and says so; 300 exactly is not truncated', async () => {
    for (let i = 0; i < 301; i += 1) {
      const at = new Date(Date.UTC(2026, 9, 16, 6, 0, 0) + i * 1000).toISOString();
      seed({ id: `n${String(i)}`, at });
    }
    const over = okRes(await listRecent(MANAGER));
    expect(over.items).toHaveLength(300);
    expect(over.truncated).toBe(true);
    expect(over.items[0]?.sale_id).toBe('n300'); // newest first
    expect(over.items.at(-1)?.sale_id).toBe('n1'); // the oldest row fell off
  });

  it('does not call exactly 300 rows truncated', async () => {
    for (let i = 0; i < 300; i += 1) {
      const at = new Date(Date.UTC(2026, 9, 16, 6, 0, 0) + i * 1000).toISOString();
      seed({ id: `n${String(i)}`, at });
    }
    const exact = okRes(await listRecent(MANAGER));
    expect(exact.items).toHaveLength(300);
    expect(exact.truncated).toBe(false);
  });

  it('orders by finalized_at descending, then sale_id descending', async () => {
    seed({ id: 'a', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'b', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'c', at: '2026-10-16T08:00:00.000Z' });
    expect(ids(await listRecent(MANAGER))).toEqual(['b', 'a', 'c']);
  });

  it('lists a number that does not parse with short_number null, and never matches it', async () => {
    seed({ id: 'odd', at: '2026-10-16T09:00:00.000Z', number: 'HAND-ENTERED' });
    // The number embeds 10-16 but the stored day is 10-17: no short form is invented.
    seed({
      id: 'mismatch',
      at: '2026-10-16T09:01:00.000Z',
      day: '2026-10-17',
      number: 'TERM-01-2026-10-16-000007',
    });
    const all = okRes(await listRecent(MANAGER));
    expect(all.items.map((i) => [i.sale_id, i.short_number])).toEqual([
      ['mismatch', null],
      ['odd', null],
    ]);
    expect(okRes(await listRecent(MANAGER, { short_number: '7' })).items).toEqual([]);
  });
});

// ── Projection ──────────────────────────────────────────────────────────────

function keysDeep(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      found.add(k);
      keysDeep(v, found);
    }
  }
  return found;
}

describe('RT-1189 — projection (§P15)', () => {
  it('carries exactly the row fields, with total, tenders and print state', async () => {
    seed({
      id: 's1',
      at: '2026-10-16T09:00:00.000Z',
      sequence: '000047',
      seller: MANAGER.operator_id,
      subtotal: 10_000,
      tax: 1_400,
      tenders:
        '[{"tender_type":"cash","amount_applied_minor":5000},{"tender_type":"external_card_terminal","amount_applied_minor":6400,"external_reference":"REF-SECRET"},{"tender_type":"cash","amount_applied_minor":1}]',
    });
    printEvent('s1', 'failure', '2026-10-16T09:00:05.000Z');
    printEvent('s1', 'success', '2026-10-16T09:01:00.000Z');
    const res = okRes(await listRecent(MANAGER));
    expect(res).toEqual({
      kind: 'ok',
      business_day: '2026-10-16',
      truncated: false,
      items: [
        {
          sale_id: 's1',
          sale_number: 'TERM-01-2026-10-16-000047',
          short_number: '47',
          finalized_at: '2026-10-16T09:00:00.000Z',
          total_minor: 11_400,
          tender_types: ['cash', 'external_card_terminal'],
          selling_operator_display_name: `Name ${MANAGER.operator_id}`,
          latest_print_outcome: 'success',
        },
      ],
    });
  });

  it("says 'none' when no print event exists", async () => {
    seed({ id: 's1', at: '2026-10-16T09:00:00.000Z' });
    const item = okRes(await listRecent(MANAGER)).items[0] as RecentSaleRow;
    expect(item.latest_print_outcome).toBe('none');
  });

  it('never throws on an unreadable tender summary: no tender types', async () => {
    seed({ id: 'bad', at: '2026-10-16T09:00:00.000Z', tenders: '{not json' });
    seed({
      id: 'odd',
      at: '2026-10-16T09:01:00.000Z',
      tenders: '[{"tender_type":"gold"},{"x":1},null,"cash"]',
    });
    const res = okRes(await listRecent(MANAGER));
    expect(res.items.map((i) => i.tender_types)).toEqual([[], []]);
  });

  it('exposes no main-only id, tax id, seller id or tender reference anywhere in the answer', async () => {
    seed({ id: 's1', at: '2026-10-16T09:00:00.000Z' });
    const res = await listRecent(MANAGER);
    const keys = keysDeep(res);
    for (const forbidden of [
      'envelope_handoff_action_id',
      'payment_attempt_id',
      'envelope_cart_id',
      'tenant_tax_registration_id',
      'selling_operator_id',
      'tender_lines_summary',
      'external_reference',
      'tenant_id',
      'branch_id',
      'terminal_id',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    const text = JSON.stringify(res);
    for (const secret of ['pa-secret', 'cart-secret', 'TRN-secret', 'handoff-s1']) {
      expect(text).not.toContain(secret);
    }
  });
});

// ── Operator identity (doc 20 §11) ──────────────────────────────────────────

describe('RT-1189 — a cashier admitted by offline PIN sees the sales they started', () => {
  it('uses the same operator_id for the payment-time stamp and the list filter', async () => {
    const { resolveSessionScope } =
      await import('../../../../src/main/operator/resolve-session-scope.js');
    const { deriveAttributionOperatorId } =
      await import('../../../../src/main/payments/audit-emitter.js');
    // An offline-PIN session: the re-anchored `user_id` is present (017/019),
    // `operator_id` is the one the payment and sales adapters both read.
    const record = {
      id: 'sess-offline',
      role: 'cashier',
      operator_id: 'op-offline-cashier',
      tenant_id: SCOPE.tenant_id,
      branch_id: SCOPE.branch_id,
      display_name: 'Offline Cashier',
      user_id: 'user-reanchored',
    } as unknown as Parameters<typeof resolveSessionScope>[0];
    const paymentScope = resolveSessionScope(record, SCOPE.terminal_id);
    expect(paymentScope).not.toBeNull();
    const stamped = deriveAttributionOperatorId({
      kind: 'operator_session',
      operator_id: (paymentScope as NonNullable<typeof paymentScope>).operator_id,
    });
    seed({ id: 'mine', at: '2026-10-16T09:00:00.000Z', seller: stamped });
    seed({ id: 'theirs', at: '2026-10-16T09:01:00.000Z', seller: CASHIER_B.operator_id });
    const salesSession = resolveSessionScope(record, SCOPE.terminal_id) as OperatorSessionForSales;
    expect(ids(await listRecent(salesSession))).toEqual(['mine']);
  });
});
