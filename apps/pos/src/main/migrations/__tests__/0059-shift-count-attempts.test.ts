/**
 * RT-997 — migration-shape test for `0059_shift_count_attempts` ([GATED]: the
 * owner has not approved it yet; the decision it serves is RT-276 comment
 * 14719, Count Attempt history before the pilot):
 *   • the number right after 0058, and only it;
 *   • two additive tables, nothing existing altered, a closed outcome;
 *   • an attempt cannot be updated or deleted (append-only triggers), nor can
 *     the close's link;
 *   • a recount is a new row; at most one accepted attempt per shift;
 *   • no attempt on a closed shift; the link names the shift's own accepted
 *     attempt with the close's counted cash;
 *   • applies on a database at 0058 that already holds a shift, re-applies safely;
 *   • the [GATED] note, the §A2 note and the rollback are present;
 *   • the real runner applies it once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { createShiftCashupRepo } from '../../shift-cashup/shift-cashup-repo.js';
import {
  CLOSE,
  NOW,
  OPEN,
  PAY_IN,
  S1,
  SCOPE,
  USER,
} from '../../shift-cashup/__tests__/__helpers__/shift-sync-fixture.js';

const MIGRATION = '0059_shift_count_attempts';
const ATTEMPTS = 'shift_count_attempts';
const LINKS = 'shift_close_count_attempts';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const A1 = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';
const A2 = '0192f5a2-3b4c-7d8e-9f01-0000000000c2';
const AT = '2026-10-05T15:00:00.000Z';

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

/** The open and the pay-in `CLOSE` carries the total of. */
function openShift(): void {
  const repo = createShiftCashupRepo(handleFor(db));
  repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
  repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
}

function closeShift(): void {
  createShiftCashupRepo(handleFor(db)).recordClose({ scope: SCOPE, fact: CLOSE, now: NOW });
}

