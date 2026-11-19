/**
 * RT-1312 Phase 3(c) — migration-shape and upgrade test for
 * `0065_sale_quarantine_upload` ([GATED: migration]):
 *   • the number right after 0064, and only it;
 *   • one additive table and one index, nothing dropped or altered, no trigger;
 *   • the CHECKs keep a row well-formed (ids, state, counters);
 *   • one row per sale (the primary key);
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

const MIGRATION = '0065_sale_quarantine_upload';
const TABLE = 'sale_quarantine_upload';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
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
  sale_id?: string;
  tenant_id?: string;
  branch_id?: string;
  state?: string;
  attempts?: number;
}

function insert(o: RowInput = {}): void {
  db.run(
    `INSERT INTO ${TABLE}
       (sale_id, tenant_id, branch_id, state, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.sale_id ?? 'sale-1',
      o.tenant_id ?? 'tenant-1',
      o.branch_id ?? 'branch-1',
      o.state ?? 'pending',
      o.attempts ?? 0,
      AT,
      AT,
      AT,
    ],
  );
}

describe('0065 — sale quarantine upload (RT-1312 Phase 3(c), [GATED: migration])', () => {
  it('is the only migration numbered 0065, right after 0064', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0065_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe('0064_unknown_item_captures.sql');
  });

  it('adds one table and one index, and drops or alters nothing', () => {
    const code = SQL_TEXT.replace(/--.*$/gm, '');
    expect(code.match(/^CREATE TABLE .*$/gm)).toEqual([`CREATE TABLE IF NOT EXISTS ${TABLE} (`]);
    expect(code.match(/^CREATE INDEX .*$/gm)).toEqual([
      'CREATE INDEX IF NOT EXISTS idx_sale_quarantine_upload_due',
    ]);
    expect(code).not.toMatch(/DROP|ALTER|TRIGGER|UPDATE\s+\w+\s+SET|DELETE FROM|INSERT\s+INTO/i);
    expect(columns(TABLE)).toEqual([
      'sale_id',
      'tenant_id',
      'branch_id',
      'state',
      'attempts',
      'next_attempt_at',
      'last_status',
      'quarantine_ref',
      'quarantine_state',
      'created_at',
      'updated_at',
      'settled_at',
    ]);
  });

  it('carries the [GATED] note and the manual rollback', () => {
    expect(SQL_TEXT).toContain('[GATED: migration]');
    expect(SQL_TEXT).toContain('RT-1312 comment 17804');
    expect(SQL_TEXT).toMatch(/Rollback/);
  });

  it('defaults a new row to pending with no status and no receipt', () => {
    db.run(
      `INSERT INTO ${TABLE} (sale_id, tenant_id, branch_id, next_attempt_at, created_at, updated_at)
       VALUES ('sale-1', 'tenant-1', 'branch-1', ?, ?, ?)`,
      [AT, AT, AT],
    );
    expect(
      db.exec(
        `SELECT state, attempts, last_status, quarantine_ref, quarantine_state, settled_at FROM ${TABLE}`,
      )[0]?.values,
    ).toEqual([['pending', 0, null, null, null, null]]);
  });

  it('keeps one row per sale', () => {
    insert();
    expect(() => {
      insert();
    }).toThrow(/UNIQUE|PRIMARY/);
    insert({ sale_id: 'sale-2' });
    expect(db.exec(`SELECT COUNT(*) FROM ${TABLE}`)[0]?.values).toEqual([[2]]);
  });

  it.each([
    ['an empty sale id', { sale_id: '' }],
    ['an empty tenant', { tenant_id: '' }],
    ['an empty branch', { branch_id: '' }],
    ['an unknown state', { state: 'lost' }],
    ['a negative attempt count', { attempts: -1 }],
  ])('refuses %s', (_name, input: RowInput) => {
    expect(() => {
      insert(input);
    }).toThrow(/CHECK/);
  });

  it.each(['pending', 'uploaded', 'refused'])('accepts the state %s', (state) => {
    insert({ state });
    expect(db.exec(`SELECT state FROM ${TABLE}`)[0]?.values).toEqual([[state]]);
  });

  it('re-applies as a no-op: a stored row survives', () => {
    insert();
    db.exec(SQL_TEXT);
    expect(db.exec(`SELECT sale_id FROM ${TABLE}`)[0]?.values).toEqual([['sale-1']]);
  });

  it('applies exactly once through the real runner', () => {
    db.exec(`DROP INDEX idx_sale_quarantine_upload_due; DROP TABLE ${TABLE};`);
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
    expect(columns(TABLE)).toContain('quarantine_ref');
  });
});
