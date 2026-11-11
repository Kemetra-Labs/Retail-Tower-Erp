import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DatabaseOpenError } from '../../db/client.js';
import { SecretStoreUnavailableError } from '../../secrets/index.js';
import {
  classifyStartupFailure,
  refuseFatalStartup,
  showRefusalAndExit,
  type RefusalDialog,
} from '../startup-failure.js';

/**
 * RT-1324 (RT-1125 R-39) — a till that cannot start must say why. Before this,
 * every startup failure except SchemaAheadError reached `console.error` and
 * `app.exit(1)` with no window: the cashier saw the till vanish.
 */

const USER_DATA = path.join('C:', 'Users', 'till', 'AppData', 'Roaming', 'pos-pulse');
const BACKUPS = path.join(USER_DATA, 'backups');
const ARABIC = /[\u0600-\u06FF]/;

function sqliteError(code: string): Error {
  return Object.assign(new Error(`sqlite says ${code}`), { code });
}

function harness(showMessageBox: RefusalDialog['showMessageBox'] = () => Promise.resolve({})) {
  const exit = vi.fn();
  const closeDb = vi.fn();
  const logError = vi.fn();
  const dialog = { showMessageBox: vi.fn(showMessageBox) };
  const app = { getPath: vi.fn((): string => USER_DATA), exit };
  return { exit, closeDb, logError, dialog, app };
}

/** Let the dialog promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('classifyStartupFailure', () => {
  it('maps a DatabaseOpenError to database_open with its SQLite code', () => {
    expect(classifyStartupFailure(new DatabaseOpenError(sqliteError('SQLITE_CORRUPT')))).toEqual({
      failureClass: 'database_open',
      code: 'SQLITE_CORRUPT',
    });
  });

  it('maps a full disk to disk_full at any stage (SQLITE_FULL or ENOSPC)', () => {
    expect(classifyStartupFailure(new DatabaseOpenError(sqliteError('SQLITE_FULL')))).toEqual({
      failureClass: 'disk_full',
      code: 'SQLITE_FULL',
    });
    expect(classifyStartupFailure(sqliteError('ENOSPC'), 'database_migration')).toEqual({
      failureClass: 'disk_full',
      code: 'ENOSPC',
    });
  });

  it('maps the SecretStore production refusal to secret_store', () => {
    expect(classifyStartupFailure(new SecretStoreUnavailableError()).failureClass).toBe(
      'secret_store',
    );
  });

  it('uses the stage fallback for an untyped error', () => {
    expect(classifyStartupFailure(sqliteError('SQLITE_CONSTRAINT'), 'database_migration')).toEqual({
      failureClass: 'database_migration',
      code: 'SQLITE_CONSTRAINT',
    });
    expect(classifyStartupFailure(new Error('boom'))).toEqual({
      failureClass: 'unknown',
      code: undefined,
    });
    expect(classifyStartupFailure('not even an error')).toEqual({
      failureClass: 'unknown',
      code: undefined,
    });
  });

  it('drops a code that is not a plain machine code', () => {
    const err = Object.assign(new Error('x'), { code: 'C:\\Users\\someone\\file.db' });
    expect(classifyStartupFailure(err).code).toBeUndefined();
  });
});

describe('refuseFatalStartup', () => {
  it.each([
    ['database_open', new DatabaseOpenError(sqliteError('SQLITE_NOTADB')), 'SQLITE_NOTADB'],
    ['disk_full', new DatabaseOpenError(sqliteError('SQLITE_FULL')), 'SQLITE_FULL'],
    ['secret_store', new SecretStoreUnavailableError(), undefined],
    ['unknown', new Error('logger failed'), undefined],
  ])('%s: closes the DB, shows the refusal dialog, then exits 1', async (cls, err, code) => {
    const h = harness();

    refuseFatalStartup(err, h);
    expect(h.closeDb).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled(); // not before the operator has read it
    await settle();

    expect(h.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const shown = h.dialog.showMessageBox.mock.calls.at(0)?.[0];
    expect(shown?.type).toBe('error');
    expect(shown?.title).toMatch(ARABIC);
    expect(shown?.message).toContain(cls);
    if (code) expect(shown?.message).toContain(code);
    expect(shown?.message).toContain(BACKUPS);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.logError).toHaveBeenCalledWith('[pos-pulse] fatal startup error:', err);
  });

  it('still exits when the dialog rejects', async () => {
    const h = harness(() => Promise.reject(new Error('no display')));

    refuseFatalStartup(new Error('boom'), h);
    await settle();

    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('still shows the dialog and exits when closing the DB throws', async () => {
    const h = harness();
    h.closeDb.mockImplementation(() => {
      throw new Error('close failed');
    });

    refuseFatalStartup(new Error('boom'), h);
    await settle();

    expect(h.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('still shows the dialog, without a folder, when userData cannot be resolved', async () => {
    const h = harness();
    h.app.getPath.mockImplementation(() => {
      throw new Error('not ready');
    });

    refuseFatalStartup(new Error('boom'), h);
    await settle();

    expect(h.dialog.showMessageBox.mock.calls.at(0)?.[0].message).not.toContain('backups');
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits at once when the dialog itself throws synchronously', () => {
    const h = harness(() => {
      throw new Error('dialog unavailable');
    });

    refuseFatalStartup(new Error('boom'), h);

    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('showRefusalAndExit', () => {
  it('shows the given refusal as an error dialog, then exits 1', async () => {
    const h = harness();

    showRefusalAndExit({ title: 'T', body: 'B' }, h);
    expect(h.exit).not.toHaveBeenCalled();
    await settle();

    expect(h.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      title: 'T',
      message: 'B',
    });
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