function attempt(
  over: Partial<
    Record<'id' | 'shift' | 'actor' | 'counted' | 'outcome' | 'at', string | number>
  > = {},
): void {
  db.run(
    `INSERT INTO ${ATTEMPTS} (attempt_id, shift_id, actor_user_id, counted_cash_minor, outcome,
       attempted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      over.id ?? A1,
      over.shift ?? S1,
      over.actor ?? USER,
      over.counted ?? CLOSE.countedCashMinor,
      over.outcome ?? 'refused',
      over.at ?? AT,
      NOW,
    ],
  );
}

function link(attemptId = A1): void {
  db.run(`INSERT INTO ${LINKS} (shift_id, attempt_id, created_at) VALUES (?, ?, ?)`, [
    S1,
    attemptId,
    NOW,
  ]);
}

function rows(table: string): unknown[][] {
  return db.exec(`SELECT * FROM ${table}`)[0]?.values ?? [];
}

describe('0059 — shift count attempts (RT-997, [GATED] awaiting owner approval)', () => {
  it('is the only migration numbered 0059, right after 0058', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0059_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe(
      '0058_sale_discount_role_resolutions.sql',
    );
  });

  it('creates two tables and alters nothing that exists', () => {
    const code = SQL_TEXT.replace(/--.*$/gm, '');
    expect(code.match(/^CREATE TABLE .*$/gm)).toEqual([
      `CREATE TABLE IF NOT EXISTS ${ATTEMPTS} (`,
      `CREATE TABLE IF NOT EXISTS ${LINKS} (`,
    ]);
    expect(code).not.toMatch(/ALTER|DROP|UPDATE\s+\w+\s+SET|DELETE FROM/i);
    expect(columns(ATTEMPTS)).toEqual([
      'attempt_id',
      'shift_id',
      'actor_user_id',
      'counted_cash_minor',
      'outcome',
      'attempted_at',
      'created_at',
    ]);
    expect(columns(LINKS)).toEqual(['shift_id', 'attempt_id', 'created_at']);
  });

  it('stores no expected cash and no variance (the count stays blind)', () => {
    expect(columns(ATTEMPTS).join(' ')).not.toMatch(/expected|variance/);
    expect(columns(LINKS).join(' ')).not.toMatch(/expected|variance/);
  });

  it('carries the [GATED] note, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('NOT YET GRANTED');
    expect(SQL_TEXT).toContain('RT-276 comment 14719');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${ATTEMPTS};`);
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${LINKS};`);
  });

  it('ships empty', () => {
    expect(rows(ATTEMPTS)).toEqual([]);
    expect(rows(LINKS)).toEqual([]);
  });

  it('keeps every attempt: a recount is a new row, never an edit', () => {
    openShift();
    attempt({ id: A1, outcome: 'refused', counted: 60_000 });
    attempt({ id: A2, outcome: 'refused', counted: 61_000 });
    expect(rows(ATTEMPTS)).toHaveLength(2);
  });

  it('holds only a closed outcome, a non-negative integer count and well-formed ids', () => {
    openShift();
    for (const over of [
      { outcome: 'approved' },
      { outcome: '' },
      { counted: -1 },
      { counted: 1.5 },
      { id: 'not-a-uuid' },
      { id: A1.toUpperCase() },
      { actor: 'not-a-uuid' },
      { at: '' },
    ]) {
      expect(() => {
        attempt(over);
      }, JSON.stringify(over)).toThrow(/CHECK/);
    }
    expect(rows(ATTEMPTS)).toEqual([]);
  });

  it('names a shift that exists', () => {
    expect(() => {
      attempt();
    }).toThrow(/FOREIGN KEY/);
  });

  it('refuses UPDATE and DELETE of an attempt, whatever the column', () => {
    openShift();
    attempt();
    for (const sql of [
      `UPDATE ${ATTEMPTS} SET outcome = 'accepted'`,
      `UPDATE ${ATTEMPTS} SET counted_cash_minor = 0`,
      `UPDATE ${ATTEMPTS} SET attempted_at = attempted_at`,
      `DELETE FROM ${ATTEMPTS}`,
    ]) {
      expect(() => {
        db.run(sql);
      }, sql).toThrow(/append-only/);
    }
    expect(rows(ATTEMPTS)).toHaveLength(1);
  });

  it('allows one accepted attempt per shift', () => {
    openShift();
    attempt({ id: A1, outcome: 'accepted' });
    expect(() => {
      attempt({ id: A2, outcome: 'accepted' });
    }).toThrow(/UNIQUE/);
    attempt({ id: A2, outcome: 'refused' });
    expect(rows(ATTEMPTS)).toHaveLength(2);
  });

  it('refuses an attempt on a closed shift', () => {
    openShift();
    closeShift();
    expect(() => {
      attempt();
    }).toThrow(/shift is closed/);
  });

  it('links a close to the accepted attempt that carries its counted cash', () => {
    openShift();
    attempt({ id: A1, outcome: 'accepted', counted: CLOSE.countedCashMinor });
    closeShift();
    link(A1);
    expect(rows(LINKS)).toEqual([[S1, A1, NOW]]);
  });

  it('refuses a link to a refused attempt, or to one with another count', () => {
    openShift();
    attempt({ id: A1, outcome: 'refused' });
    attempt({ id: A2, outcome: 'accepted', counted: CLOSE.countedCashMinor + 1 });
    closeShift();
    for (const id of [A1, A2]) {
      expect(() => {
        link(id);
      }, id).toThrow(/rests on its own accepted attempt/);
    }
    expect(rows(LINKS)).toEqual([]);
  });

  it('refuses UPDATE and DELETE of a link', () => {
    openShift();
    attempt({ id: A1, outcome: 'accepted' });
    closeShift();
    link(A1);
    expect(() => {
      db.run(`UPDATE ${LINKS} SET created_at = created_at`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`DELETE FROM ${LINKS}`);
    }).toThrow(/append-only/);
    expect(rows(LINKS)).toHaveLength(1);
  });

  it('applies to a database at 0058 that already holds a shift, and re-applies as a no-op', () => {
    db.exec(`DROP TABLE ${LINKS}; DROP TABLE ${ATTEMPTS};`);
    openShift();
    const before = db.exec('SELECT * FROM shift_cashup_opens')[0]?.values;
    db.exec(SQL_TEXT);
    attempt();
    db.exec(SQL_TEXT); // IF NOT EXISTS: the attempt survives a second apply
    expect(rows(ATTEMPTS)).toHaveLength(1);
    expect(db.exec('SELECT * FROM shift_cashup_opens')[0]?.values).toEqual(before);
    expect(db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0]).toBe('ok');
  });

  it('applies exactly once through the real runner', () => {
    db.exec(`DROP TABLE ${LINKS}; DROP TABLE ${ATTEMPTS};`);
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
    expect(columns(ATTEMPTS)).toContain('outcome');
  });
});
