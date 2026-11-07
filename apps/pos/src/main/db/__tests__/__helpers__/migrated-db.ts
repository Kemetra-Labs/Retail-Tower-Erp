/**
 * RT-1269 — one migrated sql.js database template per test file.
 *
 * Every `migrations/*.sql` file is replayed ONCE into a template (with
 * `PRAGMA foreign_keys = ON`, as production's client sets it), exported to
 * bytes, and each `cloneMigratedDb()` opens an independent copy of those bytes.
 * A clone matches a fresh replay (schema, seeded rows, `user_version`) at a
 * fraction of the cost; `migrated-db-template.test.ts` pins that equivalence.
 *
 * This is the single declared place where test fixtures read the migrations
 * directory. It lives under `src/` so it stays inside the main tsconfig
 * `rootDir` (cross-rootDir test-helper imports break `tsc`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

// __tests__/__helpers__ → db → main → src → app root
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

let SQL: SqlJsStatic | undefined;
let template: Uint8Array | undefined;

/** Build the template once. Await it in a `beforeAll` before `cloneMigratedDb()`. */
export async function initMigratedDbTemplate(): Promise<void> {
  if (template !== undefined) return;
  SQL ??= await initSqlJs();
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  for (const name of files) db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  template = db.export();
  db.close();
}

/** Whether `initMigratedDbTemplate()` has completed. */
export function isMigratedDbTemplateReady(): boolean {
  return template !== undefined;
}

/** A new, independent database with every migration applied and foreign keys on. */
export function cloneMigratedDb(): SqlJsDatabase {
  if (SQL === undefined || template === undefined) {
    throw new Error('await initMigratedDbTemplate() in beforeAll before cloneMigratedDb()');
  }
  const db = new SQL.Database(template);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
