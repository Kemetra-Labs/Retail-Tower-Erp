/**
 * RT-906 — migration-shape test for `0058_sale_discount_role_resolutions`
 * ([GATED], owner-authorized in Jira RT-905 comment 14049: one append-only
 * side table for the role resolved per held discount line, nothing else).
 *   • the number right after 0057, and only it;
 *   • one table and its two append-only triggers, nothing altered;
 *   • one row per (sale, placeholder); a closed role and source;
 *   • UPDATE and DELETE are refused; ON CONFLICT DO NOTHING keeps the first row;
 *   • applies on a database at 0057 that already holds data, re-applies safely;
 *   • the §A2 note and the rollback are present;
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

const MIGRATION = '0058_sale_discount_role_resolutions';
const TABLE = 'sale_discount_role_resolutions';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const APPROVAL_ID = '0190f5a2-3b4c-7d8e-9f01-000000000001';

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

function insert(
  over: Partial<
    Record<'sale' | 'placeholder' | 'approval' | 'role' | 'source' | 'at', string>
  > = {},
): void {
  db.run(
    `INSERT INTO ${TABLE} (sale_id, placeholder_id, approval_id, approver_role, source, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      over.sale ?? 'sale-1',
      over.placeholder ?? 'dp-1',
      over.approval ?? APPROVAL_ID,
      over.role ?? 'manager',
      over.source ?? 'pin_record_refresh',
      over.at ?? '2026-10-27T10:00:00.000Z',
    ],
  );
}

function rows(): unknown[][] {
  return db.exec(`SELECT * FROM ${TABLE} ORDER BY sale_id, placeholder_id`)[0]?.values ?? [];
}

describe('0058 — sale discount role resolutions (RT-906, [GATED])', () => {
  it('is the only migration numbered 0058, right after 0057', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0058_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe(
      '0057_terminal_printer_setting.sql',
    );
  });

  it('creates one table and its two triggers, and alters nothing', () => {
    const creates = SQL_TEXT.replace(/--.*$/gm, '').match(/^CREATE .*$/gm);
    expect(creates).toEqual([
      `CREATE TABLE IF NOT EXISTS ${TABLE} (`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_update`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_delete`,
    ]);
    expect(SQL_TEXT.replace(/--.*$/gm, '')).not.toMatch(
      /ALTER|DROP|UPDATE\s+\w+\s+SET|DELETE FROM/i,
    );
    expect(columns()).toEqual([
      'sale_id',
      'placeholder_id',
      'approval_id',
      'approver_role',
      'source',
      'resolved_at',
    ]);
  });

  it('carries the [GATED] authorization, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('RT-905');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${TABLE};`);
  });

  it('ships empty', () => {
    expect(rows()).toEqual([]);
  });

  it('keeps one row per sale and placeholder', () => {
    insert();
    insert({ placeholder: 'dp-2', role: 'admin' });
    insert({ sale: 'sale-2' });
    expect(() => {
      insert({ role: 'admin' });
    }).toThrow(/UNIQUE|PRIMARY/);
    expect(rows()).toHaveLength(3);
  });

  it('holds only a closed role, a closed source and well-formed ids', () => {
    for (const over of [
      { role: 'cashier' },
      { role: '' },
      { source: 'guess' },
      { source: 'approval_at_grant' },
      { approval: 'not-a-uuid' },
      { approval: APPROVAL_ID.toUpperCase() },
      { sale: '' },
      { placeholder: '' },
      { at: '' },
    ]) {
      expect(() => {
        insert(over);
      }, JSON.stringify(over)).toThrow(/CHECK/);
    }
    expect(rows()).toEqual([]);
  });

  it('refuses UPDATE and DELETE; a repeat insert keeps the first row', () => {
    insert();
    expect(() => {
      db.run(`UPDATE ${TABLE} SET approver_role = 'admin'`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`UPDATE ${TABLE} SET resolved_at = resolved_at`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`DELETE FROM ${TABLE}`);
    }).toThrow(/append-only/);
    db.run(
      `INSERT INTO ${TABLE} (sale_id, placeholder_id, approval_id, approver_role, source, resolved_at)
       VALUES ('sale-1', 'dp-1', ?, 'admin', 'pin_record_refresh', '2027-01-01T00:00:00.000Z')
       ON CONFLICT (sale_id, placeholder_id) DO NOTHING`,
      [APPROVAL_ID],
    );
    expect(rows()).toEqual([
      ['sale-1', 'dp-1', APPROVAL_ID, 'manager', 'pin_record_refresh', '2026-10-27T10:00:00.000Z'],
    ]);
  });

  it('applies to a database at 0057 that already holds data, and re-applies as a no-op', () => {
    db.exec(`DROP TABLE ${TABLE};`);
    seedSale(db, { sale_id: 'sale-1' });
    const before = db.exec('SELECT * FROM sales')[0]?.values;
    db.exec(SQL_TEXT);
    insert();
    db.exec(SQL_TEXT); // IF NOT EXISTS: the resolution survives
    expect(rows()).toHaveLength(1);
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
    expect(columns()).toContain('approver_role');
  });
});
