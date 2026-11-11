import BetterSqlite3 from 'better-sqlite3';

/**
 * T038 — DB client.
 *
 * Thin wrapper over better-sqlite3. Exists to:
 *   1. centralize the pragmas applied to every connection (WAL, synchronous,
 *      foreign_keys),
 *   2. expose a small, mockable surface (`DatabaseHandle`) so tests don't have
 *      to load the native binding (R1: better-sqlite3's binary is rebuilt for
 *      Electron's Node ABI by postinstall and won't load in Vitest's system Node).
 *
 * R2: dbPath is ALWAYS injected. This module never calls `app.getPath` —
 * that lookup happens at the wire-in seam in `src/main/index.ts`.
 *
 * RT-1324: this is the ONLY file that loads better-sqlite3
 * (`__tests__/single-open-site.test.ts`). `synchronous` is per connection, so a
 * second open site would silently get SQLite's NORMAL default back.
 */

export interface DatabaseHandle {
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): unknown;
  exec(sql: string): void;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

export type DatabaseFactory = (dbPath: string) => DatabaseHandle;

const defaultFactory: DatabaseFactory = (dbPath) =>
  new BetterSqlite3(dbPath) as unknown as DatabaseHandle;

/** A plain SQLite or OS error code; anything else (a path, free text) is dropped. */
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** The `code` of an error (better-sqlite3's `SqliteError`, Node's fs errors), if plain. */
export function machineCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && MACHINE_CODE.test(code) ? code : undefined;
}

/**
 * RT-1324 (RT-1125 R-39) — the till database could not be opened: a missing
 * folder, a locked or damaged file, a full disk. Typed so the startup refusal
 * can name the failure class. `code` is the SQLite code (`SQLITE_NOTADB`, …).
 */
export class DatabaseOpenError extends Error {
  readonly code: string | undefined;

  constructor(cause: unknown) {
    super('The till database could not be opened.', { cause });
    this.name = 'DatabaseOpenError';
    this.code = machineCodeOf(cause);
  }
}

/**
 * Open (or create) a SQLite database at `dbPath` and apply the pragmas every
 * pos-pulse connection requires:
 *   - journal_mode = WAL  (concurrent reads while a writer is mid-transaction)
 *   - synchronous = FULL  (RT-1324: better-sqlite3 is built with
 *     SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, i.e. NORMAL, where a WAL commit is not
 *     synced and a power cut can lose the last committed sales. FULL syncs the
 *     WAL on every commit. EXTRA adds nothing in WAL mode.)
 *   - foreign_keys = ON   (SQLite default is OFF; we want referential integrity)
 *
 * A damaged or locked file often fails at the first pragma, not in the
 * constructor, so both are wrapped: either throws `DatabaseOpenError`, and a
 * half-open handle is closed first.
 *
 * Pass a custom `factory` in tests to substitute the better-sqlite3 binding.
 */
export function openDatabase(
  dbPath: string,
  factory: DatabaseFactory = defaultFactory,
): DatabaseHandle {
  let db: DatabaseHandle;
  try {
    db = factory(dbPath);
  } catch (err) {
    throw new DatabaseOpenError(err);
  }
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
  } catch (err) {
    closeQuietly(db);
    throw new DatabaseOpenError(err);
  }
  return db;
}

/** The effective `synchronous` level (0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA), for the startup log. */
export function readSynchronous(db: DatabaseHandle): unknown {
  return db.pragma('synchronous', { simple: true });
}

function closeQuietly(db: DatabaseHandle): void {
  try {
    db.close();
  } catch {
    // The open failure is the one to report; a failing close adds nothing.
  }
}
