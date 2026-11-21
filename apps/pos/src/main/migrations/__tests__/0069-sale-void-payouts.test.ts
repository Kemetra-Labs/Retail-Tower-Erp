/**
 * RT-1403 S2 — migration-shape test for `0069_sale_void_payouts` ([GATED: migration], owner decision
 * RT-1403 comment 18143, 2026-11-21; the claim: orchestrator decision H1, comment 18153): the claim
 * and the append-only local record of the cash a sale void paid out.
 *   • the number is unique and sorts after 0068;
 *   • two tables and their triggers, nothing altered or dropped, nothing inserted;
 *   • a claim exists before any payout record, only for a confirmed void in an open shift on its day,
 *     and its drawer kick moves forward only (the RT-15 machine);
 *   • a `payout` completes its claim, in the same shift, with a settled drawer; `pending`, `unknown`
 *     and `refused` give no payout; one record per void AND per sale;
 *   • an `exception` needs an open shift, a spent approval of its kind that covers this void and
 *     approver, an approver other than the requester, and carries its mismatch flag;
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
import { seedApproval } from '../../sale-void/__tests__/__helpers__/sale-void-payout-fixture.js';
import { MIGRATIONS_DIR } from '../../db/__tests__/__helpers__/migrated-db.js';

const MIGRATION = '0069_sale_void_payouts';
const TABLE = 'sale_void_payouts';
const CLAIMS = 'sale_void_payout_claims';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const SHIFT_A = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const SHIFT_B = '0192f5a2-3b4c-7d8e-9f01-0000000000a2';
const PAYOUT_1 = '0192f5a2-3b4c-7d8e-9f01-0000000000b1';
const PAYOUT_2 = '0192f5a2-3b4c-7d8e-9f01-0000000000b2';
const OPENER = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';

/** Before the fixture void's `requested_at` (2026-06-07T10:06:01Z) and its `paid_at`. */
const OPENED_BEFORE_VOID = '2026-06-07T08:00:00.000Z';
const OPENED_AFTER_VOID = '2026-06-07T12:00:00.000Z';
const CLAIMED_AT = '2026-06-07T12:58:00.000Z';
const KICKED_AT = '2026-06-07T12:58:30.000Z';
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

function columns(table: string): string[] {
  return (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((r) => String(r[1]));
}

function count(table = TABLE): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0]);
}

function openShift(shiftId = SHIFT_A, openedAt = OPENED_BEFORE_VOID): void {
  db.run(
    `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id, opening_user_id,
       currency_code, opening_float_minor, opened_at, created_at)
     VALUES (?, 'tenant-1', 'branch-1', 'term-1', ?, 'EGP', 0, ?, ?)`,
    [shiftId, OPENER, openedAt, openedAt],
  );
}

type VoidState = 'pending' | 'unknown' | 'confirmed' | 'refused';

/** Void `v<n>` of `sale-<n>` (cash 1500, business day 2026-06-07), journaled and moved to `state`. */
function journalVoid(state: VoidState, n = 1): void {
  seedSale(db, { sale_id: `sale-${String(n)}` });
  const repo = createSaleVoidRepository(handleFor(db));
  repo.insert(
    newVoidEntry(n, {
      saleId: `sale-${String(n)}`,
      saleNumber: `SN-sale-${String(n)}`,
      approvalId: `0190f5a2-7b3c-7d4e-8f90-0000000000a${String(n)}`,
    }),
  );
  const stamp = { voidId: `v${String(n)}`, now: '2026-06-07T10:07:00.000Z' };
  if (state === 'confirmed') {
    repo.markConfirmed({ ...stamp, voidRef: '0190f5a2-7b3c-7d4e-8f90-0000000000d1' });
  } else if (state === 'refused') {
    repo.markRefused({ ...stamp, reason: 'void_self_approval' });
  } else if (state === 'unknown') {
    repo.markUnknown({ ...stamp, category: 'timeout' });
  }
}

type Over = Partial<Record<string, string | number | null>>;

function insertInto(table: string, row: Record<string, string | number | null>): void {
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] ?? null),
  );
}

function insertClaim(over: Over = {}): void {
  insertInto(CLAIMS, {
    void_id: 'v1',
    sale_id: 'sale-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-1',
    shift_id: SHIFT_A,
    business_date: '2026-06-07',
    claimed_by_operator_id: 'op-manager',
    claimed_by_display_name: 'Mona Manager',
    claimed_by_session_id: 'sess-2',
    claimed_at: CLAIMED_AT,
    ...over,
  });
}

