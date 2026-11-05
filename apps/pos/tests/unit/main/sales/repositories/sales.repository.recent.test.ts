/**
 * RT-1189 (RT-249 N-S1) — `sales` repository window read (`listRecentInWindow`).
 *
 *   • A half-open `[start, end)` window over `finalized_at`, newest first, ties
 *     by `sale_id` descending, at most `limit`.
 *   • Scoped to tenant / branch / terminal, and to one selling operator when a
 *     filter is given.
 *   • `sale_number_suffix` keeps only numbers ending with it.
 *   • Only the recent-list columns are read; the query uses migration 0055's
 *     index with and without the suffix.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  RECENT_SALES_SQL,
  bindSalesRepository,
  type RecentSalesQuery,
  type SalesRepository,
} from '../../../../../src/main/sales/repositories/sales.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b))
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
let repo: SalesRepository;
let seq = 0;

const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

interface Seed {
  id: string;
  at: string;
  number?: string;
  seller?: string;
  tenant?: string;
}

function seed(s: Seed): void {
  seq += 1;
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (?, ?, ?, ?, 'pa', 'cart', ?, 'branch-1', 'terminal-1', 'T',
       ?, 'Name', 'sess', 100, 14, 0, '[]', ?, ?, 'TRN', 'B', 'A', ?, '[]')`,
    [
      s.id,
      s.number ?? `T-${s.at.slice(0, 10)}-${String(seq).padStart(6, '0')}`,
      `R-${String(seq)}`,
      `h-${s.id}`,
      s.tenant ?? SCOPE.tenant_id,
      s.seller ?? 'op-a',
      s.at,
      s.at,
      s.at.slice(0, 10),
    ],
  );
}

const query = (over: Partial<RecentSalesQuery> = {}): RecentSalesQuery => ({
  scope: SCOPE,
  selling_operator_id: null,
  start_inclusive: '2026-10-15T21:00:00.000Z',
  end_exclusive: '2026-10-16T21:00:00.000Z',
  sale_number_suffix: null,
  limit: 301,
  ...over,
});

beforeEach(() => {
  seq = 0;
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
  repo = bindSalesRepository(makeSqlJsHandle(db));
});

describe('RT-1189 — listRecentInWindow', () => {
  it('reads [start, end) newest first, ties by sale_id descending', () => {
    seed({ id: 'before', at: '2026-10-15T20:59:59.999Z' });
    seed({ id: 'first', at: '2026-10-15T21:00:00.000Z' });
    seed({ id: 'a', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'b', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'after', at: '2026-10-16T21:00:00.000Z' });
    expect(repo.listRecentInWindow(query()).map((r) => r.sale_id)).toEqual(['b', 'a', 'first']);
  });

  it('is scoped to the tenant, and to one operator when given', () => {
    seed({ id: 'mine', at: '2026-10-16T09:00:00.000Z', seller: 'op-a' });
    seed({ id: 'theirs', at: '2026-10-16T09:01:00.000Z', seller: 'op-b' });
    seed({ id: 'foreign', at: '2026-10-16T09:02:00.000Z', tenant: 'tenant-2' });
    expect(repo.listRecentInWindow(query()).map((r) => r.sale_id)).toEqual(['theirs', 'mine']);
    expect(
      repo.listRecentInWindow(query({ selling_operator_id: 'op-a' })).map((r) => r.sale_id),
    ).toEqual(['mine']);
  });

  it('keeps only numbers that end with the suffix', () => {
    seed({ id: 's47', at: '2026-10-16T09:00:00.000Z', number: 'T-2026-10-16-000047' });
    seed({ id: 's147', at: '2026-10-16T09:01:00.000Z', number: 'T-2026-10-16-000147' });
    seed({ id: 's470', at: '2026-10-16T09:02:00.000Z', number: 'T-2026-10-16-000470' });
    const rows = repo.listRecentInWindow(query({ sale_number_suffix: '-000047' }));
    expect(rows.map((r) => r.sale_id)).toEqual(['s47']);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i += 1) {
      seed({ id: `s${String(i)}`, at: `2026-10-16T09:0${String(i)}:00.000Z` });
    }
    expect(repo.listRecentInWindow(query({ limit: 3 }))).toHaveLength(3);
  });

  it('reads only the recent-list columns', () => {
    seed({ id: 's1', at: '2026-10-16T09:00:00.000Z', number: 'T-2026-10-16-000001' });
    expect(Object.keys(repo.listRecentInWindow(query())[0] ?? {}).sort()).toEqual([
      'finalized_at',
      'local_calendar_day',
      'sale_id',
      'sale_number',
      'selling_operator_display_name',
      'subtotal_minor',
      'tender_lines_summary_json',
      'total_tax_minor',
    ]);
  });
});

describe('RT-1189 — listRecentInWindow: uses the 0055 index', () => {
  function plan(params: unknown[]): string {
    return (
      db
        .exec(`EXPLAIN QUERY PLAN ${RECENT_SALES_SQL}`, params as never[])[0]
        ?.values.map((row) => String(row[3]))
        .join(' | ') ?? ''
    );
  }

  it.each([
    ['the whole day', null],
    ['a short form', '%-000047'],
  ])('%s searches idx_sales_tenant_branch_finalized_at, never scans', (_label, pattern) => {
    for (let i = 0; i < 3000; i += 1) {
      const minute = String(i % 60).padStart(2, '0');
      const day = String(1 + (i % 28)).padStart(2, '0');
      seed({
        id: `p${String(i)}`,
        at: `2026-10-${day}T10:${minute}:00.000Z`,
        seller: `op-${String(i % 4)}`,
      });
    }
    db.exec('ANALYZE');
    const text = plan([
      'tenant-1',
      'branch-1',
      'terminal-1',
      null,
      null,
      's',
      'e',
      pattern,
      pattern,
      301,
    ]);
    expect(text).toContain('USING INDEX idx_sales_tenant_branch_finalized_at');
    expect(text).not.toMatch(/SCAN sales/);
  });
});
