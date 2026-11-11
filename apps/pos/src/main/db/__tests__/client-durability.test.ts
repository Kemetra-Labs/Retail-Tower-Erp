import { describe, expect, it, vi } from 'vitest';

import {
  DatabaseOpenError,
  openDatabase,
  readSynchronous,
  type DatabaseFactory,
  type DatabaseHandle,
} from '../client.js';

/**
 * RT-1324 (RT-1125 R-01) — a committed sale must survive a power cut.
 *
 * better-sqlite3 is built with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 (NORMAL): in
 * WAL mode a commit is then not synced to disk, so the last sales can be lost
 * on power loss. `openDatabase` is the only place the till opens a database
 * (see `single-open-site.test.ts`), so FULL set here covers every connection.
 */

function fakeDb(pragma: (sql: string, options?: { simple?: boolean }) => unknown): DatabaseHandle {
  return {
    pragma: vi.fn(pragma),
    prepare: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

function sqliteError(code: string): Error {
  return Object.assign(new Error(`sqlite says ${code}`), { code });
}

describe('openDatabase — durability (RT-1324)', () => {
  it('sets synchronous = FULL on the opened connection', () => {
    const calls: string[] = [];
    const db = fakeDb((sql) => {
      calls.push(sql);
      return [];
    });

    openDatabase('/tmp/test.db', () => db);

    expect(calls).toContain('synchronous = FULL');
  });

  it('sets WAL before synchronous, so FULL applies to the WAL journal', () => {
    const calls: string[] = [];
    openDatabase('/tmp/test.db', () =>
      fakeDb((sql) => {
        calls.push(sql);
        return [];
      }),
    );

    expect(calls.indexOf('journal_mode = WAL')).toBeLessThan(calls.indexOf('synchronous = FULL'));
  });

  it('reads back the effective synchronous level as a number', () => {
    const db = fakeDb((sql, options) => (sql === 'synchronous' && options?.simple ? 2 : []));

    expect(readSynchronous(db)).toBe(2);
  });
});

describe('openDatabase — open failures are typed (RT-1324, RT-1125 R-39)', () => {
  it('wraps a factory failure in DatabaseOpenError and keeps the SQLite code', () => {
    const cause = sqliteError('SQLITE_CANTOPEN');
    const factory: DatabaseFactory = () => {
      throw cause;
    };

    let thrown: unknown;
    try {
      openDatabase('/tmp/test.db', factory);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DatabaseOpenError);
    expect((thrown as DatabaseOpenError).code).toBe('SQLITE_CANTOPEN');
    expect((thrown as DatabaseOpenError).cause).toBe(cause);
  });

  it('closes the handle and throws DatabaseOpenError when a pragma fails (corrupt file)', () => {
    const close = vi.fn();
    const db = {
      ...fakeDb(() => {
        throw sqliteError('SQLITE_NOTADB');
      }),
      close,
    };

    expect(() => openDatabase('/tmp/test.db', () => db)).toThrow(DatabaseOpenError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still reports the open failure when closing the half-open handle also fails', () => {
    const db = {
      ...fakeDb(() => {
        throw sqliteError('SQLITE_BUSY');
      }),
      close: () => {
        throw new Error('close failed');
      },
    };

    expect(() => openDatabase('/tmp/test.db', () => db)).toThrow(DatabaseOpenError);
  });

  it('omits a code that is not a plain SQLite/OS code', () => {
    const factory: DatabaseFactory = () => {
      throw Object.assign(new Error('x'), { code: 'not a code; C:/secret/path' });
    };

    let thrown: unknown;
    try {
      openDatabase('/tmp/test.db', factory);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DatabaseOpenError);
    expect((thrown as DatabaseOpenError).code).toBeUndefined();
  });
});
