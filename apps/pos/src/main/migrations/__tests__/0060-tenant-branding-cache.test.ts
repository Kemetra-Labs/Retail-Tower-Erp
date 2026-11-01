/**
 * RT-475 — migration-shape test for `0060_tenant_branding_cache` (spec 039
 * FR-31, §A2 record `docs/security-review/RT-475/a2-migration-0060.md`):
 *   • the number right after 0059, and only it;
 *   • two additive single-row tables, nothing existing altered, shipped empty;
 *   • the CHECKs keep a row well-formed;
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
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0060_tenant_branding_cache';
const NAME = 'tenant_branding_name';
const LOGO = 'tenant_branding_logo';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const HEX = 'a'.repeat(64);

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

function insertName(over: Partial<Record<string, string | number>> = {}): void {
  db.run(
    `INSERT INTO ${NAME} (id, tenant_id, paired_at, tenant_display_name, revision, etag,
       logo_state, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      over.id ?? 1,
      over.tenant_id ?? 't-1',
      over.paired_at ?? 100,
      over.tenant_display_name ?? 'Al Nour',
      over.revision ?? 1,
      over.etag ?? `"${HEX}"`,
      over.logo_state ?? 'present',
      '2026-11-01T09:00:00.000Z',
    ],
  );
}

function insertLogo(over: Partial<Record<string, string | number>> = {}): void {
  db.run(
    `INSERT INTO ${LOGO} (id, tenant_id, revision, version, updated_at, card, warnings_json,
       renditions_json, payload_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      over.id ?? 1,
      over.tenant_id ?? 't-1',
      over.revision ?? 1,
      over.version ?? HEX,
      '2026-11-01T08:00:00.000Z',
      over.card ?? 0,
      '[]',
      '{}',
      over.payload_sha256 ?? HEX,
    ],
  );
}

describe('0060 — tenant branding cache (RT-475)', () => {
  it('is the only migration numbered 0060, right after 0059', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0060_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe('0059_shift_count_attempts.sql');
  });

  it('creates two tables and alters nothing that exists', () => {
    const code = SQL_TEXT.replace(/--.*$/gm, '');
    expect(code.match(/^CREATE TABLE .*$/gm)).toEqual([
      `CREATE TABLE IF NOT EXISTS ${NAME} (`,
      `CREATE TABLE IF NOT EXISTS ${LOGO} (`,
    ]);
    expect(code).not.toMatch(/ALTER|DROP|UPDATE\s+\w+\s+SET|DELETE FROM/i);
    expect(columns(NAME)).toEqual([
      'id',
      'tenant_id',
      'paired_at',
      'tenant_display_name',
      'revision',
      'etag',
      'logo_state',
      'fetched_at',
    ]);
    expect(columns(LOGO)).toContain('payload_sha256');
  });

  it('carries the [GATED] note, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('spec 039');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
  });

  it('ships empty', () => {
    expect(db.exec(`SELECT * FROM ${NAME}`)).toEqual([]);
    expect(db.exec(`SELECT * FROM ${LOGO}`)).toEqual([]);
  });

  it('holds one row per table', () => {
    insertName();
    insertLogo();
    expect(() => {
      insertName({ id: 2 });
    }).toThrow(/CHECK/);
    expect(() => {
      insertLogo({ id: 2 });
    }).toThrow(/CHECK/);
  });

  it('refuses a malformed row', () => {
    expect(() => {
      insertName({ logo_state: 'maybe' });
    }).toThrow(/CHECK/);
    expect(() => {
      insertName({ tenant_id: '' });
    }).toThrow(/CHECK/);
    expect(() => {
      insertLogo({ revision: 0 });
    }).toThrow(/CHECK/);
    expect(() => {
      insertLogo({ version: 'short' });
    }).toThrow(/CHECK/);
    expect(() => {
      insertLogo({ card: 2 });
    }).toThrow(/CHECK/);
  });

  it('applies exactly once through the real runner', () => {
    db.exec(`DROP TABLE ${NAME}; DROP TABLE ${LOGO};`);
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
    expect(columns(NAME)).toContain('logo_state');
  });
});
