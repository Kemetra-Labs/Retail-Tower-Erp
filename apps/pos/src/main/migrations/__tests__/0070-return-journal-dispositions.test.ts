/**
 * RT-1498 S4 — migration-shape test for `0070_return_journal_dispositions` ([GATED: migration],
 * owner decision RT-1498 comment 18144 item 2, 2026-11-21; RT-196 design §3.4): the append-only
 * local record of how a permanently-unknown return was disposed of.
 *   • the number is unique and sorts after 0069;
 *   • one table, its triggers and indexes, plus the freeze trigger on a closed journal row; nothing
 *     altered or dropped, nothing inserted;
 *   • a disposition exists only while the journal row is `unknown` (or `pending` and sent), and
 *     never after a close;
 *   • the kind / verdict_source / reason / approval / actor combinations are closed (Gap 2: a
 *     needs_support from a provenance read needs no approval);
 *   • a disposition that cites an approval cites a SPENT approval of kind `return.resolve_unknown`
 *     bound to THIS return AND to the SAME disposition (Gap 1: one kind, the disposition bound);
 *   • at most one close per return, and one approval backs one disposition;
 *   • a record is immutable and is never deleted; a closed return can no longer be confirmed,
 *     refused or re-attempted, whoever writes;
 *   • an older build refuses a database that holds 0070 (RT-320);
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

const MIGRATION = '0070_return_journal_dispositions';
const TABLE = 'return_journal_dispositions';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const D1 = '0192f5a2-3b4c-7d8e-9f01-0000000000d1';
const D2 = '0192f5a2-3b4c-7d8e-9f01-0000000000d2';
const APPROVAL_1 = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
const APPROVAL_2 = '0190f5a2-7b3c-7d4e-8f90-0000000000a2';
const READ_AT = '2026-11-22T10:00:00.000Z';
const KIND = 'return.resolve_unknown';

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

type State = 'pending' | 'unknown' | 'confirmed' | 'refused';

/**
 * A journaled return `r<n>` (quoted 1500) moved to `state`. `pending` is journaled and unsent
 * (`attempt_count` 0); `sent` marks one attempt; `unknown` always has one attempt.
 */
function journal(state: State, n = 1, sent = state !== 'pending'): void {
  const returnId = `r${String(n)}`;
  seedSale(db, { sale_id: `sale-${returnId}` });
  db.run(
    `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
       sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
       currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
     VALUES (?, 'tenant-1', 'branch-1', 'term-1', ?, 'SN-1', ?, ?, 'op', 'sess', 'EGP', 1500, '{}',
       'pending', 't0', 't0')`,
    [
      returnId,
      `sale-${returnId}`,
      SALE_REF,
      `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-00000000000${String(n)}`,
    ],
  );
  db.run(`INSERT INTO return_journal_lines (return_id, line_ref, quantity) VALUES (?, ?, 1)`, [
    returnId,
    '0190f5a2-7b3c-7d4e-8f90-00000000000a',
  ]);
  if (sent) {
    db.run(
      `UPDATE return_journal SET attempt_count = 1, last_attempt_at = 't1' WHERE return_id = ?`,
      [returnId],
    );
  }
  if (state === 'unknown') {
    db.run(`UPDATE return_journal SET state = 'unknown' WHERE return_id = ?`, [returnId]);
  } else if (state === 'confirmed') {
    db.run(
      `UPDATE return_journal SET state = 'confirmed', return_ref = ?, return_total_minor = 1500,
         confirmed_at = 't2' WHERE return_id = ?`,
      ['0190f5a2-7b3c-7d4e-8f90-0000000000ff', returnId],
    );
  } else if (state === 'refused') {
    db.run(
      `UPDATE return_journal SET state = 'refused', refusal_reason = 'over_return'
       WHERE return_id = ?`,
      [returnId],
    );
  }
}

