/**
 * RT-1498 (`0073_return_journal_origin`) — migration-shape, upgrade, immutability, and §A2 safety
 * tests for `return_journal_origin`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  cloneMigratedDb,
  initMigratedDbTemplate,
} from '../../db/__tests__/__helpers__/migrated-db.js';
import {
  SchemaAheadError,
  bindMigrationsDb,
  readMigrationsFromDisk,
  runMigrations,
} from '../../db/migrate.js';
import { handleFor, seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  SALE_REF as FIXTURE_SALE_REF,
  SCOPE,
} from '../../returns/__tests__/__helpers__/returns-fixture.js';

const MIGRATION = '0073_return_journal_origin';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
  await initMigratedDbTemplate();
});

function insertMinimalJournal(
  db: SqlJsDatabase,
  returnId: string,
  externalId = 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001',
): void {
  if (db.exec("SELECT 1 FROM sales WHERE sale_id = 'sale-1'").length === 0) {
    seedSale(db, { sale_id: 'sale-1' });
  }
  db.run(
    `INSERT INTO return_journal (
       return_id, external_id, tenant_id, branch_id, terminal_id,
       sale_id, sale_number, server_sale_ref, operator_id, operator_session_id,
       currency_code, quoted_total_minor, request_body_json, state, attempt_count,
       created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       'sale-1', 'SN-sale-1', ?, 'op-mgr-a', 'sess-a',
       'EGP', 1500, '{}', 'unknown', 1,
       '2026-11-27T10:00:00.000Z', '2026-11-27T10:00:00.000Z'
     )`,
    [returnId, externalId, SCOPE.tenantId, SCOPE.branchId, SCOPE.terminalId, FIXTURE_SALE_REF],
  );
}

describe('0073_return_journal_origin', () => {
  it('has a unique number that sorts after 0072 and documents §A2 + rollback', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0073_'));
    expect(names).toEqual([`${MIGRATION}.sql`]);
    expect(SQL_TEXT).toContain('RT-1498');
    expect(SQL_TEXT).toContain('§A2');
    expect(SQL_TEXT).toContain('Rollback');
    expect(SQL_TEXT).toContain('SchemaAheadError');
    expect(SQL_TEXT).toContain('trg_return_journal_dispositions_origin_four_eyes');
  });

  it('creates return_journal_origin empty and adds only trg_return_journal_dispositions_origin_four_eyes', () => {
    const statements = SQL_TEXT.split(/\r?\n/u)
      .filter((line) => !line.startsWith('--'))
      .join(' ');
    expect(statements).not.toMatch(/ALTER TABLE|DROP TABLE|INSERT INTO|DELETE FROM/i);
    expect(SQL_TEXT.match(/CREATE TABLE IF NOT EXISTS /g)).toHaveLength(1);
    expect(SQL_TEXT.match(/CREATE TRIGGER IF NOT EXISTS /g)).toHaveLength(3);
    const db = cloneMigratedDb();
    expect(db.exec('SELECT COUNT(*) FROM return_journal_origin')[0]?.values[0]?.[0]).toBe(0);
    const dispositionTriggers = db
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'return_journal_dispositions' ORDER BY name",
      )[0]
      ?.values.map((r) => r[0]);
    expect(dispositionTriggers).toEqual([
      'trg_return_journal_dispositions_approval',
      'trg_return_journal_dispositions_header',
      'trg_return_journal_dispositions_no_delete',
      'trg_return_journal_dispositions_no_update',
      'trg_return_journal_dispositions_origin_four_eyes',
    ]);
    db.close();
  });

  it('enforces originator four-eyes via trg_return_journal_dispositions_origin_four_eyes while permitting legacy rows', () => {
    const db = cloneMigratedDb();
    const retOrig = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
    const retLegacy = '0190f5a2-7b3c-7d4e-8f90-0000000000e2';
    insertMinimalJournal(db, retOrig, 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000011');
    insertMinimalJournal(db, retLegacy, 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000012');
    db.run(
      `INSERT INTO return_journal_origin VALUES (?, 'user-orig', '2026-11-27T10:00:00.000Z')`,
      [retOrig],
    );

    const seedApproval = (approvalId: string, returnId: string, approverUserId: string): void => {
      db.run(
        `INSERT INTO manager_approvals
           (approval_id, tenant_id, branch_id, terminal_id, action_kind, subject_ref, subject_version,
            amount_minor, reason_code, requester_operator_id, requester_user_id, approver_user_id,
            policy_version, issued_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, 'return.resolve_unknown', ?, 'escalate|unknown|1',
           1500, 'escalate_unknown', 'op-req', 'user-req', ?, 'rt114-2026-10-07',
           '2026-11-27T10:00:00.000Z', '2026-11-27T10:02:00.000Z', '2026-11-27T10:01:00.000Z')`,
        [
          approvalId,
          SCOPE.tenantId,
          SCOPE.branchId,
          SCOPE.terminalId,
          `${returnId}_escalate`,
          approverUserId,
        ],
      );
    };

    const origApp = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
    const thirdApp = '0190f5a2-7b3c-7d4e-8f90-0000000000a2';
    const legacyApp = '0190f5a2-7b3c-7d4e-8f90-0000000000a3';
    seedApproval(origApp, retOrig, 'USER-ORIG');
    seedApproval(thirdApp, retOrig, 'user-third');
    seedApproval(legacyApp, retLegacy, 'user-orig');

    expect(() =>
      db.run(
        `INSERT INTO return_journal_dispositions
           (disposition_id, return_id, kind, verdict_source, reason, approval_id, actor_operator_id, created_at)
         VALUES ('0192f5a2-3b4c-7d8e-9f01-0000000000d1', ?, 'needs_support', 'operator', 'operator', ?, 'op-req', '2026-11-27T10:01:00.000Z')`,
        [retOrig, origApp],
      ),
    ).toThrow(/approver cannot be the return originator/);

    db.run(
      `INSERT INTO return_journal_dispositions
         (disposition_id, return_id, kind, verdict_source, reason, approval_id, actor_operator_id, created_at)
       VALUES ('0192f5a2-3b4c-7d8e-9f01-0000000000d2', ?, 'needs_support', 'operator', 'operator', ?, 'op-req', '2026-11-27T10:01:00.000Z')`,
      [retOrig, thirdApp],
    );
    db.run(
      `INSERT INTO return_journal_dispositions
         (disposition_id, return_id, kind, verdict_source, reason, approval_id, actor_operator_id, created_at)
       VALUES ('0192f5a2-3b4c-7d8e-9f01-0000000000d3', ?, 'needs_support', 'operator', 'operator', ?, 'op-req', '2026-11-27T10:01:00.000Z')`,
      [retLegacy, legacyApp],
    );
    expect(db.exec('SELECT COUNT(*) FROM return_journal_dispositions')[0]?.values[0]?.[0]).toBe(2);
    db.close();
  });

  it('enforces FK to return_journal, lower-case non-empty origin_user_id, and append-only immutability', () => {
    const db = cloneMigratedDb();
    expect(() =>
      db.run(
        `INSERT INTO return_journal_origin VALUES ('missing-ret', 'user-a', '2026-11-27T10:00:00.000Z')`,
      ),
    ).toThrow();

    insertMinimalJournal(db, 'ret-1');
    expect(() =>
      db.run(`INSERT INTO return_journal_origin VALUES ('ret-1', '', '2026-11-27T10:00:00.000Z')`),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO return_journal_origin VALUES ('ret-1', 'USER-A', '2026-11-27T10:00:00.000Z')`,
      ),
    ).toThrow();
    expect(() =>
      db.run(`INSERT INTO return_journal_origin VALUES ('ret-1', 'user-a', '')`),
    ).toThrow();

    db.run(
      `INSERT INTO return_journal_origin VALUES ('ret-1', 'user-a', '2026-11-27T10:00:00.000Z')`,
    );
    expect(() =>
      db.run(
        `INSERT INTO return_journal_origin VALUES ('ret-1', 'user-b', '2026-11-27T10:01:00.000Z')`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        `UPDATE return_journal_origin SET origin_user_id = 'user-b' WHERE return_id = 'ret-1'`,
      ),
    ).toThrow(/immutable/);
    expect(() => db.run(`DELETE FROM return_journal_origin WHERE return_id = 'ret-1'`)).toThrow(
      /append-only/,
    );
    db.close();
  });

  it('upgrades a populated pre-0073 database leaving legacy return_journal rows with no origin row', () => {
    const db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    const all = readMigrationsFromDisk(MIGRATIONS_DIR);
    runMigrations({
      db: bindMigrationsDb(handleFor(db)),
      files: all.filter((f) => f.name < MIGRATION),
    });
    insertMinimalJournal(db, 'legacy-ret');

    runMigrations({
      db: bindMigrationsDb(handleFor(db)),
      files: all.filter((f) => f.name <= MIGRATION),
    });
    expect(db.exec('SELECT COUNT(*) FROM return_journal_origin')[0]?.values[0]?.[0]).toBe(0);
    db.close();
  });

  it('triggers SchemaAheadError when an older build sees 0073 already applied', () => {
    const db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    const all = readMigrationsFromDisk(MIGRATIONS_DIR);
    runMigrations({
      db: bindMigrationsDb(handleFor(db)),
      files: all.filter((f) => f.name <= MIGRATION),
    });
    const olderFiles = all.filter((f) => f.name < MIGRATION);
    expect(() => {
      runMigrations({ db: bindMigrationsDb(handleFor(db)), files: olderFiles });
    }).toThrow(SchemaAheadError);
    db.close();
  });
});
