/**
 * RT-1543 — migration-shape test for `0068_return_refund_executions` ([GATED: migration], owner
 * decisions on RT-1543, comments 18082 and 18114, 2026-11-21): the refund-execution outbox.
 *   • the number is unique and sorts after 0066 (0067 is RT-388's shift variance policy, merged);
 *   • one table, three triggers, nothing altered or dropped, nothing inserted;
 *   • an execution row exists only for a PAID-OUT return, once per (return, allocation);
 *   • the identity and the frozen body never change; `recorded` and `refused` are final;
 *   • nothing is deleted;
 *   • an older build refuses a database that holds 0068 (RT-320);
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
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../db/__tests__/__helpers__/migrated-db.js';

const MIGRATION = '0068_return_refund_executions';
const TABLE = 'return_refund_executions';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const RETURN_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000ff';
const ALLOC_A = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
const ALLOC_B = '0190f5a2-7b3c-7d4e-8f90-0000000000a2';
const EXEC_A = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
const EXEC_B = '0190f5a2-7b3c-7d4e-8f90-0000000000e2';

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

/** A journaled return r1 moved to `confirmed`; with `paid` also through its payout to `paid_out`. */
function journal(paid: boolean, returnId = 'r1'): void {
  seedSale(db, { sale_id: `sale-${returnId}` });
  db.run(
    `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
       sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
       currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
     VALUES (?, 't', 'b', 'term', ?, 'SN-1', ?, ?, 'op', 'sess', 'EGP', 1500, '{}',
       'pending', 't0', 't0')`,
    [
      returnId,
      `sale-${returnId}`,
      SALE_REF,
      `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-00000000${returnId === 'r1' ? '0001' : '0002'}`,
    ],
  );
  db.run(`INSERT INTO return_journal_lines (return_id, line_ref, quantity) VALUES (?, ?, 1)`, [
    returnId,
    '0190f5a2-7b3c-7d4e-8f90-00000000000a',
  ]);
  db.run(
    `UPDATE return_journal SET state = 'confirmed', return_ref = ?, return_total_minor = 1500,
       confirmed_at = 't1' WHERE return_id = ?`,
    [RETURN_REF, returnId],
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

type Over = Partial<Record<string, string | number | null>>;

function insert(over: Over = {}): void {
  const row: Record<string, string | number | null> = {
    execution_id: EXEC_A,
    return_id: 'r1',
    server_sale_ref: SALE_REF,
    return_ref: RETURN_REF,
    allocation_ref: ALLOC_A,
    external_id: `pos-pulse-refund-exec:${EXEC_A}`,
    request_body_json: '{"k":1}',
    state: 'pending',
    created_at: 't4',
    updated_at: 't4',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${TABLE} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] ?? null),
  );
}

function update(set: string, id = EXEC_A): void {
  db.run(`UPDATE ${TABLE} SET ${set} WHERE execution_id = ?`, [id]);
}

function state(id = EXEC_A): string {
  return String(
    db.exec(`SELECT state FROM ${TABLE} WHERE execution_id = '${id}'`)[0]?.values[0]?.[0],
  );
}

