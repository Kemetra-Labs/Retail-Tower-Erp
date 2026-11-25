/**
 * RT-1607 — upgrade-path spec for `0068_return_refund_executions` (A9 review of RT-1543, Minor 2):
 * a till whose database is populated at 0067 and holds a PAID-OUT return must migrate through
 * 0068 to head with its return journal intact, and gain an EMPTY `return_refund_executions`.
 *
 * The 0068 shape test builds from an empty database, so it cannot see a migration that drops,
 * rewrites or loses pre-existing return data. This one applies the shipped files through 0067,
 * seeds the return, then runs the real runner (`runMigrations`) over the full shipped set.
 *   • step 1: the runner applies only 0068 (files below 0069): every row of every pre-existing
 *     return table is identical, whole-row, before and after;
 *   • step 2: the runner applies the rest to head: the 0067-era columns of those rows still hold
 *     the same values (later migrations may add columns, never change these).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

import {
  runMigrations,
  type AppliedRow,
  type MigrationFile,
  type MigrationsDb,
} from '../../db/migrate.js';
import { MIGRATIONS_DIR } from '../../db/__tests__/__helpers__/migrated-db.js';
import { seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';

const LAST_BEFORE = '0067_shift_variance_policy';
const TARGET = '0068_return_refund_executions';
const TABLE = 'return_refund_executions';

const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const RETURN_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000ff';
const LINE_REF = '0190f5a2-7b3c-7d4e-8f90-00000000000a';

/** Every pre-existing table that holds return data, with a stable order for whole-row reads. */
const RETURN_TABLES = [
  ['return_journal', 'return_id'],
  ['return_journal_lines', 'return_id, line_ref'],
  ['return_payouts', 'return_id'],
  ['sales', 'sale_id'],
] as const;

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function shippedFiles(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => ({
      name: n.replace(/\.sql$/, ''),
      sql: readFileSync(path.join(MIGRATIONS_DIR, n), 'utf8'),
    }));
}

function migrationsDbOf(sql: SqlJsDatabase): MigrationsDb {
  return {
    exec: (text) => {
      sql.exec(text);
    },
    listAppliedNames: () =>
      (sql.exec('SELECT name FROM schema_migrations')[0]?.values ?? []).map((r) => String(r[0])),
    recordApplied: (row: AppliedRow) => {
      sql.run('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)', [
        row.name,
        row.applied_at,
        row.checksum,
      ]);
    },
    transaction: (fn) => {
      sql.run('BEGIN');
      try {
        const out = fn();
        sql.run('COMMIT');
        return out;
      } catch (err) {
        sql.run('ROLLBACK');
        throw err;
      }
    },
  };
}

