/**
 * RT-1490 — migration-shape and upgrade test for `0064_unknown_item_captures`
 * ([GATED: migration], owner approval on RT-1490 comment 17782):
 *   • the number right after 0063, and only it;
 *   • one additive table and one index, nothing dropped or altered;
 *   • the CHECKs keep a row well-formed (id, scope, barcode bounds, day, state);
 *   • UNIQUE (tenant, branch, barcode, day) is the daily cap;
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

const MIGRATION = '0064_unknown_item_captures';
const TABLE = 'unknown_item_captures';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const ID_A = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const ID_B = '0192f5a2-3b4c-7d8e-9f01-0000000000b2';
const AT = '2026-11-19T10:00:00.000Z';

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

interface RowInput {
  capture_id?: string;
  tenant_id?: string;
  branch_id?: string;
  terminal_id?: string;
  barcode?: string;
  capture_day?: string;
  state?: string;
}

function insert(o: RowInput = {}): void {
  db.run(
    `INSERT INTO ${TABLE}
       (capture_id, tenant_id, branch_id, terminal_id, barcode, capture_day, state,
        next_attempt_at, enqueued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.capture_id ?? ID_A,
      o.tenant_id ?? 'tenant-1',
      o.branch_id ?? 'branch-1',
      o.terminal_id ?? 'terminal-1',
      o.barcode ?? '6221000000099',
      o.capture_day ?? '2026-11-19',
      o.state ?? 'pending',
      AT,
      AT,
    ],
  );
}

describe('0064 — unknown item captures (RT-1490, [GATED: migration])', () => {
  it('is the only migration numbered 0064, right after 0063', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0064_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe('0063_shift_manager_closures.sql');
  });

  it('adds one table and one index, and drops or alters nothing', () => {
    const code = SQL_TEXT.replace(/--.*$/gm, '');
    expect(code.match(/^CREATE TABLE .*$/gm)).toEqual([`CREATE TABLE IF NOT EXISTS ${TABLE} (`]);
    expect(code.match(/^CREATE INDEX .*$/gm)).toEqual([
      'CREATE INDEX IF NOT EXISTS idx_unknown_item_captures_due',
    ]);
    expect(code).not.toMatch(/DROP|ALTER|TRIGGER|UPDATE\s+\w+\s+SET|DELETE FROM|INSERT\s+INTO/i);
    expect(columns(TABLE)).toEqual([
      'capture_id',
      'tenant_id',
      'branch_id',
      'terminal_id',
      'barcode',
      'capture_day',
      'state',
      'attempts',
      'next_attempt_at',
      'last_status',
      'enqueued_at',
      'settled_at',
    ]);
  });

  it('carries the [GATED] approval note and the manual rollback', () => {
    expect(SQL_TEXT).toContain('[GATED: migration]');
    expect(SQL_TEXT).toContain('RT-1490 comment 17782');
    expect(SQL_TEXT).toMatch(/Rollback/);
  });

  it('defaults a new row to pending with no attempts', () => {
    insert();
    expect(
      db.exec(`SELECT state, attempts, last_status, settled_at FROM ${TABLE}`)[0]?.values,
    ).toEqual([['pending', 0, null, null]]);
  });

  it('is the daily cap: one row per tenant, branch, barcode and day', () => {
    insert();
    expect(() => {
      insert({ capture_id: ID_B });
    }).toThrow(/UNIQUE/);
    // Another day, another store or another barcode is its own row.
    insert({ capture_id: ID_B, capture_day: '2026-11-20' });
    insert({ capture_id: '0192f5a2-3b4c-7d8e-9f01-0000000000c3', branch_id: 'branch-2' });
    insert({ capture_id: '0192f5a2-3b4c-7d8e-9f01-0000000000d4', barcode: '123' });
    expect(db.exec(`SELECT COUNT(*) FROM ${TABLE}`)[0]?.values).toEqual([[4]]);
  });

  it.each([
    ['a short id', { capture_id: 'abc' }],
    ['an empty tenant', { tenant_id: '' }],
    ['an empty branch', { branch_id: '' }],
    ['an empty terminal', { terminal_id: '' }],
    ['an empty barcode', { barcode: '' }],
    ['a barcode over 200 characters', { barcode: '9'.repeat(201) }],
    ['a day that is not YYYY-MM-DD', { capture_day: '19/11/2026' }],
    ['an unknown state', { state: 'lost' }],
  ])('refuses %s', (_name, input: RowInput) => {
    expect(() => {
      insert(input);
    }).toThrow(/CHECK/);
  });

  it('re-applies as a no-op: a queued row survives', () => {
    insert();
    db.exec(SQL_TEXT);
    expect(db.exec(`SELECT capture_id FROM ${TABLE}`)[0]?.values).toEqual([[ID_A]]);
  });

  it('applies exactly once through the real runner', () => {
    db.exec(`DROP INDEX idx_unknown_item_captures_due; DROP TABLE ${TABLE};`);
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
    expect(columns(TABLE)).toContain('capture_day');
  });
});
