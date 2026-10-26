/**
 * RT-886 — migration-shape test for `0057_terminal_printer_setting` ([GATED],
 * owner-authorized in Jira RT-839 comment 13968 Q3: one local table for the
 * printer choice, nothing else).
 *   • the number right after 0056, and only it;
 *   • one table, at most one row, the name bound to the source;
 *   • applies on a database that already holds data, re-applies safely;
 *   • the real runner applies it once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0057_terminal_printer_setting';
const TABLE = 'terminal_printer_setting';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

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

function columns(): string[] {
  return (db.exec(`PRAGMA table_info(${TABLE})`)[0]?.values ?? []).map((r) => String(r[1]));
}

function insert(values: {
  id?: number;
  source: string;
  name: string | null;
  operator?: string;
}): void {
  db.run(
    `INSERT INTO ${TABLE} (id, printer_source, printer_name, updated_at, updated_by_operator_id)
     VALUES (?, ?, ?, '2026-10-26T10:00:00.000Z', ?)`,
    [values.id ?? 1, values.source, values.name, values.operator ?? 'user_op1'],
  );
}

describe('0057 — terminal printer setting (RT-886, [GATED])', () => {
  it('is the only migration numbered 0057, right after 0056', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0057_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe('0056_approver_role.sql');
  });

  it('creates one table and nothing else', () => {
    const statements = SQL_TEXT.replace(/--.*$/gm, '')
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS terminal_printer_setting/);
    expect(columns()).toEqual([
      'id',
      'printer_source',
      'printer_name',
      'updated_at',
      'updated_by_operator_id',
    ]);
  });

  it('ships empty: no choice until an operator makes one', () => {
    expect(db.exec(`SELECT COUNT(*) FROM ${TABLE}`)[0]?.values[0]?.[0]).toBe(0);
  });

  it('holds a chosen printer or the Windows default', () => {
    insert({ source: 'chosen', name: 'BIXOLON SRP-330II' });
    db.run(`DELETE FROM ${TABLE}`);
    insert({ source: 'os_default', name: null });
    expect(db.exec(`SELECT printer_source, printer_name FROM ${TABLE}`)[0]?.values).toEqual([
      ['os_default', null],
    ]);
  });

  it('keeps at most one row', () => {
    insert({ source: 'os_default', name: null });
    expect(() => {
      insert({ id: 2, source: 'os_default', name: null });
    }).toThrow(/CHECK/);
    expect(() => {
      insert({ id: 1, source: 'os_default', name: null });
    }).toThrow(/UNIQUE|PRIMARY/);
  });

  it('binds the name to the source', () => {
    expect(() => {
      insert({ source: 'chosen', name: null });
    }).toThrow(/CHECK/);
    expect(() => {
      insert({ source: 'chosen', name: '' });
    }).toThrow(/CHECK/);
    expect(() => {
      insert({ source: 'chosen', name: 'x'.repeat(257) });
    }).toThrow(/CHECK/);
    expect(() => {
      insert({ source: 'os_default', name: 'HP' });
    }).toThrow(/CHECK/);
    expect(() => {
      insert({ source: 'thermal', name: null });
    }).toThrow(/CHECK/);
    expect(() => {
      insert({ source: 'os_default', name: null, operator: '' });
    }).toThrow(/CHECK/);
  });

  it('applies to a database that already holds data, and re-applies as a no-op', () => {
    db.exec(`DROP TABLE ${TABLE};`);
    seedSale(db, { sale_id: 'sale-1' });
    const before = db.exec('SELECT * FROM sales')[0]?.values;
    db.exec(SQL_TEXT);
    insert({ source: 'chosen', name: 'XP-80C' });
    db.exec(SQL_TEXT); // IF NOT EXISTS: the saved choice survives
    expect(db.exec(`SELECT printer_name FROM ${TABLE}`)[0]?.values).toEqual([['XP-80C']]);
    expect(db.exec('SELECT * FROM sales')[0]?.values).toEqual(before);
    expect(db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0]).toBe('ok');
  });

  it('applies exactly once through the real runner', () => {
    db.exec(`DROP TABLE ${TABLE};`);
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
    expect(columns()).toContain('printer_source');
  });
});
