/**
 * RT-1403 S2 — migration-shape test for `0069_sale_void_payouts` ([GATED: migration], owner decision
 * RT-1403 comment 18143, 2026-11-21): the append-only local record of the cash a sale void paid out.
 *   • the number is unique and sorts after 0068;
 *   • one table and five triggers, nothing altered or dropped, nothing inserted;
 *   • one record per void AND per sale (the cash of a sale leaves the drawer once);
 *   • a `payout` needs a CONFIRMED void, an open shift that was already open when the void was
 *     requested, and the void's business day; `pending`, `unknown` and `refused` give no payout;
 *   • an `exception` needs an open shift, a single-use approval and an approver other than the
 *     requester, and carries its mismatch flag;
 *   • a record is immutable and is never deleted;
 *   • an older build refuses a database that holds 0069 (RT-320);
 *   • the §A2 note and the rollback are present.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  SchemaAheadError,
  runMigrations,
  type AppliedRow,
  type MigrationFile,
  type MigrationsDb,
} from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleVoidRepository } from '../../sale-void/sale-void-repository.js';
import {
  APPROVAL_B,
  APPROVER_USER,
  REQUESTER_USER,
  newVoidEntry,
} from '../../sale-void/__tests__/__helpers__/sale-void-fixture.js';
import { MIGRATIONS_DIR } from '../../db/__tests__/__helpers__/migrated-db.js';

const MIGRATION = '0069_sale_void_payouts';
const TABLE = 'sale_void_payouts';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const SHIFT_A = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const SHIFT_B = '0192f5a2-3b4c-7d8e-9f01-0000000000a2';
const PAYOUT_1 = '0192f5a2-3b4c-7d8e-9f01-0000000000b1';
const PAYOUT_2 = '0192f5a2-3b4c-7d8e-9f01-0000000000b2';
const OPENER = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';

/** Before the fixture void's `requested_at` (2026-06-07T10:06:01Z) and its `paid_at`. */
const OPENED_BEFORE_VOID = '2026-06-07T08:00:00.000Z';
const OPENED_AFTER_VOID = '2026-06-07T12:00:00.000Z';
const PAID_AT = '2026-06-07T13:00:00.000Z';

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

