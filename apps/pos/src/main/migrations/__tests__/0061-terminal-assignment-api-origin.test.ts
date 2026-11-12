/**
 * RT-1348 (RT-1345 S3, D3) — migration-shape test for
 * `0061_terminal_assignment_api_origin`.
 *
 * Runs the real 0003 / 0027 / 0042 then 0061 against sql.js (SQLite proper) and
 * asserts the migration only adds a nullable `api_origin` TEXT column:
 *   • it upgrades a database that has no such column and is the number right
 *     after 0060;
 *   • the pre-existing pairing row survives unchanged and reads NULL (a legacy
 *     pairing adopts the origin at runtime, not here);
 *   • the column accepts a non-empty text origin and NULL, and refuses an empty
 *     string and a BLOB;
 *   • a re-pair (`INSERT OR REPLACE`) writes the origin it is given;
 *   • through the real runner it applies exactly once.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

import { runMigrations, type MigrationFile, type MigrationsDb } from '../../db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'migrations');

const MIGRATION_FILES = {
  assignment: '0003_terminal_assignment',
  extend: '0027_extend_terminal_assignment',
  deviceRevoked: '0042_terminal_assignment_device_revoked',
  apiOrigin: '0061_terminal_assignment_api_origin',
} as const;
type MigrationKey = keyof typeof MIGRATION_FILES;

const PREREQS: readonly MigrationKey[] = ['assignment', 'extend', 'deviceRevoked'];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

let SQL: SqlJsStatic | undefined;
let db: SqlJsDatabase;

function readMigration(key: MigrationKey): MigrationFile {
  const name = MIGRATION_FILES[key];
  return { name, sql: readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8') };
}

function applyMigration(key: MigrationKey): void {
  db.exec(readMigration(key).sql);
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  if (SQL === undefined) throw new Error('initSqlJs() must complete first');
  db = new SQL.Database();
  PREREQS.forEach(applyMigration);
});

afterEach(() => {
  db.close();
});

/** The pre-0061 store write: INSERT OR REPLACE of the single row, no origin column. */
function writeLegacyPairing(terminalId: string): void {
  db.run(
    `INSERT OR REPLACE INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id)
     VALUES (1, 't1', 'b1', ?, 'Till 1', 1700000000, 'Branch', 'Addr', 'TRN')`,
    [terminalId],
  );
}

function writePairingWithOrigin(terminalId: string, origin: string | null): void {
  db.run(
    `INSERT OR REPLACE INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id, api_origin)
     VALUES (1, 't1', 'b1', ?, 'Till 1', 1700000000, 'Branch', 'Addr', 'TRN', ?)`,
    [terminalId, origin],
  );
}

function setOrigin(value: unknown): void {
  db.run('UPDATE terminal_assignment SET api_origin = ? WHERE id = 1', [
    value as number | string | null,
  ]);
}

function firstResult(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

const rows = (): unknown[][] => firstResult('SELECT * FROM terminal_assignment');
const origin = (): unknown =>
  firstResult('SELECT api_origin FROM terminal_assignment WHERE id = 1')[0]?.[0];

function columns(): ColumnInfo[] {
  return firstResult('PRAGMA table_info(terminal_assignment)').map((r) => ({
    name: r[1] as string,
    type: r[2] as string,
    notnull: r[3] as number,
    pk: r[5] as number,
  }));
}

function sqlJsRunnerDb(recorded: { names: string[] }): MigrationsDb {
  return {
    exec: db.exec.bind(db),
    listAppliedNames: () =>
      firstResult('SELECT name FROM schema_migrations').map((r) => r[0] as string),
    recordApplied: (row) => {
      recorded.names.push(row.name);
      db.run('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)', [
        row.name,
        row.applied_at,
        row.checksum,
      ]);
    },
    transaction: (fn) => {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

describe('0061 — terminal_assignment.api_origin (RT-1348)', () => {
  it('takes the number right after 0060, and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION_FILES.apiOrigin}.sql`);
    expect(names[i - 1]).toBe('0060_tenant_branding_cache.sql');
    expect(names.filter((n) => n.startsWith('0061_'))).toEqual([
      `${MIGRATION_FILES.apiOrigin}.sql`,
    ]);
  });

  it('upgrades a database without the column: adds a nullable TEXT column, last', () => {
    expect(columns().some((c) => c.name === 'api_origin')).toBe(false);
    const before = columns();
    applyMigration('apiOrigin');
    const after = columns();
    expect(after.slice(0, -1)).toEqual(before);
    const col = after.at(-1);
    expect(col?.name).toBe('api_origin');
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(col?.pk).toBe(0);
  });

  it('keeps an existing (legacy) pairing row byte-identical, with api_origin NULL', () => {
    writeLegacyPairing('term-1');
    const before = rows();
    applyMigration('apiOrigin');
    const after = rows();
    expect(after.map((r) => r.slice(0, -1))).toEqual(before);
    expect(origin()).toBeNull();
  });

  it('accepts a non-empty text origin and NULL', () => {
    applyMigration('apiOrigin');
    writePairingWithOrigin('term-1', 'https://api.example.com');
    expect(origin()).toBe('https://api.example.com');
    setOrigin(null);
    expect(origin()).toBeNull();
  });

  it('refuses an empty string', () => {
    applyMigration('apiOrigin');
    writePairingWithOrigin('term-1', 'https://api.example.com');
    expect(() => {
      setOrigin('');
    }).toThrow(/CHECK constraint failed/);
  });

  it('refuses a BLOB (TEXT affinity would coerce a number, so only a BLOB is not text)', () => {
    applyMigration('apiOrigin');
    writePairingWithOrigin('term-1', 'https://api.example.com');
    expect(() => {
      db.run("UPDATE terminal_assignment SET api_origin = x'6162' WHERE id = 1");
    }).toThrow(/CHECK constraint failed/);
  });

  it('a re-pair (INSERT OR REPLACE) writes the origin it is given, replacing the old one', () => {
    applyMigration('apiOrigin');
    writePairingWithOrigin('term-1', 'https://a.example');
    writePairingWithOrigin('term-2', 'https://b.example');
    expect(origin()).toBe('https://b.example');
  });

  it('applies exactly once through the real runner (re-run is a no-op)', () => {
    const recorded = { names: [] as string[] };
    const runnerDb = sqlJsRunnerDb(recorded);
    const files = [readMigration('apiOrigin')];
    runMigrations({ db: runnerDb, files });
    expect(() => {
      runMigrations({ db: runnerDb, files });
    }).not.toThrow();
    expect(recorded.names).toEqual([MIGRATION_FILES.apiOrigin]);
    expect(columns().filter((c) => c.name === 'api_origin')).toHaveLength(1);
  });

  it('is not file-level idempotent on its own (the runner is the guard)', () => {
    applyMigration('apiOrigin');
    expect(() => {
      applyMigration('apiOrigin');
    }).toThrow(/duplicate column name/);
  });
});
