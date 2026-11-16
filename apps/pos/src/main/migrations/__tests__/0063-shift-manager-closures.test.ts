/**
 * RT-1442 — migration-shape and upgrade test for `0063_shift_manager_closures`
 * ([GATED: migration], owner approval on RT-1442 comment 17322):
 *   • the number right after 0062, and only it;
 *   • one additive table, no cash field, a closed fact kind; the table is
 *     append-only;
 *   • the only objects dropped are the two "shift is open" triggers, rebuilt
 *     with the manager-closure clause;
 *   • a manager-closed shift no longer blocks a new open and takes no movement;
 *   • UPGRADE from the 0062 schema (the 0043 triggers restored): an existing
 *     open shift still blocks a second open and takes movements, an existing
 *     closed shift still takes no movement, no existing row changes, and a
 *     re-apply is a no-op;
 *   • the [GATED] note and the rollback are present; the real runner applies
 *     it once.
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
  OTHER_TERMINAL,
  PAY_IN,
  S1,
  S2,
  SCOPE,
} from '../../shift-cashup/__tests__/__helpers__/shift-sync-fixture.js';

const MIGRATION = '0063_shift_manager_closures';
const TABLE = 'shift_manager_closures';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const SQL_0043 = readFileSync(path.join(MIGRATIONS_DIR, '0043_shift_cash_up.sql'), 'utf8');
const M2 = '0192f5a2-3b4c-7d8e-9f01-0000000000a2';
const AT = '2026-10-05T17:00:00.000Z';

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

function rows(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

/** The 0043 definition of a trigger, exactly as the 0062 schema has it. */
function trigger0043(name: string): string {
  const match = new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\b[\\s\\S]*?\\nEND;`).exec(
    SQL_0043,
  );
  if (match === null) throw new Error(`0043 has no trigger ${name}`);
  return match[0];
}

/** The database as it was at 0062: no table, the two triggers as 0043 made them. */
function downgradeTo0062(): void {
  db.exec(`
    DROP TABLE ${TABLE};
    DROP TRIGGER trg_shift_cashup_opens_one_open;
    DROP TRIGGER trg_shift_cashup_movements_shift_open;
    ${trigger0043('trg_shift_cashup_opens_one_open')}
    ${trigger0043('trg_shift_cashup_movements_shift_open')}
  `);
}

/**
 * Terminal 1: an OPEN shift with a pay-in. Terminal 2: a CLOSED shift. Written
 * through the repository BEFORE the downgrade: the table is empty then, so the
 * rows are exactly what the 0062-era code wrote.
 */
function seedExistingShifts(): void {
  const repo = createShiftCashupRepo(handleFor(db));
  repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
  repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
  repo.recordOpen({ scope: OTHER_TERMINAL, fact: { ...OPEN, shiftId: S2 }, now: NOW });
  repo.recordMovement({
    scope: OTHER_TERMINAL,
    fact: { ...PAY_IN, shiftId: S2, movementId: M2 },
    now: NOW,
  });
  repo.recordClose({ scope: OTHER_TERMINAL, fact: { ...CLOSE, shiftId: S2 }, now: NOW });
}

function insertOpen(shiftId: string, terminalId = SCOPE.terminalId): void {
  db.run(
    `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id,
       opening_user_id, currency_code, opening_float_minor, opened_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'EGP', 0, ?, ?)`,
    [shiftId, SCOPE.tenantId, SCOPE.branchId, terminalId, OPEN.openingUserId, AT, AT],
  );
}

function insertMovement(movementId: string, shiftId: string): void {
  db.run(
    `INSERT INTO shift_cashup_movements (movement_id, shift_id, kind, amount_minor, reason_code,
       occurred_at, operator_user_id, created_at)
     VALUES (?, ?, 'pay_in', 100, 'other', ?, ?, ?)`,
    [movementId, shiftId, AT, OPEN.openingUserId, AT],
  );
}

function managerClose(shiftId: string, kind = 'close'): void {
  db.run(`INSERT INTO ${TABLE} (shift_id, source_fact_kind, recorded_at) VALUES (?, ?, ?)`, [
    shiftId,
    kind,
    AT,
  ]);
}

describe('0063 — shift manager closures (RT-1442, [GATED: migration])', () => {
  it('is the only migration numbered 0063, right after 0062', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0063_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe('0062_sale_capture_cutover.sql');
  });

  it('adds one table with no cash field, and drops only the two open-shift triggers', () => {
    const code = SQL_TEXT.replace(/--.*$/gm, '');
    expect(code.match(/^CREATE TABLE .*$/gm)).toEqual([`CREATE TABLE IF NOT EXISTS ${TABLE} (`]);
    expect(code.match(/^DROP .*$/gm)).toEqual([
      'DROP TRIGGER IF EXISTS trg_shift_cashup_opens_one_open;',
      'DROP TRIGGER IF EXISTS trg_shift_cashup_movements_shift_open;',
    ]);
    expect(code).not.toMatch(/ALTER|UPDATE\s+\w+\s+SET|DELETE FROM|^INSERT\s+INTO/im);
    expect(columns(TABLE)).toEqual(['shift_id', 'source_fact_kind', 'recorded_at']);
    expect(columns(TABLE).join(' ')).not.toMatch(/counted|expected|variance|amount/);
  });

  it('carries the [GATED] approval note and the manual rollback', () => {
    expect(SQL_TEXT).toContain('[GATED: migration]');
    expect(SQL_TEXT).toContain('RT-1442 comment 17322');
    expect(SQL_TEXT).toMatch(/Rollback/);
  });

  it('is append-only and takes only the known fact kinds', () => {
    insertOpen(S1);
    managerClose(S1, 'open');
    expect(() => {
      db.run(`UPDATE ${TABLE} SET source_fact_kind = 'close'`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`DELETE FROM ${TABLE}`);
    }).toThrow(/append-only/);
    expect(() => {
      managerClose(S2, 'repair');
    }).toThrow();
    expect(rows(`SELECT shift_id, source_fact_kind FROM ${TABLE}`)).toEqual([[S1, 'open']]);
  });

  it('names a shift of this database only, once', () => {
    expect(() => {
      managerClose(S1);
    }).toThrow(/FOREIGN KEY/i);
    insertOpen(S1);
    managerClose(S1);
    expect(() => {
      managerClose(S1);
    }).toThrow(/UNIQUE|PRIMARY/i);
  });
});

describe('0063 — what a manager closure changes', () => {
  it('lets the terminal open a new shift, and takes no movement on the closed one', () => {
    insertOpen(S1);
    expect(() => {
      insertOpen(S2);
    }).toThrow(/already has an open shift/);
    managerClose(S1);
    insertOpen(S2);
    expect(rows('SELECT shift_id FROM shift_cashup_opens ORDER BY rowid')).toEqual([[S1], [S2]]);
    expect(() => {
      insertMovement(M2, S1);
    }).toThrow(/the shift is closed/);
    insertMovement(M2, S2);
  });

  it('still allows one open shift per terminal after a manager closure', () => {
    insertOpen(S1);
    managerClose(S1);
    insertOpen(S2);
    expect(() => {
      insertOpen('0192f5a2-3b4c-7d8e-9f01-000000000003');
    }).toThrow(/already has an open shift/);
  });

  it('is per shift: another terminal keeps its own open shift', () => {
    insertOpen(S1);
    insertOpen(S2, OTHER_TERMINAL.terminalId);
    managerClose(S1);
    expect(() => {
      insertOpen('0192f5a2-3b4c-7d8e-9f01-000000000003', OTHER_TERMINAL.terminalId);
    }).toThrow(/already has an open shift/);
  });
});

describe('0063 — upgrade from the 0062 schema', () => {
  it('starts from the 0043 triggers (the downgrade is faithful)', () => {
    seedExistingShifts();
    downgradeTo0062();
    expect(() => {
      insertOpen('0192f5a2-3b4c-7d8e-9f01-000000000003');
    }).toThrow(/already has an open shift/);
    expect(() => {
      insertMovement('0192f5a2-3b4c-7d8e-9f01-0000000000a3', S2);
    }).toThrow(/the shift is closed/);
    expect(rows("SELECT name FROM sqlite_master WHERE name = 'shift_manager_closures'")).toEqual(
      [],
    );
  });

  it('leaves an existing open shift and an existing closed shift as they were', () => {
    seedExistingShifts();
    downgradeTo0062();
    const tables = ['shift_cashup_opens', 'shift_cashup_movements', 'shift_cashup_closes'];
    const snapshot = (): unknown[][][] => tables.map((t) => rows(`SELECT * FROM ${t} ORDER BY 1`));
    const outbox = (): unknown[][] =>
      rows('SELECT seq, fact_kind, shift_id FROM shift_sync_outbox ORDER BY seq');
    const state = (): unknown[][] =>
      rows('SELECT seq, sync_status, attempt_count FROM shift_sync_state ORDER BY seq');
    const before = { tables: snapshot(), outbox: outbox(), state: state() };

    db.exec(SQL_TEXT);

    expect(snapshot()).toEqual(before.tables);
    expect(outbox()).toEqual(before.outbox);
    expect(state()).toEqual(before.state);
    expect(rows(`SELECT * FROM ${TABLE}`)).toEqual([]);
    expect(db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0]).toBe('ok');
    expect(db.exec('PRAGMA foreign_key_check')).toEqual([]);

    // The existing open shift is still the terminal's open shift, still blocks a
    // second open and still takes a movement; the closed shift still takes none.
    const repo = createShiftCashupRepo(handleFor(db));
    expect(repo.findOpenShift(SCOPE)?.shiftId).toBe(S1);
    expect(repo.findOpenShift(OTHER_TERMINAL)).toBeNull();
    expect(() => {
      insertOpen('0192f5a2-3b4c-7d8e-9f01-000000000003');
    }).toThrow(/already has an open shift/);
    insertMovement('0192f5a2-3b4c-7d8e-9f01-0000000000a3', S1);
    expect(() => {
      insertMovement('0192f5a2-3b4c-7d8e-9f01-0000000000a4', S2);
    }).toThrow(/the shift is closed/);
    expect(repo.latestShiftManagerClosed(SCOPE)).toBe(false);
  });

  it('re-applies as a no-op: a recorded closure survives', () => {
    seedExistingShifts();
    downgradeTo0062();
    db.exec(SQL_TEXT);
    managerClose(S1);
    db.exec(SQL_TEXT);
    expect(rows(`SELECT shift_id FROM ${TABLE}`)).toEqual([[S1]]);
    insertOpen('0192f5a2-3b4c-7d8e-9f01-000000000003');
  });

  it('applies exactly once through the real runner', () => {
    downgradeTo0062();
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
    expect(columns(TABLE)).toContain('source_fact_kind');
  });
});
