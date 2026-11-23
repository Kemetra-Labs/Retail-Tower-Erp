/**
 * RT-1553 — migration-shape test for `0071_return_journal_late_commit` ([GATED: migration], owner
 * authorization in chat 2026-11-23; finding F-1 of the RT-1498 close slice):
 *   • the number is unique and sorts after 0070;
 *   • it only recreates `trg_return_journal_dispositions_header` (same name); nothing else is created,
 *     altered or dropped, and no row is written;
 *   • after a close it allows EXACTLY one `needs_support` / `provenance_read` / `mismatch` with no
 *     approval and an actor, and nothing else (no second raise, no escalation, no hold, no automatic
 *     raise, no second close);
 *   • every write 0070 allowed before a close is still allowed;
 *   • the closed journal row stays frozen (it can never be confirmed, so never paid out);
 *   • an older build refuses a database that holds 0071 (RT-320);
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

const MIGRATION = '0071_return_journal_late_commit';
const TABLE = 'return_journal_dispositions';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const D1 = '0192f5a2-3b4c-7d8e-9f01-0000000000d1';
const D2 = '0192f5a2-3b4c-7d8e-9f01-0000000000d2';
const D3 = '0192f5a2-3b4c-7d8e-9f01-0000000000d3';
const APPROVAL_1 = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
const APPROVAL_2 = '0190f5a2-7b3c-7d4e-8f90-0000000000a2';
const READ_AT = '2026-11-22T10:00:00.000Z';

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

function count(): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${TABLE}`)[0]?.values[0]?.[0]);
}

/** A journaled return `r1` (quoted 1500): sent and `unknown`, or (`sent` false) never sent. */
function journalUnknown(sent = true): void {
  seedSale(db, { sale_id: 'sale-r1' });
  db.run(
    `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
       sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
       currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
     VALUES ('r1', 'tenant-1', 'branch-1', 'term-1', 'sale-r1', 'SN-1', ?, ?, 'op', 'sess', 'EGP',
       1500, '{}', 'pending', 't0', 't0')`,
    [SALE_REF, 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001'],
  );
  if (!sent) return;
  db.run(
    `UPDATE return_journal SET attempt_count = 1, last_attempt_at = 't1', state = 'unknown'
      WHERE return_id = 'r1'`,
  );
}

/** A spent `return.resolve_unknown` approval for r1 bound to `disposition`. */
function seedApproval(approvalId: string, disposition: 'close' | 'escalate'): void {
  db.run(
    `INSERT INTO manager_approvals
       (approval_id, tenant_id, branch_id, terminal_id, action_kind, subject_ref, subject_version,
        amount_minor, reason_code, requester_operator_id, requester_user_id, approver_user_id,
        policy_version, issued_at, expires_at, consumed_at)
     VALUES (?, 'tenant-1', 'branch-1', 'term-1', 'return.resolve_unknown', ?, ?, 1500,
       'escalate_unknown', 'op-manager', 'requester-user', 'approver-user', 'rt114-2026-10-07',
       '2026-11-22T09:55:00.000Z', '2026-11-22T09:57:00.000Z', '2026-11-22T09:56:00.000Z')`,
    [approvalId, `r1_${disposition}`, `${disposition}|unknown|1`],
  );
}

type Over = Partial<Record<string, string | number | null>>;

function insert(over: Over): void {
  const row: Record<string, string | number | null> = {
    disposition_id: D2,
    return_id: 'r1',
    kind: 'needs_support',
    verdict_source: 'provenance_read',
    reason: 'mismatch',
    read_verdict_at: READ_AT,
    approval_id: null,
    actor_operator_id: 'op-manager',
    created_at: '2026-11-22T10:30:00.000Z',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${TABLE} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] ?? null),
  );
}

/** The close of r1 (D1), with its spent approval. */
function close(): void {
  seedApproval(APPROVAL_1, 'close');
  insert({
    disposition_id: D1,
    kind: 'not_recorded_closed',
    verdict_source: 'provenance_read',
    reason: 'not_recorded',
    approval_id: APPROVAL_1,
    created_at: '2026-11-22T10:00:00.000Z',
  });
}

/** The late-commit support raise the migration allows after a close. */
const LATE: Over = { disposition_id: D2 };

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

const code = (): string => SQL_TEXT.replace(/--.*$/gm, '');

