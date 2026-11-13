/**
 * RT-1379 — migration-shape test for `0062_sale_capture_cutover` (RT-1377 decision,
 * Confluence 77168641, O-1 option B, Rule 3: the capture instant arrives with a migration).
 *   • the number right after 0061, and only it;
 *   • one table and its two append-only triggers, nothing altered;
 *   • one row at most; closed `source`; non-empty instants;
 *   • UPDATE and DELETE are refused; ON CONFLICT DO NOTHING keeps the first row;
 *   • an older build refuses a database that holds 0062 (RT-320);
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
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../db/__tests__/__helpers__/migrated-db.js';

const MIGRATION = '0062_sale_capture_cutover';
const TABLE = 'sale_capture_cutover';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

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

function insert(
  over: Partial<Record<'id' | 'tenders' | 'receipt' | 'at' | 'source', string | number>> = {},
): void {
  db.run(
    `INSERT INTO ${TABLE} (id, tenders_since, receipt_since, recorded_at, source)
     VALUES (?, ?, ?, ?, ?)`,
    [
      over.id ?? 1,
      over.tenders ?? '2026-11-13T12:00:00.000Z',
      over.receipt ?? '2026-11-13T12:00:00.000Z',
      over.at ?? '2026-11-13T12:00:00.000Z',
      over.source ?? 'first_start',
    ],
  );
}

function rows(): unknown[][] {
  return db.exec(`SELECT * FROM ${TABLE}`)[0]?.values ?? [];
}

/** A `MigrationsDb` over the sql.js handle, as `bindMigrationsDb` gives production. */
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

describe('0062 — sale capture cutover (RT-1379, RT-1377 Rule 3)', () => {
  it('is the only migration numbered 0062, right after 0061', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'));
    expect(names.filter((n) => n.startsWith('0062_'))).toEqual([`${MIGRATION}.sql`]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(sorted[sorted.indexOf(`${MIGRATION}.sql`) - 1]).toBe(
      '0061_terminal_assignment_api_origin.sql',
    );
  });

  it('creates one table and its two triggers, and alters nothing', () => {
    const creates = SQL_TEXT.replace(/--.*$/gm, '').match(/^CREATE .*$/gm);
    expect(creates).toEqual([
      `CREATE TABLE IF NOT EXISTS ${TABLE} (`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_update`,
      `CREATE TRIGGER IF NOT EXISTS trg_${TABLE}_no_delete`,
    ]);
    expect(SQL_TEXT.replace(/--.*$/gm, '')).not.toMatch(
      /ALTER|DROP|UPDATE\s+\w+\s+SET|DELETE FROM|INSERT/i,
    );
    expect(columns()).toEqual(['id', 'tenders_since', 'receipt_since', 'recorded_at', 'source']);
  });

  it('carries the [GATED] authorization, the §A2 note and the rollback', () => {
    expect(SQL_TEXT).toContain('[GATED]');
    expect(SQL_TEXT).toContain('77168641');
    expect(SQL_TEXT).toContain('## §A2 migration safety');
    expect(SQL_TEXT).toContain('## Rollback');
    expect(SQL_TEXT).toContain(`DROP TABLE IF EXISTS ${TABLE};`);
  });

  it('ships empty', () => {
    expect(rows()).toEqual([]);
  });

  it('holds one row at most', () => {
    insert();
    expect(() => {
      insert({ id: 2 });
    }).toThrow(/CHECK/);
    expect(() => {
      insert({ tenders: '2027-01-01T00:00:00.000Z' });
    }).toThrow(/UNIQUE|PRIMARY/);
    expect(rows()).toHaveLength(1);
  });

  it('holds only a closed source and non-empty instants', () => {
    for (const over of [
      { source: 'manual' },
      { source: '' },
      { tenders: '' },
      { receipt: '' },
      { at: '' },
    ]) {
      expect(() => {
        insert(over);
      }, JSON.stringify(over)).toThrow(/CHECK/);
    }
    insert({ source: 'env_seed' });
    expect(rows()).toHaveLength(1);
  });

  it('refuses UPDATE and DELETE; a repeat insert with ON CONFLICT DO NOTHING keeps the first row', () => {
    insert();
    expect(() => {
      db.run(`UPDATE ${TABLE} SET tenders_since = '2030-01-01T00:00:00.000Z'`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`UPDATE ${TABLE} SET source = source`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`DELETE FROM ${TABLE}`);
    }).toThrow(/append-only/);
    db.run(
      `INSERT INTO ${TABLE} (id, tenders_since, receipt_since, recorded_at, source)
       VALUES (1, 'x', 'x', 'x', 'env_seed') ON CONFLICT (id) DO NOTHING`,
    );
    expect(rows()).toEqual([
      [
        1,
        '2026-11-13T12:00:00.000Z',
        '2026-11-13T12:00:00.000Z',
        '2026-11-13T12:00:00.000Z',
        'first_start',
      ],
    ]);
  });

  it('the real runner applies it once; an older build (without 0062) then refuses the database (RT-320)', async () => {
    const SQL = (await import('sql.js')).default;
    const engine = await SQL();
    const raw = new engine.Database();
    try {
      const mdb = migrationsDbOf(raw);
      const files = shippedFiles();
      runMigrations({ db: mdb, files });
      expect(mdb.listAppliedNames()).toContain(MIGRATION);
      // Re-running the same build applies nothing new.
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