type Kick = 'opened' | 'failed_before_send' | 'unknown' | 'sending' | null;

/** A claim of `v1`, its kick marked sending and resolved to `kick` (null: never kicked). */
function claim(kick: Kick = 'opened', over: Over = {}): void {
  insertClaim(over);
  if (kick === null) return;
  db.run(
    `UPDATE ${CLAIMS} SET kick_outcome = 'sending', kick_count = 1, kicked_at = ? WHERE void_id = 'v1'`,
    [KICKED_AT],
  );
  if (kick !== 'sending') {
    db.run(`UPDATE ${CLAIMS} SET kick_outcome = ? WHERE void_id = 'v1'`, [kick]);
  }
}

function insert(over: Over = {}): void {
  insertInto(TABLE, {
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
    paid_by_operator_id: 'op-manager',
    paid_by_display_name: 'Mona Manager',
    paid_by_session_id: 'sess-2',
    ...over,
  });
}

const EXCEPTION: Over = {
  kind: 'exception',
  method: 'manual',
  exception_approval_id: APPROVAL_B,
  exception_approver_user_id: APPROVER_USER,
  exception_requester_user_id: REQUESTER_USER,
  exception_policy_version: 'rt114-2026-10-07',
};

/** An exception row for a refused `v1` with its spent approval seeded. */
function insertException(over: Over = {}): void {
  seedApproval(db);
  insert({ ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_refused', ...over });
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

  it('creates two tables and their triggers, and alters nothing', () => {
    const creates = SQL_TEXT.replace(/--.*$/gm, '').match(/^CREATE .*$/gm);
    expect(creates).toEqual([
      `CREATE TABLE IF NOT EXISTS ${CLAIMS} (`,
      `CREATE TRIGGER IF NOT EXISTS trg_${CLAIMS}_start`,
      `CREATE TRIGGER IF NOT EXISTS trg_${CLAIMS}_identity_immutable`,
      `CREATE TRIGGER IF NOT EXISTS trg_${CLAIMS}_kick_guard`,
      `CREATE TRIGGER IF NOT EXISTS trg_${CLAIMS}_no_delete`,
      `CREATE TABLE IF NOT EXISTS ${TABLE} (`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_void_match`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_open_shift`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_payout_window`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_claim`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_exception_approval`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_update`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_delete`,
    ]);
    expect(SQL_TEXT.replace(/--.*$/gm, '')).not.toMatch(
      /ALTER\s|DROP\s|UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO/i,
    );
    expect(columns(CLAIMS)).toEqual([
      'void_id',
      'sale_id',
      'tenant_id',
      'branch_id',
      'terminal_id',
      'shift_id',
      'business_date',
      'claimed_by_operator_id',
      'claimed_by_display_name',
      'claimed_by_session_id',
      'claimed_at',
      'kick_outcome',
      'kick_count',
      'kicked_at',
    ]);
    expect(columns(TABLE)).toEqual([
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
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${CLAIMS};`);
  });

  it('ships empty', () => {
    expect(count()).toBe(0);
    expect(count(CLAIMS)).toBe(0);
  });

  describe('a claim exists before the drawer, for a confirmed void in an open shift on its day', () => {
    it('accepts the claim of a confirmed void in a shift open before the void was requested', () => {
      journalVoid('confirmed');
      openShift();
      insertClaim();
      expect(count(CLAIMS)).toBe(1);
    });

    it.each(['pending', 'unknown', 'refused'] as const)(
      'refuses a claim for a void that is %s',
      (state) => {
        journalVoid(state);
        openShift();
        expect(() => {
          insertClaim();
        }).toThrow(/confirmed void/);
      },
    );

    it('refuses a claim with no open shift, in a shift opened after the request, or another day', () => {
      journalVoid('confirmed');
      expect(() => {
        insertClaim();
      }).toThrow(/confirmed void/);
      openShift(SHIFT_A, OPENED_AFTER_VOID);
      expect(() => {
        insertClaim();
      }).toThrow(/confirmed void/);
      db.run('DELETE FROM shift_cashup_opens WHERE 0');
      expect(() => {
        insertClaim({ business_date: '2026-06-08' });
      }).toThrow(/confirmed void/);
    });

    it('refuses a claim into a shift with a manager closure', () => {
      journalVoid('confirmed');
      openShift();
      db.run(
        `INSERT INTO shift_manager_closures (shift_id, source_fact_kind, recorded_at)
         VALUES (?, 'close', ?)`,
        [SHIFT_A, PAID_AT],
      );
      expect(() => {
        insertClaim();
      }).toThrow(/confirmed void/);
    });

    it('refuses a claim for a void with no cash', () => {
      seedSale(db);
      const repo = createSaleVoidRepository(handleFor(db));
      repo.insert(newVoidEntry(1, { cashMinor: 0 }));
      repo.markConfirmed({
        voidId: 'v1',
        voidRef: '0190f5a2-7b3c-7d4e-8f90-0000000000d1',
        now: '2026-06-07T10:07:00.000Z',
      });
      openShift();
      expect(() => {
        insertClaim();
      }).toThrow(/confirmed void/);
    });

    it('holds one claim per void and per sale, and none once the sale has a record', () => {
      journalVoid('confirmed');
      openShift();
      insertClaim();
      expect(() => {
        insertClaim();
      }).toThrow(/UNIQUE/);
    });

    it('refuses a claim for a sale that already has a cash record (an exception)', () => {
      journalVoid('refused');
      openShift();
      insertException();
      const repo = createSaleVoidRepository(handleFor(db));
      repo.insert(
        newVoidEntry(2, {
          saleId: 'sale-1',
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
        insertClaim({ void_id: 'v2' });
      }).toThrow(/confirmed void|UNIQUE/);
    });

    it('starts never kicked', () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insertClaim({ kick_outcome: 'sending', kick_count: 1, kicked_at: KICKED_AT });
      }).toThrow(/confirmed void/);
    });

    it('checks the kick record shape', () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insertClaim({ kick_outcome: 'opened', kick_count: 0, kicked_at: null });
      }).toThrow(/CHECK|confirmed void/);
    });
  });

  describe('the drawer kick of a claim moves forward only (the RT-15 machine)', () => {
    beforeEach(() => {
      journalVoid('confirmed');
      openShift();
      insertClaim();
    });

    const mark = (): void => {
      db.run(
        `UPDATE ${CLAIMS} SET kick_outcome = 'sending', kick_count = kick_count + 1, kicked_at = ?`,
        [KICKED_AT],
      );
    };
    const resolve = (outcome: string): void => {
      db.run(`UPDATE ${CLAIMS} SET kick_outcome = ?`, [outcome]);
    };

    it.each(['opened', 'failed_before_send', 'unknown'])(
      'resolves a sent kick to %s',
      (outcome) => {
        mark();
        resolve(outcome);
        expect(db.exec(`SELECT kick_outcome FROM ${CLAIMS}`)[0]?.values[0]?.[0]).toBe(outcome);
      },
    );

    it('allows another kick only after one that never left', () => {
      mark();
      resolve('failed_before_send');
      mark();
      expect(db.exec(`SELECT kick_count FROM ${CLAIMS}`)[0]?.values[0]?.[0]).toBe(2);
    });

    it.each(['opened', 'unknown'])('never kicks again after %s', (outcome) => {
      mark();
      resolve(outcome);
      expect(() => {
        mark();
      }).toThrow(/illegal drawer kick/);
    });

    it('resolves a kick once, and never skips the sending mark', () => {
      expect(() => {
        resolve('opened');
      }).toThrow(/illegal drawer kick|CHECK/);
      mark();
      resolve('opened');
      expect(() => {
        resolve('unknown');
      }).toThrow(/illegal drawer kick/);
    });

    it('never changes who claimed it, or when, or in which shift', () => {
      for (const set of [
        `claimed_by_operator_id = 'x'`,
        `claimed_by_session_id = 'x'`,
        `claimed_at = 'x'`,
        `shift_id = '${SHIFT_B}'`,
        `business_date = '2026-06-08'`,
        `sale_id = 'sale-2'`,
      ]) {
        expect(() => {
          db.run(`UPDATE ${CLAIMS} SET ${set}`);
        }).toThrow(/immutable/);
      }
    });

    it('never deletes a claim', () => {
      expect(() => {
        db.run(`DELETE FROM ${CLAIMS}`);
      }).toThrow(/append-only/);
      expect(count(CLAIMS)).toBe(1);
    });
  });

  describe('a payout is the cash of a CONFIRMED void, completing its claim, on its business day', () => {
    it('accepts the payout of a confirmed void whose drawer opened', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
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
        }).toThrow(/CHECK|payout window|claim/);
        expect(() => {
          insert(); // claims `confirmed`, but the journal says otherwise
        }).toThrow(/void/);
        expect(count()).toBe(0);
      },
    );

    it('refuses a payout with no claim', () => {
      journalVoid('confirmed');
      openShift();
      expect(() => {
        insert();
      }).toThrow(/claim/);
    });

    it('refuses a payout in another shift than its claim', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
      // The claim's shift ends (a manager closure) and the terminal opens another one.
      db.run(
        `INSERT INTO shift_manager_closures (shift_id, source_fact_kind, recorded_at)
         VALUES (?, 'close', ?)`,
        [SHIFT_A, PAID_AT],
      );
      openShift(SHIFT_B, OPENED_BEFORE_VOID);
      expect(() => {
        insert({ shift_id: SHIFT_B });
      }).toThrow(/claim/);
    });

    it.each([
      ['drawer', 'failed_before_send'],
      ['drawer', 'unknown'],
      ['no_drawer', 'opened'],
      ['no_drawer', 'unknown'],
    ] as const)('refuses a %s record after a kick that %s', (method, kick) => {
      journalVoid('confirmed');
      openShift();
      claim(kick);
      expect(() => {
        insert({ method });
      }).toThrow(/claim/);
    });

    it('accepts a no_drawer record after a kick that never left, and a drawer one after opened', () => {
      journalVoid('confirmed');
      openShift();
      claim('failed_before_send');
      insert({ method: 'no_drawer' });
      expect(count()).toBe(1);
    });

    it.each(['unknown', 'opened', 'failed_before_send'] as const)(
      'accepts a manual attestation after a kick that %s',
      (kick) => {
        journalVoid('confirmed');
        openShift();
        claim(kick);
        insert({ method: 'manual' });
        expect(count()).toBe(1);
      },
    );

    it('refuses a manual attestation while a kick is in flight, and accepts it after its lease', () => {
      journalVoid('confirmed');
      openShift();
      claim('sending');
      expect(() => {
        insert({ method: 'manual', paid_at: '2026-06-07T12:58:35.000Z' });
      }).toThrow(/claim/);
      insert({ method: 'manual', paid_at: '2026-06-07T12:58:41.000Z' });
      expect(count()).toBe(1);
    });

    it('refuses a payout for a void that does not exist, or whose facts differ', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
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

    it('refuses a payout when the shift has closed since the claim', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
      db.run(
        `INSERT INTO shift_manager_closures (shift_id, source_fact_kind, recorded_at)
         VALUES (?, 'close', ?)`,
        [SHIFT_A, PAID_AT],
      );
      expect(() => {
        insert();
      }).toThrow(/open shift/);
    });

    it('refuses a payout in a shift opened after the void was requested (not the same shift)', () => {
      journalVoid('confirmed');
      openShift(SHIFT_A, OPENED_AFTER_VOID);
      expect(() => {
        insert();
      }).toThrow(/same shift|window|claim/);
    });

    it("refuses a payout on another business day than the void's", () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
      expect(() => {
        insert({ business_date: '2026-06-08' });
      }).toThrow(/window/);
    });

    it('refuses a payment made on the next day, with the day derived from the payment time', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
      const paidAt = '2026-06-08T09:00:00.000Z';
      // The row says what the code would say: the day OF the payment, never a hand-picked date.
      expect(() => {
        insert({ paid_at: paidAt, business_date: paidAt.slice(0, 10) });
      }).toThrow(/window/);
      expect(count()).toBe(0);
    });

    it('refuses a payout into another shift than the terminal open one', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
      expect(() => {
        insert({ shift_id: '0192f5a2-3b4c-7d8e-9f01-0000000000a9' });
      }).toThrow(/claim|open shift|FOREIGN/);
    });

    it('holds one record per void and one per sale', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
      insert();
      expect(() => {
        insert({ payout_id: PAYOUT_2 });
      }).toThrow(/UNIQUE/);
      expect(count()).toBe(1);
    });

    it('holds one record per sale even across a later void of the same sale', () => {
      journalVoid('refused');
      openShift();
      insertException();
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
      }).toThrow(/UNIQUE|claim/);
    });

    it('checks the shape of the identities and the method', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
      expect(() => {
        insert({ payout_id: 'not-a-uuid' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ kind: 'refund' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ method: 'cheque' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ amount_minor: -1 });
      }).toThrow(/CHECK|void must exist/);
      expect(() => {
        insert({ business_date: '07/06/2026' });
      }).toThrow(/CHECK|payout window/);
    });

    it('a payout carries no exception evidence and no mismatch flag', () => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
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
      seedApproval(db);
      insert({ ...EXCEPTION, void_state: state, mismatch_reason: flag });
      expect(count()).toBe(1);
    });

    it('refuses an exception for a void that is not accepted without its mismatch flag', () => {
      journalVoid('refused');
      openShift();
      seedApproval(db);
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
      seedApproval(db);
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
      seedApproval(db);
      insert({ ...EXCEPTION, void_state: 'confirmed' });
      expect(count()).toBe(1);
    });

    it('settles an open claim, once its kick is not in flight', () => {
      journalVoid('confirmed');
      openShift();
      claim('unknown');
      seedApproval(db);
      insert({ ...EXCEPTION, void_state: 'confirmed', mismatch_reason: 'payout_window_closed' });
      expect(count()).toBe(1);
    });

    it('does not settle a claim whose kick is in flight', () => {
      journalVoid('confirmed');
      openShift();
      claim('sending');
      seedApproval(db);
      expect(() => {
        insert({
          ...EXCEPTION,
          void_state: 'confirmed',
          mismatch_reason: 'payout_window_closed',
          paid_at: '2026-06-07T12:58:35.000Z',
        });
      }).toThrow(/claim/);
    });

    it('needs an open shift: a closed shift is never changed', () => {
      journalVoid('refused');
      seedApproval(db);
      expect(() => {
        insert({ ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_refused' });
      }).toThrow(/open shift/);
    });

    it('needs the whole approval evidence, and the method manual', () => {
      journalVoid('refused');
      openShift();
      seedApproval(db);
      const base = { ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_refused' };
      for (const key of [
        'exception_approval_id',
        'exception_approver_user_id',
        'exception_requester_user_id',
        'exception_policy_version',
      ]) {
        expect(() => {
          insert({ ...base, [key]: null });
        }).toThrow(/CHECK|approval/);
      }
      expect(() => {
        insert({ ...base, method: 'drawer' });
      }).toThrow(/CHECK/);
    });

    it('refuses an approver who is the requester (four-eyes)', () => {
      journalVoid('refused');
      openShift();
      seedApproval(db, { approver: REQUESTER_USER });
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
      insertException();
      journalVoid('refused', 3);
      expect(() => {
        insert({
          ...EXCEPTION,
          payout_id: PAYOUT_2,
          void_id: 'v3',
          sale_id: 'sale-3',
          void_state: 'refused',
          mismatch_reason: 'void_refused',
        });
      }).toThrow(/UNIQUE|approval/);
    });

    describe('the approval it cites is checked against manager_approvals (L1)', () => {
      const row = { ...EXCEPTION, void_state: 'refused', mismatch_reason: 'void_refused' };

      beforeEach(() => {
        journalVoid('refused');
        openShift();
      });

      it('refuses an approval that does not exist', () => {
        expect(() => {
          insert(row);
        }).toThrow(/approval/);
      });

      it('refuses an approval of another kind', () => {
        seedApproval(db, { kind: 'sale.void' });
        expect(() => {
          insert(row);
        }).toThrow(/approval/);
      });

      it('refuses an approval that covers another void', () => {
        seedApproval(db, { voidId: 'v9' });
        expect(() => {
          insert(row);
        }).toThrow(/approval/);
      });

      it('refuses an approval given by another approver', () => {
        seedApproval(db, { approver: '0190f5a2-7b3c-7d4e-8f90-0000000000b9' });
        expect(() => {
          insert(row);
        }).toThrow(/approval/);
      });

      it('refuses an approval that was never spent', () => {
        seedApproval(db, { consumed: false });
        expect(() => {
          insert(row);
        }).toThrow(/approval/);
      });

      it('accepts a spent approval of its kind for this void and approver', () => {
        seedApproval(db);
        insert(row);
        expect(count()).toBe(1);
      });
    });
  });

  describe('a record is immutable and never deleted', () => {
    beforeEach(() => {
      journalVoid('confirmed');
      openShift();
      claim('opened');
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