function rows(db: SqlJsDatabase, sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

function columnsOf(db: SqlJsDatabase, table: string): string[] {
  return rows(db, `PRAGMA table_info(${table})`).map((r) => String(r[1]));
}

/** A confirmed return `returnId`, optionally taken through its payout to `paid_out`. */
function seedReturn(db: SqlJsDatabase, returnId: string, paid: boolean, n: string): void {
  seedSale(db, { sale_id: `sale-${returnId}` });
  db.run(
    `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
       sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
       currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
     VALUES (?, 't', 'b', 'term', ?, 'SN-1', ?, ?, 'op', 'sess', 'EGP', 1500, '{"k":1}',
       'pending', 't0', 't0')`,
    [
      returnId,
      `sale-${returnId}`,
      SALE_REF,
      `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-0000000000${n}`,
    ],
  );
  db.run(`INSERT INTO return_journal_lines (return_id, line_ref, quantity) VALUES (?, ?, 1)`, [
    returnId,
    LINE_REF,
  ]);
  db.run(
    `UPDATE return_journal SET state = 'confirmed', return_ref = ?, return_total_minor = 1500,
       confirmed_at = 't1' WHERE return_id = ?`,
    [RETURN_REF.slice(0, -2) + n, returnId],
  );
  if (!paid) return;
  db.run(
    `INSERT INTO return_payouts (return_id, started_operator_id, started_session_id, started_at)
     VALUES (?, 'op-m', 'sess-m', 't2')`,
    [returnId],
  );
  db.run(
    `UPDATE return_payouts SET paid_operator_id = 'op-m', paid_operator_name = 'M',
       paid_session_id = 'sess-m', paid_at = 't3', method = 'manual' WHERE return_id = ?`,
    [returnId],
  );
  db.run(`UPDATE return_journal SET state = 'paid_out', paid_out_at = 't3' WHERE return_id = ?`, [
    returnId,
  ]);
}

describe('0068 — upgrade from a populated 0067 database (RT-1607)', () => {
  it('keeps the return journal intact through 0068 and head, and adds an empty outbox', () => {
    const files = shippedFiles();
    const names = files.map((f) => f.name);
    expect(names).toContain(LAST_BEFORE);
    expect(names).toContain(TARGET);
    const upTo0067 = files.filter((f) => f.name <= LAST_BEFORE);
    const through0068 = files.filter((f) => f.name <= TARGET);
    expect(upTo0067.some((f) => f.name === TARGET)).toBe(false);

    const raw = new SQL.Database();
    try {
      raw.exec('PRAGMA foreign_keys = ON;');
      const mdb = migrationsDbOf(raw);

      // A till at 0067: no outbox yet.
      runMigrations({ db: mdb, files: upTo0067 });
      expect(mdb.listAppliedNames()).not.toContain(TARGET);
      expect(columnsOf(raw, TABLE)).toEqual([]);

      seedReturn(raw, 'r-paid', true, '01');
      seedReturn(raw, 'r-open', false, '02');
      expect(rows(raw, `SELECT state FROM return_journal ORDER BY return_id`)).toEqual([
        ['confirmed'],
        ['paid_out'],
      ]);

      const baseline = new Map<string, unknown[][]>();
      const baselineCols = new Map<string, string[]>();
      for (const [table, order] of RETURN_TABLES) {
        baseline.set(table, rows(raw, `SELECT * FROM ${table} ORDER BY ${order}`));
        baselineCols.set(table, columnsOf(raw, table));
        expect(baseline.get(table)?.length).toBeGreaterThan(0);
      }

      // Step 1 — the real runner applies exactly 0068.
      runMigrations({ db: mdb, files: through0068 });
      expect(mdb.listAppliedNames()).toContain(TARGET);
      expect(rows(raw, `SELECT COUNT(*) FROM ${TABLE}`)).toEqual([[0]]);
      for (const [table, order] of RETURN_TABLES) {
        expect(columnsOf(raw, table)).toEqual(baselineCols.get(table));
        expect(rows(raw, `SELECT * FROM ${table} ORDER BY ${order}`)).toEqual(baseline.get(table));
      }

      // Step 2 — the real runner takes the till on to head.
      runMigrations({ db: mdb, files });
      expect(mdb.listAppliedNames().sort()).toEqual([...names].sort());
      expect(rows(raw, `SELECT COUNT(*) FROM ${TABLE}`)).toEqual([[0]]);
      for (const [table, order] of RETURN_TABLES) {
        const cols = (baselineCols.get(table) ?? []).join(', ');
        const before = (baseline.get(table) ?? []).map((r) => r.slice());
        expect(rows(raw, `SELECT ${cols} FROM ${table} ORDER BY ${order}`)).toEqual(before);
      }

      // The migrated paid-out return is usable by the new outbox trigger (and an open one is not).
      expect(() =>
        raw.run(
          `INSERT INTO ${TABLE} (execution_id, return_id, server_sale_ref, return_ref, allocation_ref,
             external_id, request_body_json, state, created_at, updated_at)
           VALUES (?, 'r-paid', ?, ?, ?, ?, '{}', 'pending', 't4', 't4')`,
          [
            '0190f5a2-7b3c-7d4e-8f90-0000000000e1',
            SALE_REF,
            RETURN_REF.slice(0, -2) + '01',
            '0190f5a2-7b3c-7d4e-8f90-0000000000a1',
            'pos-pulse-refund-exec:0190f5a2-7b3c-7d4e-8f90-0000000000e1',
          ],
        ),
      ).not.toThrow();
    } finally {
      raw.close();
    }
  });
});