function count(): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${TABLE}`)[0]?.values[0]?.[0]);
}

function openShift(shiftId = SHIFT_A, openedAt = OPENED_BEFORE_VOID): void {
  db.run(
    `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id, opening_user_id,
       currency_code, opening_float_minor, opened_at, created_at)
     VALUES (?, 'tenant-1', 'branch-1', 'term-1', ?, 'EGP', 0, ?, ?)`,
    [shiftId, OPENER, openedAt, openedAt],
  );
}

/** Void `v1` of `sale-1` (cash 1500, business day 2026-06-07), journaled and moved to `state`. */
function journalVoid(state: 'pending' | 'unknown' | 'confirmed' | 'refused'): void {
  seedSale(db);
  const repo = createSaleVoidRepository(handleFor(db));
  repo.insert(newVoidEntry(1));
  const stamp = { voidId: 'v1', now: '2026-06-07T10:07:00.000Z' };
  if (state === 'confirmed') {
    repo.markConfirmed({ ...stamp, voidRef: '0190f5a2-7b3c-7d4e-8f90-0000000000d1' });
  } else if (state === 'refused') {
    repo.markRefused({ ...stamp, reason: 'void_self_approval' });
  } else if (state === 'unknown') {
    repo.markUnknown({ ...stamp, category: 'timeout' });
  }
}

type Over = Partial<Record<string, string | number | null>>;

function insert(over: Over = {}): void {
  const row: Record<string, string | number | null> = {
    payout_id: PAYOUT_1,
    void_id: 'v1',
    sale_id: 'sale-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-1',
    shift_id: SHIFT_A,
    business_date: '2026-06-07',
    kind: 'payout',
    method: 'drawer',
    amount_minor: 1500,
    currency_code: 'EGP',
    void_state: 'confirmed',
    paid_at: PAID_AT,
    paid_by_operator_id: 'op-cashier',
    paid_by_display_name: 'Cara Cashier',
    paid_by_session_id: 'sess-2',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${TABLE} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] ?? null),
  );
}

const EXCEPTION: Over = {
  kind: 'exception',
  method: 'manual',
  exception_approval_id: APPROVAL_B,
  exception_approver_user_id: APPROVER_USER,
  exception_requester_user_id: REQUESTER_USER,
  exception_policy_version: 'rt114-2026-10-07',
};

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

function shippedFiles(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => ({
      name: n.replace(/\.sql$/, ''),
      sql: readFileSync(path.join(MIGRATIONS_DIR, n), 'utf8'),
    }));
}

describe('0069 — sale void payouts (RT-1403 S2)', () => {
  it('is the only migration numbered 0069 and sorts after 0068', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0069_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted.indexOf(`${MIGRATION}.sql`)).toBeGreaterThan(
      sorted.indexOf('0068_return_refund_executions.sql'),
    );
  });

  it('creates one table and five triggers, and alters nothing', () => {
    const creates = SQL_TEXT.replace(/--.*$/gm, '').match(/^CREATE .*$/gm);
    expect(creates).toEqual([
      `CREATE TABLE IF NOT EXISTS ${TABLE} (`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_void_match`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_open_shift`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_payout_window`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_update`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_delete`,
    ]);
    expect(SQL_TEXT.replace(/--.*$/gm, '')).not.toMatch(
      /ALTER\s|DROP\s|UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO/i,
    );
    expect(columns()).toEqual([
      'payout_id',
      'void_id',
      'sale_id',
      'tenant_id',
      'branch_id',
      'terminal_id',
      'shift_id',
      'business_date',
      'kind',
      'method',
      'amount_minor',
      'currency_code',
      'void_state',
      'mismatch_reason',
      'paid_at',
      'paid_by_operator_id',
      'paid_by_display_name',
      'paid_by_session_id',
      'exception_approval_id',
      'exception_approver_user_id',
      'exception_requester_user_id',
      'exception_policy_version',
    ]);
  });

  it('carries the [GATED] authorization, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('RT-1403');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${TABLE};`);
  });

  it('ships empty', () => {
    expect(count()).toBe(0);
  });

  describe('a payout is the cash of a CONFIRMED void, in an open shift, on its business day', () => {
    it('accepts the payout of a confirmed void in a shift open before the void was requested', () => {
      journalVoid('confirmed');
      openShift();
      insert();
      expect(count()).toBe(1);
    });

    it.each(['pending', 'unknown', 'refused'] as const)(
      'refuses a payout for a void that is %s',
      (state) => {
        journalVoid(state);
        openShift();
        expect(() => {
          insert({ void_state: state });
        }).toThrow(/CHECK|payout window/);
        expect(() => {
          insert(); // claims `confirmed`, but the journal says otherwise
        }).toThrow(/void/);
        expect(count()).toBe(0);
      },
    );

    it('refuses a payout for a void that does not exist, or whose facts differ', () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insert({ void_id: 'ghost' });
      }).toThrow(/void/);
      expect(() => {
        insert({ amount_minor: 1400 });
      }).toThrow(/void/);
      expect(() => {
        insert({ currency_code: 'USD' });
      }).toThrow(/void/);
      expect(() => {
        insert({ terminal_id: 'term-2' });
      }).toThrow(/void/);
      expect(() => {
        insert({ sale_id: 'sale-2' });
      }).toThrow(/void|FOREIGN/);
    });

    it('refuses a payout with no open shift', () => {
      journalVoid('confirmed');
      expect(() => {
        insert();
      }).toThrow(/open shift/);
    });

    it('refuses a payout into a shift that is closed or closed by a manager', () => {
      journalVoid('confirmed');
      openShift();
      db.run(
        `INSERT INTO shift_manager_closures (shift_id, source_fact_kind, recorded_at)
         VALUES (?, 'close', ?)`,
        [SHIFT_A, PAID_AT],
      );
      expect(() => {
        insert();
      }).toThrow(/open shift/);
    });

    it('refuses a payout into a shift opened after the void was requested (not the same shift)', () => {
      journalVoid('confirmed');
      openShift(SHIFT_A, OPENED_AFTER_VOID);
      expect(() => {
        insert();
      }).toThrow(/same shift|window/);
    });

    it("refuses a payout on another business day than the void's", () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insert({ business_date: '2026-06-08' });
      }).toThrow(/window/);
    });

    it('refuses a payout into another shift than the terminal open one', () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insert({ shift_id: SHIFT_B });
      }).toThrow(/open shift|FOREIGN/);
    });

    it('holds one record per void and one per sale', () => {
      journalVoid('confirmed');
      openShift();
      insert();
      expect(() => {
        insert({ payout_id: PAYOUT_2 });
      }).toThrow(/UNIQUE/);
      expect(count()).toBe(1);
    });

    it('holds one record per sale even across a later void of the same sale', () => {
      journalVoid('refused');
      openShift();
      insert({
        ...EXCEPTION,
        void_state: 'refused',
        mismatch_reason: 'void_refused',
      });
      // A refused void frees the sale for a new request; its cash has already left once.
      const repo = createSaleVoidRepository(handleFor(db));
      repo.insert(
        newVoidEntry(2, {
          approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a9',
          now: '2026-06-07T10:20:00.000Z',
        }),
      );
      repo.markConfirmed({
        voidId: 'v2',
        voidRef: '0190f5a2-7b3c-7d4e-8f90-0000000000d2',
        now: '2026-06-07T10:21:00.000Z',
      });
      expect(() => {
        insert({ payout_id: PAYOUT_2, void_id: 'v2' });
      }).toThrow(/UNIQUE/);
    });

    it('checks the shape of the identities and the method', () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insert({ payout_id: 'not-a-uuid' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ method: 'manual' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ kind: 'refund' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ amount_minor: -1 });
      }).toThrow(/CHECK|void must exist/);
      expect(() => {
        insert({ business_date: '07/06/2026' });
      }).toThrow(/CHECK|payout window/);
    });

    it('accepts the no-drawer method', () => {
      journalVoid('confirmed');
      openShift();
      insert({ method: 'no_drawer' });
      expect(count()).toBe(1);
    });

    it('a payout carries no exception evidence and no mismatch flag', () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insert({ exception_approval_id: APPROVAL_B });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ mismatch_reason: 'payout_window_closed' });
      }).toThrow(/CHECK/);
    });
  });

  describe('a cash exception is manager-attested, single-use and flagged', () => {
    it.each([
      ['refused', 'void_refused'],
      ['unknown', 'void_unconfirmed'],
      ['pending', 'void_unconfirmed'],
    ] as const)('accepts an exception for a %s void with the %s flag', (state, flag) => {
      journalVoid(state);
      openShift();
      insert({ ...EXCEPTION, void_state: state, mismatch_reason: flag });
      expect(count()).toBe(1);
    });

    it('refuses an exception for a void that is not accepted without its mismatch flag', () => {
      journalVoid('refused');
      openShift();
      expect(() => {
        insert({ ...EXCEPTION, void_state: 'refused' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_unconfirmed' });
      }).toThrow(/CHECK/);
    });

    it('accepts an exception for a confirmed void outside its payout window, flagged', () => {
      journalVoid('confirmed');
      openShift(SHIFT_A, OPENED_AFTER_VOID);
      insert({
        ...EXCEPTION,
        void_state: 'confirmed',
        mismatch_reason: 'payout_window_closed',
        business_date: '2026-06-08',
      });
      expect(count()).toBe(1);
    });

    it('accepts an unflagged exception for a confirmed void (a payout attested by hand)', () => {
      journalVoid('confirmed');
      openShift();
      insert({ ...EXCEPTION, void_state: 'confirmed' });
      expect(count()).toBe(1);
    });

    it('needs an open shift: a closed shift is never changed', () => {
      journalVoid('refused');
      expect(() => {
        insert({ ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_refused' });
      }).toThrow(/open shift/);
    });

    it('needs the whole approval evidence, and the method manual', () => {
      journalVoid('refused');
      openShift();
      const base = { ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_refused' };
      for (const key of [
        'exception_approval_id',
        'exception_approver_user_id',
        'exception_requester_user_id',
        'exception_policy_version',
      ]) {
        expect(() => {
          insert({ ...base, [key]: null });
        }).toThrow(/CHECK/);
      }
      expect(() => {
        insert({ ...base, method: 'drawer' });
      }).toThrow(/CHECK/);
    });

    it('refuses an approver who is the requester (four-eyes)', () => {
      journalVoid('refused');
      openShift();
      expect(() => {
        insert({
          ...EXCEPTION,
          void_state: 'refused',
          mismatch_reason: 'void_refused',
          exception_approver_user_id: REQUESTER_USER.toUpperCase(),
        });
      }).toThrow(/CHECK/);
    });

    it('spends an approval once', () => {
      journalVoid('refused');
      openShift();
      insert({ ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_refused' });
      const repo = createSaleVoidRepository(handleFor(db));
      seedSale(db, { sale_id: 'sale-2' });
      repo.insert(
        newVoidEntry(3, {
          saleId: 'sale-2',
          saleNumber: 'SN-sale-2',
          approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a3',
          now: '2026-06-07T10:30:00.000Z',
        }),
      );
      repo.markRefused({
        voidId: 'v3',
        reason: 'void_self_approval',
        now: '2026-06-07T10:31:00.000Z',
      });
      expect(() => {
        insert({
          ...EXCEPTION,
          payout_id: PAYOUT_2,
          void_id: 'v3',
          sale_id: 'sale-2',
          void_state: 'refused',
          mismatch_reason: 'void_refused',
        });
      }).toThrow(/UNIQUE/);
    });
  });

  describe('a record is immutable and never deleted', () => {
    beforeEach(() => {
      journalVoid('confirmed');
      openShift();
      insert();
    });

    it.each([
      `amount_minor = 1`,
      `paid_at = 'tX'`,
      `shift_id = '${SHIFT_B}'`,
      `mismatch_reason = 'void_refused'`,
      `paid_by_operator_id = 'someone-else'`,
    ])('refuses any update (%s)', (set) => {
      expect(() => {
        db.run(`UPDATE ${TABLE} SET ${set}`);
      }).toThrow(/immutable/);
    });

    it('never deletes', () => {
      expect(() => {
        db.run(`DELETE FROM ${TABLE}`);
      }).toThrow(/append-only/);
      expect(count()).toBe(1);
    });
  });

  it('the real runner applies it once; an older build (without 0069) then refuses the database (RT-320)', async () => {
    const SQL = (await import('sql.js')).default;
    const engine = await SQL();
    const raw = new engine.Database();
    try {
      const mdb = migrationsDbOf(raw);
      const files = shippedFiles();
      runMigrations({ db: mdb, files });
      expect(mdb.listAppliedNames()).toContain(MIGRATION);
      runMigrations({ db: mdb, files });
      expect(mdb.listAppliedNames().filter((n) => n === MIGRATION)).toHaveLength(1);

      const olderBuild = files.filter((f) => f.name !== MIGRATION);
      let caught: unknown;
      try {
        runMigrations({ db: mdb, files: olderBuild });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SchemaAheadError);
      expect((caught as SchemaAheadError).unknownMigrations).toEqual([MIGRATION]);
    } finally {
      raw.close();
    }
  });
});
