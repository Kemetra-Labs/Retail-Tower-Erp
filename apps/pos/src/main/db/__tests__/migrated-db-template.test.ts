/**
 * RT-1269 — the shared migrated-DB template fixture.
 *
 * The four sql.js fixtures (catalogue, offline grant, sales sync, real payments
 * core) used to replay all of `migrations/*.sql` for every fresh database. They
 * now clone one template built once per test file. These tests pin that a clone
 * is indistinguishable from a fresh replay, so swapping the mechanism cannot
 * change what any fixture-based test sees.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  cloneMigratedDb,
  initMigratedDbTemplate,
} from './__helpers__/migrated-db.js';

const REPO_MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../migrations',
);

/** The pre-RT-1269 fixture behaviour: replay every migration into a new database. */
async function freshReplay(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  const files = readdirSync(REPO_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  for (const name of files) db.exec(readFileSync(path.join(REPO_MIGRATIONS, name), 'utf8'));
  return db;
}

/** Every schema object (type, name, table, DDL) except SQLite's internal autoindexes, sorted. */
function schemaOf(db: SqlJsDatabase): unknown[][] {
  const res = db.exec(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name",
  );
  return res[0]?.values ?? [];
}

/** Every row of `table`, order-independent (some tables have no rowid order to rely on). */
function rowsOf(db: SqlJsDatabase, table: string): string[] {
  const values = db.exec(`SELECT * FROM "${table}"`)[0]?.values ?? [];
  return values.map((row) => JSON.stringify(row)).sort();
}

/** The first column of the first row `sql` returns, or `undefined` when there is none. */
function scalar(db: SqlJsDatabase, sql: string): unknown {
  return db.exec(sql)[0]?.values[0]?.[0];
}

describe('migrated-db template (RT-1269)', () => {
  beforeAll(async () => {
    await initMigratedDbTemplate();
  });

  it('points at the repository migrations directory', () => {
    expect(path.resolve(MIGRATIONS_DIR)).toBe(REPO_MIGRATIONS);
  });

  it('gives a clone the same schema as a fresh replay of every migration', async () => {
    const replay = await freshReplay();
    const clone = cloneMigratedDb();
    expect(schemaOf(clone)).toEqual(schemaOf(replay));
    expect(schemaOf(clone).length).toBeGreaterThan(0);
    replay.close();
    clone.close();
  });

  it('gives a clone the same row contents and user_version as a fresh replay', async () => {
    const replay = await freshReplay();
    const clone = cloneMigratedDb();
    expect(scalar(clone, 'PRAGMA user_version')).toBe(scalar(replay, 'PRAGMA user_version'));
    for (const [, table] of schemaOf(replay).filter(([type]) => type === 'table')) {
      expect(rowsOf(clone, String(table)), String(table)).toEqual(rowsOf(replay, String(table)));
    }
    replay.close();
    clone.close();
  });

  it('turns foreign key enforcement on in every clone', () => {
    const clone = cloneMigratedDb();
    expect(scalar(clone, 'PRAGMA foreign_keys')).toBe(1);
    clone.close();
  });

  // A clone re-applies only `foreign_keys`. Any other connection-level PRAGMA a
  // migration sets would hold on a fresh replay but not on a clone, so a new one
  // must fail here and force the template to be revisited.
  it('relies on migrations setting no connection PRAGMA other than foreign_keys', () => {
    const allowed = new Set(['foreign_keys', 'foreign_key_check']);
    const used = readdirSync(REPO_MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => {
        const sql = readFileSync(path.join(REPO_MIGRATIONS, f), 'utf8').replace(/--.*$/gm, '');
        return [...sql.matchAll(/\bPRAGMA\s+(\w+)/gi)].map((m) => `${f}: ${String(m[1])}`);
      });
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((u) => !allowed.has(u.split(': ')[1]?.toLowerCase() ?? ''))).toEqual([]);
  });

  it('isolates clones: a write in one is invisible to the next', () => {
    const first = cloneMigratedDb();
    first.exec('CREATE TABLE rt1269_probe (id INTEGER PRIMARY KEY)');
    first.exec('INSERT INTO rt1269_probe (id) VALUES (1)');
    first.close();
    const second = cloneMigratedDb();
    expect(scalar(second, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'rt1269_probe'")).toBe(
      0,
    );
  });
});