/** A spent `return.resolve_unknown` approval bound to `returnId` and `disposition`. */
function seedApproval(
  over: {
    approvalId?: string;
    returnId?: string;
    disposition?: 'close' | 'escalate';
    kind?: string;
    consumed?: boolean;
    amount?: number;
    terminal?: string;
    subjectRef?: string;
    requesterOperator?: string;
    requesterUser?: string | null;
    approverUser?: string;
  } = {},
): void {
  const returnId = over.returnId ?? 'r1';
  db.run(
    `INSERT INTO manager_approvals
       (approval_id, tenant_id, branch_id, terminal_id, action_kind, subject_ref, subject_version,
        amount_minor, reason_code, requester_operator_id, requester_user_id, approver_user_id,
        policy_version, issued_at, expires_at, consumed_at)
     VALUES (?, 'tenant-1', 'branch-1', ?, ?, ?, ?, ?, 'escalate_unknown', ?, ?, ?,
       'rt114-2026-10-07', '2026-11-22T09:55:00.000Z', '2026-11-22T09:57:00.000Z', ?)`,
    [
      over.approvalId ?? APPROVAL_1,
      over.terminal ?? 'term-1',
      over.kind ?? KIND,
      over.subjectRef ?? `${returnId}_${over.disposition ?? 'escalate'}`,
      `${over.disposition ?? 'escalate'}|unknown|1`,
      over.amount ?? 1500,
      over.requesterOperator ?? 'op-manager',
      over.requesterUser === undefined ? 'requester-user' : over.requesterUser,
      over.approverUser ?? 'approver-user',
      over.consumed === false ? null : '2026-11-22T09:56:00.000Z',
    ],
  );
}

type Over = Partial<Record<string, string | number | null>>;

function insert(over: Over = {}): void {
  const row: Record<string, string | number | null> = {
    disposition_id: D1,
    return_id: 'r1',
    kind: 'needs_support',
    verdict_source: 'operator',
    reason: 'operator',
    read_verdict_at: null,
    approval_id: APPROVAL_1,
    actor_operator_id: 'op-manager',
    created_at: '2026-11-22T09:58:00.000Z',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${TABLE} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] ?? null),
  );
}

/** An operator escalation (needs_support) with its approval seeded. */
function escalate(over: Over = {}, approval: Parameters<typeof seedApproval>[0] = {}): void {
  seedApproval({ disposition: 'escalate', ...approval });
  insert(over);
}

const CLOSE: Over = {
  kind: 'not_recorded_closed',
  verdict_source: 'provenance_read',
  reason: 'not_recorded',
  read_verdict_at: READ_AT,
};