function count(): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${TABLE}`)[0]?.values[0]?.[0]);
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

describe('0068 — return refund executions (RT-1543)', () => {
  it('is the only migration numbered 0068 and sorts after 0066', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0068_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted.indexOf(`${MIGRATION}.sql`)).toBeGreaterThan(
      sorted.indexOf('0066_sale_tender_refs_cutover.sql'),
    );
  });

  it('creates one table, one index and three triggers, and alters nothing', () => {
    const creates = SQL_TEXT.replace(/--.*$/gm, '').match(/^CREATE .*$/gm);
    expect(creates).toEqual([
      `CREATE TABLE IF NOT EXISTS ${TABLE} (`,
      `CREATE INDEX IF NOT EXISTS idx_${TABLE}_open`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_paid_out_only`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_guard`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_delete`,
    ]);
    expect(SQL_TEXT.replace(/--.*$/gm, '')).not.toMatch(
      /ALTER\s|DROP\s|UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO/i,
    );
    expect(columns()).toEqual([
      'execution_id',
      'return_id',
      'server_sale_ref',
      'return_ref',
      'allocation_ref',
      'external_id',
      'request_body_json',
      'state',
      'refusal_reason',
      'attempt_count',
      'last_attempt_at',
      'created_at',
      'updated_at',
      'recorded_at',
    ]);
  });

  it('carries the [GATED] authorization, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('RT-1543');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${TABLE};`);
  });

  it('ships empty', () => {
    expect(count()).toBe(0);
  });

  describe('an execution exists only for a paid-out return', () => {
    it.each([['confirmed (not paid out)', false]] as const)(
      'refuses a row for a return that is %s',
      (_n, paid) => {
        journal(paid);
        expect(() => {
          insert();
        }).toThrow(/paid-out return/);
      },
    );

    it('refuses a row for a return that does not exist', () => {
      expect(() => {
        insert({ return_id: 'ghost' });
      }).toThrow();
    });

    it('accepts a row for a paid-out return, pending and never attempted', () => {
      journal(true);
      insert();
      expect(count()).toBe(1);
      expect(() => {
        insert({
          execution_id: EXEC_B,
          allocation_ref: ALLOC_B,
          external_id: `pos-pulse-refund-exec:${EXEC_B}`,
          state: 'recorded',
          recorded_at: 't5',
        });
      }).toThrow();
      expect(() => {
        insert({
          execution_id: EXEC_B,
          allocation_ref: ALLOC_B,
          external_id: `pos-pulse-refund-exec:${EXEC_B}`,
          attempt_count: 2,
        });
      }).toThrow();
    });

    it('holds one row per (return, allocation); the external id is the prefix plus the execution id', () => {
      journal(true);
      insert();
      expect(() => {
        insert({ execution_id: EXEC_B, external_id: `pos-pulse-refund-exec:${EXEC_B}` });
      }).toThrow(/UNIQUE/);
      expect(() => {
        insert({ execution_id: EXEC_B, allocation_ref: ALLOC_B });
      }).toThrow(/CHECK/);
      insert({
        execution_id: EXEC_B,
        allocation_ref: ALLOC_B,
        external_id: `pos-pulse-refund-exec:${EXEC_B}`,
      });
      expect(count()).toBe(2);
    });

    it('checks the shape of the identities', () => {
      journal(true);
      expect(() => {
        insert({ external_id: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-0000000000e1' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ execution_id: 'not-a-uuid' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ request_body_json: '' });
      }).toThrow(/CHECK/);
      expect(() => {
        insert({ state: 'sent' });
      }).toThrow(/CHECK|pending row/);
    });
  });

  describe('state moves only forward, and the identity and body never change', () => {
    beforeEach(() => {
      journal(true);
      insert();
    });

    it.each([
      ['pending -> pending', `attempt_count = 1, last_attempt_at = 't5', updated_at = 't5'`],
      [
        'pending -> unknown',
        `state = 'unknown', attempt_count = 1, last_attempt_at = 't5', updated_at = 't5'`,
      ],
      ['pending -> recorded', `state = 'recorded', recorded_at = 't5', updated_at = 't5'`],
      ['pending -> refused', `state = 'refused', refusal_reason = 'conflict', updated_at = 't5'`],
    ])('allows %s', (_n, set) => {
      update(set);
    });

    it('allows unknown -> recorded and unknown -> refused', () => {
      update(`state = 'unknown', updated_at = 't5'`);
      update(`state = 'recorded', recorded_at = 't6', updated_at = 't6'`);
      expect(state()).toBe('recorded');
    });

    it('never moves back from unknown to pending', () => {
      update(`state = 'unknown', updated_at = 't5'`);
      expect(() => {
        update(`state = 'pending', updated_at = 't6'`);
      }).toThrow(/immutable|final|forward/);
    });

    it.each(['recorded', 'refused'])('%s is final', (final) => {
      update(
        final === 'recorded'
          ? `state = 'recorded', recorded_at = 't5', updated_at = 't5'`
          : `state = 'refused', refusal_reason = 'conflict', updated_at = 't5'`,
      );
      expect(() => {
        update(`updated_at = 't9'`);
      }).toThrow(/final/);
      expect(() => {
        update(`state = 'unknown'`);
      }).toThrow(/final/);
    });

    it.each([
      `execution_id = '${EXEC_B}'`,
      `return_id = 'r2'`,
      `server_sale_ref = '${RETURN_REF}'`,
      `return_ref = '${SALE_REF}'`,
      `allocation_ref = '${ALLOC_B}'`,
      `external_id = 'pos-pulse-refund-exec:${EXEC_B}'`,
      `request_body_json = '{"k":2}'`,
      `created_at = 'tX'`,
    ])('refuses to change an identity column (%s)', (set) => {
      expect(() => {
        update(set);
      }).toThrow(/immutable/);
    });

    it('requires the reason with refused, and the stamp with recorded', () => {
      expect(() => {
        update(`state = 'refused'`);
      }).toThrow(/CHECK/);
      expect(() => {
        update(`state = 'recorded'`);
      }).toThrow(/CHECK/);
      expect(() => {
        update(`refusal_reason = 'conflict'`);
      }).toThrow(/CHECK/);
    });

    it('never deletes', () => {
      expect(() => {
        db.run(`DELETE FROM ${TABLE}`);
      }).toThrow(/append-only/);
      expect(count()).toBe(1);
    });
  });

  it('the real runner applies it once; an older build (without 0068) then refuses the database (RT-320)', async () => {
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

  it('applies by name: a lower-numbered file that arrives after 0068 still applies', async () => {
    const SQL = (await import('sql.js')).default;
    const engine = await SQL();
    const raw = new engine.Database();
    try {
      const mdb = migrationsDbOf(raw);
      const files = shippedFiles();
      // A till that ran a build with 0068 but without the file just below it.
      const lower = files.filter((f) => f.name < MIGRATION).at(-1);
      expect(lower).toBeDefined();
      runMigrations({ db: mdb, files: files.filter((f) => f.name !== lower?.name) });
      expect(mdb.listAppliedNames()).toContain(MIGRATION);
      expect(mdb.listAppliedNames()).not.toContain(lower?.name);
      runMigrations({ db: mdb, files });
      expect(mdb.listAppliedNames()).toContain(lower?.name);
    } finally {
      raw.close();
    }
  });
});
