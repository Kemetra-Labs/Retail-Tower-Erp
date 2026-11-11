import { describe, expect, it } from 'vitest';

import {
  STARTUP_FAILURE_CLASSES,
  describeStartupFailureRefusal,
} from '../startup-failure-refusal.js';

/**
 * RT-1324 — operator copy for a till that cannot start (UX-12.9 shape: what
 * happened, what is safe, what to do, then the evidence support needs).
 */

const BACKUPS = 'C:\\Users\\till\\AppData\\Roaming\\pos-pulse\\backups';
const ARABIC = /[\u0600-\u06FF]/;

describe('describeStartupFailureRefusal', () => {
  it.each(STARTUP_FAILURE_CLASSES)('%s: Arabic title and Arabic-first body', (failureClass) => {
    const refusal = describeStartupFailureRefusal({
      failure: { failureClass, code: 'SQLITE_IOERR' },
      backupsDir: BACKUPS,
    });

    expect(refusal.title).toMatch(ARABIC);
    expect(refusal.body.split('\n')[0]).toMatch(ARABIC);
  });

  it.each(STARTUP_FAILURE_CLASSES)(
    '%s: names the class, the code and the backups folder on lines of their own',
    (failureClass) => {
      const lines = describeStartupFailureRefusal({
        failure: { failureClass, code: 'SQLITE_IOERR' },
        backupsDir: BACKUPS,
      }).body.split('\n');

      expect(lines).toContain(`Startup failure: ${failureClass} (SQLITE_IOERR)`);
      expect(lines).toContain(`Backups folder: ${BACKUPS}`);
    },
  );

  it('gives each class its own first line', () => {
    const firstLines = STARTUP_FAILURE_CLASSES.map(
      (failureClass) =>
        describeStartupFailureRefusal({
          failure: { failureClass, code: undefined },
          backupsDir: BACKUPS,
        }).body.split('\n')[0],
    );
    expect(new Set(firstLines).size).toBe(STARTUP_FAILURE_CLASSES.length);
  });

  it('omits the code and the folder when they are unknown', () => {
    const body = describeStartupFailureRefusal({
      failure: { failureClass: 'unknown', code: undefined },
      backupsDir: undefined,
    }).body;

    expect(body).toContain('Startup failure: unknown');
    expect(body).not.toContain('(');
    expect(body).not.toContain('Backups folder');
  });

  it.each(STARTUP_FAILURE_CLASSES)(
    '%s: never offers a reset, restore or reinstall (the DB holds the pairing)',
    (failureClass) => {
      const body = describeStartupFailureRefusal({
        failure: { failureClass, code: undefined },
        backupsDir: BACKUPS,
      }).body;

      expect(body).not.toMatch(/reinstall|restore|reset/i);
      // Arabic: never "reinstall" (أعد تثبيت) or "restore" (استعادة / استعد).
      expect(body).not.toMatch(/أعد تثبيت|أعِد تثبيت|استعادة|استعد/);
    },
  );
});
