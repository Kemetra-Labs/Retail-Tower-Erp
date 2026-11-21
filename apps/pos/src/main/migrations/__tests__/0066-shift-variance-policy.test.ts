/**
 * RT-388 — migration-shape and upgrade test for `0066_shift_variance_policy`
 * ([GATED: migration]):
 *   • the number right after 0065, and only it;
 *   • two additive tables, nothing dropped or altered, shipped empty;
 *   • the CHECKs keep a policy row well-formed (source / revision id / mode / limit);
 *   • the frozen policy of an open is append-only and one row per shift;
 *   • the [GATED] note and the rollback are present; the real runner applies
 *     it once and a re-apply is a no-op.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0066_shift_variance_policy';
const CACHE = 'cash_variance_policy_cache';
const FROZEN = 'shift_cashup_open_policies';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const AT = '2026-11-21T10:00:00.000Z';
const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const SHIFT = '0190f5a2-3b4c-7d8e-9f01-23456789abce';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
});

afterEach(() => {
  db.close();
});

function columns(table: string): string[] {
  return (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((r) => String(r[1]));
}

interface PolicyInput {
  source?: string;
  revision?: string | null;
  mode?: string;
  limit?: string | null;
  currency?: string | null;
}

function policyOf(o: PolicyInput): [string, string | null, string, string | null, string | null] {
  return [
    o.source ?? 'tenant',
    o.revision === undefined ? REVISION : o.revision,
    o.mode ?? 'limit',
    o.limit === undefined ? '100.00' : o.limit,
    o.currency === undefined ? 'EGP' : o.currency,
  ];
}

function insertCache(o: PolicyInput & { id?: number; tenant?: string } = {}): void {
  db.run(
    `INSERT INTO ${CACHE} (id, tenant_id, branch_id, policy_source, policy_revision_id,
       policy_mode, limit_amount, currency_code, etag, server_time, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.id ?? 1, o.tenant ?? 'tenant-1', 'branch-1', ...policyOf(o), '"abc"', AT, AT],
  );
}

function seedOpen(shift: string): void {
  if (db.exec(`SELECT 1 FROM shift_cashup_opens WHERE shift_id = '${shift}'`).length > 0) return;
  db.run(
    `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id,
       opening_user_id, currency_code, opening_float_minor, opened_at, created_at)
     VALUES (?, 'tenant-1', 'branch-1', 'terminal-1', ?, 'EGP', 0, ?, ?)`,
    [shift, SHIFT, AT, AT],
  );
}

function insertFrozen(o: PolicyInput & { shift?: string } = {}): void {
  seedOpen(o.shift ?? SHIFT);
  db.run(
    `INSERT INTO ${FROZEN} (shift_id, policy_source, policy_revision_id, policy_mode,
       limit_amount, currency_code, frozen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [o.shift ?? SHIFT, ...policyOf(o), AT],
  );
}

describe('0066 — shift variance policy (RT-388, [GATED: migration])', () => {
  it('is the only migration numbered 0066, right after 0065', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0066_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe('0065_sale_quarantine_upload.sql');
  });

  it('adds two tables, drops or alters nothing, and ships empty', () => {
    const code = SQL_TEXT.replace(/--.*$/gm, '');
    expect(code.match(/^CREATE TABLE .*$/gm)).toEqual([
      `CREATE TABLE IF NOT EXISTS ${CACHE} (`,
      `CREATE TABLE IF NOT EXISTS ${FROZEN} (`,
    ]);
    expect(code).not.toMatch(/DROP TABLE|ALTER|UPDATE\s+\w+\s+SET|DELETE FROM|INSERT\s+INTO/i);
    expect(columns(CACHE)).toEqual([
      'id',
      'tenant_id',
      'branch_id',
      'policy_source',
      'policy_revision_id',
      'policy_mode',
      'limit_amount',
      'currency_code',
      'etag',
      'server_time',
      'fetched_at',
    ]);
    expect(columns(FROZEN)).toEqual([
      'shift_id',
      'policy_source',
      'policy_revision_id',
      'policy_mode',
      'limit_amount',
      'currency_code',
      'frozen_at',
    ]);
    expect(db.exec(`SELECT COUNT(*) FROM ${CACHE}`)[0]?.values).toEqual([[0]]);
    expect(db.exec(`SELECT COUNT(*) FROM ${FROZEN}`)[0]?.values).toEqual([[0]]);
  });

  it('carries the [GATED] note, the approval and the manual rollback', () => {
    expect(SQL_TEXT).toContain('[GATED: migration]');
    expect(SQL_TEXT).toContain('RT-388 comment 18072');
    expect(SQL_TEXT).toMatch(/Rollback/);
  });

  it('keeps the cache a single row', () => {
    insertCache();
    expect(() => {
      insertCache({ id: 2 });
    }).toThrow(/CHECK/);
    expect(() => {
      insertCache();
    }).toThrow(/UNIQUE|PRIMARY/);
  });

  it('keeps one frozen policy per shift', () => {
    insertFrozen();
    expect(() => {
      insertFrozen();
    }).toThrow(/UNIQUE|PRIMARY/);
  });

  it.each([
    ['a tenant policy without a revision id', { source: 'tenant', revision: null }],
    ['a store policy without a revision id', { source: 'store', revision: null }],
    [
      'a system policy with a revision id',
      { source: 'system', mode: 'none', limit: null, currency: null },
    ],
    ['a fallback with a revision id', { source: 'fallback' }],
    ['an unknown source', { source: 'guess', revision: null }],
    ['an unknown mode', { mode: 'warn' }],
    ['a limit without an amount', { limit: null }],
    ['a limit without a currency', { currency: null }],
    ['a none that still carries an amount', { mode: 'none' }],
    ['a system policy that is a limit', { source: 'system', revision: null }],
    ['a negative limit', { limit: '-1.00' }],
    ['a limit that is not an exact decimal', { limit: '1e3' }],
    ['a lower-case currency', { currency: 'egp' }],
  ])('refuses %s (frozen policy)', (_name, input: PolicyInput) => {
    expect(() => {
      insertFrozen(input);
    }).toThrow(/CHECK/);
  });

  it.each([
    ['a tenant limit', { source: 'tenant' }],
    ['a store limit', { source: 'store' }],
    [
      'a system none',
      { source: 'system', revision: null, mode: 'none', limit: null, currency: null },
    ],
    ['a fallback limit 0', { source: 'fallback', revision: null, limit: '0.00' }],
  ])('accepts %s (frozen policy)', (_name, input: PolicyInput) => {
    insertFrozen(input);
    expect(db.exec(`SELECT COUNT(*) FROM ${FROZEN}`)[0]?.values).toEqual([[1]]);
  });

  it('refuses the same malformed rows in the cache, and a fallback (never delivered)', () => {
    expect(() => {
      insertCache({ source: 'tenant', revision: null });
    }).toThrow(/CHECK/);
    expect(() => {
      insertCache({ source: 'fallback', revision: null });
    }).toThrow(/CHECK/);
  });

  it('makes the frozen policy of an open append-only', () => {
    insertFrozen();
    expect(() => {
      db.run(`UPDATE ${FROZEN} SET limit_amount = '1.00'`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`DELETE FROM ${FROZEN}`);
    }).toThrow(/append-only/);
  });

  it('lets the cache be replaced', () => {
    insertCache();
    db.run(`UPDATE ${CACHE} SET limit_amount = '5.00' WHERE id = 1`);
    expect(db.exec(`SELECT limit_amount FROM ${CACHE}`)[0]?.values).toEqual([['5.00']]);
  });

  it('re-applies as a no-op: stored rows survive', () => {
    insertCache();
    insertFrozen();
    db.exec(SQL_TEXT);
    expect(db.exec(`SELECT COUNT(*) FROM ${CACHE}`)[0]?.values).toEqual([[1]]);
    expect(db.exec(`SELECT COUNT(*) FROM ${FROZEN}`)[0]?.values).toEqual([[1]]);
  });

  it('applies exactly once through the real runner', () => {
    db.exec(
      `DROP TRIGGER trg_shift_cashup_open_policies_no_update;
       DROP TRIGGER trg_shift_cashup_open_policies_no_delete;
       DROP TABLE ${FROZEN}; DROP TABLE ${CACHE};`,
    );
    const applied: string[] = [];
    const runnerDb: MigrationsDb = {
      exec: (sql) => {
        db.exec(sql);
      },
      listAppliedNames: () => applied,
      recordApplied: (row) => applied.push(row.name),
      transaction: (fn) => fn(),
    };
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    expect(columns(FROZEN)).toContain('policy_revision_id');
  });
});