/** A close with its approval seeded. */
function close(over: Over = {}, approval: Parameters<typeof seedApproval>[0] = {}): void {
  seedApproval({ disposition: 'close', ...approval });
  insert({ ...CLOSE, ...over });
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

describe('0070 — return journal dispositions (RT-1498 S4)', () => {
  it('is the only migration numbered 0070 and sorts after 0069', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0070_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted.indexOf(`${MIGRATION}.sql`)).toBeGreaterThan(
      sorted.indexOf('0069_sale_void_payouts.sql'),
    );
  });

  it('creates one table, its indexes and triggers, and alters no table', () => {
    const creates = SQL_TEXT.replace(/--.*$/gm, '').match(/^CREATE .*$/gm);
    expect(creates).toEqual([
      `CREATE TABLE IF NOT EXISTS ${TABLE} (`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLE}_one_close`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLE}_approval`,
      `CREATE INDEX IF NOT EXISTS idx_${TABLE}_return`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_header`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_approval`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_update`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_delete`,
      'CREATE TRIGGER IF NOT EXISTS trg_return_journal_closed_frozen',
    ]);
    expect(SQL_TEXT.replace(/--.*$/gm, '')).not.toMatch(
      /ALTER\s|DROP\s|UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO/i,
    );
    expect(columns()).toEqual([
      'disposition_id',
      'return_id',
      'kind',
      'verdict_source',
      'reason',
      'read_verdict_at',
      'approval_id',
      'actor_operator_id',
      'created_at',
    ]);
  });

  it('carries the [GATED] authorization, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('RT-1498');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${TABLE};`);
    expect(SQL_TEXT).toContain('DROP TRIGGER IF EXISTS trg_return_journal_closed_frozen;');
    // The one trigger added on the existing 0039 table is named in the header (GATED review MEDIUM-1).
    expect(SQL_TEXT).toContain('EXISTING 0039 `return_journal` table');
    expect(SQL_TEXT).toContain('changes no column, and is inert until a close exists');
  });

  it('ships empty', () => {
    expect(count()).toBe(0);
  });

  describe('when a disposition may be written', () => {
    it('accepts an operator needs_support for an unknown return', () => {
      journal('unknown');
      escalate();
      expect(count()).toBe(1);
    });

    it('accepts one for a pending return that was sent at least once', () => {
      journal('pending', 1, true);
      escalate();
      expect(count()).toBe(1);
    });

    it('refuses one for a never-sent pending return (Gap 3: send it first)', () => {
      journal('pending', 1, false);
      expect(() => {
        escalate();
      }).toThrow(/dispositions: .*unknown or sent/);
      expect(count()).toBe(0);
    });

    it.each(['confirmed', 'refused'] as const)('refuses one for a %s return', (state) => {
      journal(state);
      expect(() => {
        escalate();
      }).toThrow(/dispositions: .*unknown or sent/);
    });

    it('refuses one for a return that does not exist', () => {
      expect(() => {
        escalate();
      }).toThrow();
    });

    it('refuses any disposition once the return is closed', () => {
      journal('unknown');
      close();
      expect(() => {
        escalate({ disposition_id: D2, approval_id: APPROVAL_2 }, { approvalId: APPROVAL_2 });
      }).toThrow(/closed/);
      expect(count()).toBe(1);
    });
  });

  describe('the closed set of kind, source, reason, approval and actor (Gap 2)', () => {
    beforeEach(() => {
      journal('unknown');
    });

    it('accepts a close from a provenance read with its approval, actor and read time', () => {
      close();
      expect(count()).toBe(1);
    });

    it.each([
      ['no approval', { approval_id: null }],
      ['no actor', { actor_operator_id: null }],
      ['no read time', { read_verdict_at: null }],
      ['a send_response source', { verdict_source: 'send_response' }],
      ['an operator reason', { reason: 'operator' }],
    ] as const)('refuses a close with %s', (_name, over) => {
      expect(() => {
        close(over);
      }).toThrow(/CHECK|approval/);
    });

    it('accepts an automatic send_response mismatch with no approval and no actor', () => {
      insert({
        verdict_source: 'send_response',
        reason: 'mismatch',
        approval_id: null,
        actor_operator_id: null,
      });
      expect(count()).toBe(1);
    });

    it('accepts an automatic auth_failure with no approval and no actor', () => {
      insert({
        verdict_source: 'auth_failure',
        reason: 'auth_failure',
        approval_id: null,
        actor_operator_id: null,
      });
      expect(count()).toBe(1);
    });

    it('accepts a provenance_read mismatch needs_support with NO approval (Gap 2) and an actor', () => {
      insert({
        verdict_source: 'provenance_read',
        reason: 'mismatch',
        approval_id: null,
        read_verdict_at: READ_AT,
      });
      expect(count()).toBe(1);
    });

    it.each([
      ['an operator raise with no approval', { approval_id: null }],
      ['an operator raise with no actor', { actor_operator_id: null }],
      [
        'a send_response mismatch that carries an approval',
        { verdict_source: 'send_response', reason: 'mismatch', actor_operator_id: null },
      ],
      [
        'a send_response mismatch that carries an actor',
        { verdict_source: 'send_response', reason: 'mismatch', approval_id: null },
      ],
      [
        'an auth_failure that names an actor',
        { verdict_source: 'auth_failure', reason: 'auth_failure', approval_id: null },
      ],
      [
        'a provenance_read mismatch with no actor',
        {
          verdict_source: 'provenance_read',
          reason: 'mismatch',
          approval_id: null,
          actor_operator_id: null,
          read_verdict_at: READ_AT,
        },
      ],
      [
        'a provenance_read mismatch with no read time',
        { verdict_source: 'provenance_read', reason: 'mismatch', approval_id: null },
      ],
      ['a mismatched source and reason', { verdict_source: 'operator', reason: 'mismatch' }],
      ['an unknown kind', { kind: 'frozen' }],
      ['an unknown source', { verdict_source: 'guess' }],
      ['an unknown reason', { reason: 'because' }],
    ] as const)('refuses needs_support with %s', (_name, over) => {
      expect(() => {
        escalate(over);
      }).toThrow(/CHECK|approval/);
    });

    it('accepts a retry_hold from a provenance read with a read time and no approval', () => {
      insert({
        kind: 'retry_hold',
        verdict_source: 'provenance_read',
        reason: 'not_recorded',
        approval_id: null,
        read_verdict_at: READ_AT,
      });
      expect(count()).toBe(1);
    });

    it('refuses a retry_hold that carries an approval', () => {
      expect(() => {
        seedApproval({ disposition: 'escalate' });
        insert({
          kind: 'retry_hold',
          verdict_source: 'provenance_read',
          reason: 'not_recorded',
          read_verdict_at: READ_AT,
        });
      }).toThrow(/CHECK/);
    });

    it('refuses an approval id that is not in lower case (0048 stores it so)', () => {
      expect(() => {
        escalate({ approval_id: APPROVAL_1.toUpperCase() });
      }).toThrow();
    });
  });

  describe('a disposition that cites an approval cites the right one (Gap 1)', () => {
    beforeEach(() => {
      journal('unknown');
    });

    it('refuses an approval that does not exist', () => {
      expect(() => {
        insert();
      }).toThrow(/approval/);
    });

    it('refuses an approval that was never spent', () => {
      expect(() => {
        escalate({}, { consumed: false });
      }).toThrow(/approval/);
    });

    it('refuses an approval of another kind', () => {
      expect(() => {
        escalate({}, { kind: 'sale.void' });
      }).toThrow(/approval/);
    });

    it('refuses an approval for another return', () => {
      journal('unknown', 2);
      expect(() => {
        escalate({}, { returnId: 'r2' });
      }).toThrow(/approval/);
    });

    it('refuses an escalate approval for a CLOSE (the disposition is bound)', () => {
      expect(() => {
        close({}, { disposition: 'escalate' });
      }).toThrow(/approval/);
      expect(count()).toBe(0);
    });

    it('refuses a close approval for an ESCALATE (the disposition is bound)', () => {
      expect(() => {
        escalate({}, { disposition: 'close' });
      }).toThrow(/approval/);
      expect(count()).toBe(0);
    });

    it('refuses an approval bound to another amount or terminal', () => {
      expect(() => {
        escalate({}, { amount: 1499 });
      }).toThrow(/approval/);
      expect(() => {
        escalate(
          { disposition_id: D2, approval_id: APPROVAL_2 },
          {
            approvalId: APPROVAL_2,
            terminal: 'term-2',
          },
        );
      }).toThrow(/approval/);
    });

    it('refuses an approval requested by another operator than the disposition actor (MEDIUM-2)', () => {
      expect(() => {
        escalate({}, { requesterOperator: 'op-other' });
      }).toThrow(/approval/);
      expect(count()).toBe(0);
    });

    it('refuses a self-approved approval: the approver is the requester (four-eyes, MEDIUM-2)', () => {
      expect(() => {
        escalate({}, { requesterUser: 'same-user', approverUser: 'same-user' });
      }).toThrow(/approval/);
      // The comparison ignores case: users.id is stored lower-case, but the rule must not depend on it.
      expect(() => {
        escalate(
          { disposition_id: D2, approval_id: APPROVAL_2 },
          { approvalId: APPROVAL_2, requesterUser: 'Same-User', approverUser: 'same-user' },
        );
      }).toThrow(/approval/);
      expect(count()).toBe(0);
    });

    it('refuses an approval with no requester users.id (fail closed)', () => {
      expect(() => {
        escalate({}, { requesterUser: null });
      }).toThrow(/approval/);
      expect(count()).toBe(0);
    });

    it('accepts the same approval once actor and four-eyes hold', () => {
      escalate({}, { requesterOperator: 'op-manager', approverUser: 'another-manager' });
      expect(count()).toBe(1);
    });

    it('lets one approval back one disposition only (single use)', () => {
      escalate();
      expect(() => {
        insert({ disposition_id: D2 });
      }).toThrow(/UNIQUE/);
      expect(count()).toBe(1);
    });
  });

  describe('close is terminal and unique; needs_support repeats', () => {
    beforeEach(() => {
      journal('unknown');
    });

    it('accepts needs_support more than once', () => {
      escalate();
      escalate({ disposition_id: D2, approval_id: APPROVAL_2 }, { approvalId: APPROVAL_2 });
      expect(count()).toBe(2);
    });

    it('accepts a close after a needs_support', () => {
      escalate();
      close({ disposition_id: D2, approval_id: APPROVAL_2 }, { approvalId: APPROVAL_2 });
      expect(count()).toBe(2);
    });

    it('allows at most one close per return', () => {
      close();
      expect(() => {
        close({ disposition_id: D2, approval_id: APPROVAL_2 }, { approvalId: APPROVAL_2 });
      }).toThrow();
      expect(count()).toBe(1);
    });

    it('allows a close for another return', () => {
      journal('unknown', 2);
      close();
      close(
        { disposition_id: D2, return_id: 'r2', approval_id: APPROVAL_2 },
        { approvalId: APPROVAL_2, returnId: 'r2' },
      );
      expect(count()).toBe(2);
    });
  });

  describe('a record is immutable and never deleted', () => {
    beforeEach(() => {
      journal('unknown');
      escalate();
    });

    it('refuses UPDATE of any column', () => {
      expect(() => {
        db.run(`UPDATE ${TABLE} SET reason = 'operator' WHERE disposition_id = ?`, [D1]);
      }).toThrow(/immutable/);
    });

    it('refuses DELETE', () => {
      expect(() => {
        db.run(`DELETE FROM ${TABLE} WHERE disposition_id = ?`, [D1]);
      }).toThrow(/append-only/);
      expect(count()).toBe(1);
    });
  });

  describe('a closed return is frozen in the journal', () => {
    beforeEach(() => {
      journal('unknown');
      close();
    });

    it.each([
      [
        'confirm it',
        `UPDATE return_journal SET state = 'confirmed', return_ref = 'x', return_total_minor = 1500, confirmed_at = 't' WHERE return_id = 'r1'`,
      ],
      [
        'refuse it',
        `UPDATE return_journal SET state = 'refused', refusal_reason = 'over_return' WHERE return_id = 'r1'`,
      ],
      [
        'attempt it again',
        `UPDATE return_journal SET attempt_count = attempt_count + 1, last_attempt_at = 't9' WHERE return_id = 'r1'`,
      ],
    ] as const)('refuses to %s', (_name, sql) => {
      expect(() => {
        db.run(sql);
      }).toThrow(/closed/);
    });

    it('still lets an unrelated return move', () => {
      journal('pending', 2, false);
      db.run(
        `UPDATE return_journal SET attempt_count = 1, last_attempt_at = 't1' WHERE return_id = 'r2'`,
      );
      expect(
        Number(
          db.exec(`SELECT attempt_count FROM return_journal WHERE return_id = 'r2'`)[0]
            ?.values[0]?.[0],
        ),
      ).toBe(1);
    });
  });

  describe('a needs_support return stays alive in the journal', () => {
    it('can still be confirmed, refused or attempted again', () => {
      journal('unknown');
      escalate();
      db.run(
        `UPDATE return_journal SET attempt_count = 2, last_attempt_at = 't9' WHERE return_id = 'r1'`,
      );
      db.run(
        `UPDATE return_journal SET state = 'confirmed', return_ref = 'x', return_total_minor = 1500, confirmed_at = 't' WHERE return_id = 'r1'`,
      );
      expect(
        String(
          db.exec(`SELECT state FROM return_journal WHERE return_id = 'r1'`)[0]?.values[0]?.[0],
        ),
      ).toBe('confirmed');
    });
  });

  it('the real runner applies it once; an older build (without 0070) then refuses the database (RT-320)', async () => {
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