describe('0071 — a closed return that later commits raises support (RT-1553)', () => {
  it('is the only migration numbered 0071 and sorts after 0070', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0071_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted.indexOf(`${MIGRATION}.sql`)).toBeGreaterThan(
      sorted.indexOf('0070_return_journal_dispositions.sql'),
    );
  });

  it('only recreates the header trigger: nothing else is created, altered, dropped or written', () => {
    expect(code().match(/^(CREATE|DROP) .*$/gm)).toEqual([
      'DROP TRIGGER IF EXISTS trg_return_journal_dispositions_header;',
      'CREATE TRIGGER trg_return_journal_dispositions_header',
    ]);
    expect(code()).not.toMatch(/ALTER\s|UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO/i);
    const triggers = (
      db.exec(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '${TABLE}' ORDER BY name`,
      )[0]?.values ?? []
    ).map((r) => String(r[0]));
    expect(triggers).toEqual([
      'trg_return_journal_dispositions_approval',
      'trg_return_journal_dispositions_header',
      'trg_return_journal_dispositions_no_delete',
      'trg_return_journal_dispositions_no_update',
    ]);
  });

  it('carries the [GATED] authorization, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('RT-1553');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
    expect(SQL_TEXT).toContain('0070 is NOT edited');
  });

  it('ships no rows', () => {
    expect(count()).toBe(0);
  });

  describe('after a close', () => {
    beforeEach(() => {
      journalUnknown();
      close();
    });

    it('accepts exactly one provenance_read mismatch needs_support with no approval and an actor', () => {
      insert(LATE);
      expect(count()).toBe(2);
    });

    it('refuses a second late-commit raise', () => {
      insert(LATE);
      expect(() => {
        insert({ disposition_id: D3 });
      }).toThrow(/already raised/);
      expect(count()).toBe(2);
    });

    it.each([
      ['no actor', { actor_operator_id: null }],
      ['no read time (0070 CHECK)', { read_verdict_at: null }],
      [
        'an automatic send_response raise',
        {
          verdict_source: 'send_response',
          read_verdict_at: null,
          actor_operator_id: null,
        },
      ],
      [
        'an automatic auth_failure raise',
        {
          verdict_source: 'auth_failure',
          reason: 'auth_failure',
          read_verdict_at: null,
          actor_operator_id: null,
        },
      ],
      ['a retry_hold', { kind: 'retry_hold', reason: 'not_recorded' }],
    ] as const)('refuses %s', (_name, over) => {
      expect(() => {
        insert({ ...LATE, ...over });
      }).toThrow(/closed|CHECK/);
      expect(count()).toBe(1);
    });

    it('refuses an operator escalation with a spent approval', () => {
      seedApproval(APPROVAL_2, 'escalate');
      expect(() => {
        insert({
          disposition_id: D2,
          verdict_source: 'operator',
          reason: 'operator',
          read_verdict_at: null,
          approval_id: APPROVAL_2,
        });
      }).toThrow(/closed/);
      expect(count()).toBe(1);
    });

    it('refuses a provenance_read mismatch that carries an approval', () => {
      seedApproval(APPROVAL_2, 'escalate');
      expect(() => {
        insert({ ...LATE, approval_id: APPROVAL_2 });
      }).toThrow(/closed|CHECK/);
      expect(count()).toBe(1);
    });

    it('refuses a second close', () => {
      seedApproval(APPROVAL_2, 'close');
      expect(() => {
        insert({
          disposition_id: D2,
          kind: 'not_recorded_closed',
          reason: 'not_recorded',
          approval_id: APPROVAL_2,
        });
      }).toThrow(/closed/);
      expect(count()).toBe(1);
    });

    it('keeps the journal row frozen after the raise: it can never be confirmed (no payout)', () => {
      insert(LATE);
      expect(() => {
        db.run(
          `UPDATE return_journal SET state = 'confirmed', return_ref = 'x', return_total_minor = 1500,
             confirmed_at = 't' WHERE return_id = 'r1'`,
        );
      }).toThrow(/closed/);
      expect(
        String(
          db.exec(`SELECT state FROM return_journal WHERE return_id = 'r1'`)[0]?.values[0]?.[0],
        ),
      ).toBe('unknown');
    });

    it('orders the raise after the close by rowid', () => {
      insert(LATE);
      const rows = (
        db.exec(`SELECT kind FROM ${TABLE} WHERE return_id = 'r1' ORDER BY rowid`)[0]?.values ?? []
      ).map((r) => String(r[0]));
      expect(rows).toEqual(['not_recorded_closed', 'needs_support']);
    });
  });

  describe('before a close, 0070 still holds', () => {
    it('accepts the provenance_read mismatch needs_support more than once', () => {
      journalUnknown();
      insert({ disposition_id: D1 });
      insert({ disposition_id: D2 });
      expect(count()).toBe(2);
    });

    it('accepts a close after a needs_support', () => {
      journalUnknown();
      insert({ disposition_id: D2 });
      close();
      expect(count()).toBe(2);
    });

    it('then still allows the single late raise after that close', () => {
      journalUnknown();
      insert({ disposition_id: D2 });
      close();
      insert({ disposition_id: D3 });
      expect(count()).toBe(3);
    });

    it('still refuses a disposition of a never-sent return', () => {
      journalUnknown(false);
      expect(() => {
        insert({ disposition_id: D1 });
      }).toThrow(/unknown or sent/);
    });
  });

  it('the real runner applies it once; an older build (without 0071) then refuses the database (RT-320)', async () => {
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
