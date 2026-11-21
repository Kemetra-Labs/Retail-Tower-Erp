/**
 * RT-363 fix-forward — the one-tender-per-line capture instant, recorded once in the local
 * database (migration 0066), like the RT-1379 cutoffs.
 *
 *   • `decideTenderRefsSince`: no valid environment value = off; a valid one opts in, and the
 *     stored instant is max(value, now, newest parseable finalized_at + 1 ms), so it can never
 *     put an already-attempted sale on the other side.
 *   • `recordTenderRefsCutoverOnce`: no row without opt-in; written once; afterwards the stored
 *     row wins whatever the environment says (removed, lost, earlier, later or garbage).
 *   • `readTenderRefsSince`: what the engine and the quarantine uploader read.
 *
 * The DB cases run on the sql.js fixture with every migration applied (0066 included).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  TENDER_REFS_LOG,
  TENDER_REFS_SINCE_ENV,
  decideTenderRefsSince,
  readTenderRefsSince,
  recordTenderRefsCutoverOnce,
} from '../tender-refs-cutoff.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const NOW_MS = NOW.getTime();

describe('TENDER_REFS_SINCE_ENV', () => {
  it('is the variable the Jira issue names', () => {
    expect(TENDER_REFS_SINCE_ENV).toBe('POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE');
  });
});

describe('decideTenderRefsSince', () => {
  it('unset, blank, zone-less or garbage -> off', () => {
    for (const env of [undefined, '', '   ', 'garbage', '2026-12-01', '2026-12-01T00:00:00']) {
      expect(decideTenderRefsSince({ now: NOW, maxFinalizedAt: null, env })).toBeNull();
    }
  });

  it('a valid instant after now is kept, in its canonical UTC form', () => {
    expect(
      decideTenderRefsSince({ now: NOW, maxFinalizedAt: null, env: '2026-12-01T02:00:00+02:00' }),
    ).toBe('2026-12-01T00:00:00.000Z');
  });

  it('a valid instant before now is moved up to now (never earlier than the clock)', () => {
    expect(
      decideTenderRefsSince({ now: NOW, maxFinalizedAt: null, env: '2020-01-01T00:00:00Z' }),
    ).toBe('2026-11-21T12:00:00.000Z');
  });

  it('is moved past the newest sale, one millisecond later, even when that sale is ahead of the clock', () => {
    expect(
      decideTenderRefsSince({ now: NOW, maxFinalizedAt: NOW_MS, env: '2020-01-01T00:00:00Z' }),
    ).toBe('2026-11-21T12:00:00.001Z');
    expect(
      decideTenderRefsSince({
        now: NOW,
        maxFinalizedAt: NOW_MS + 5_000,
        env: '2020-01-01T00:00:00Z',
      }),
    ).toBe('2026-11-21T12:00:05.001Z');
  });

  it('a value later than every sale and the clock wins', () => {
    expect(
      decideTenderRefsSince({
        now: NOW,
        maxFinalizedAt: NOW_MS + 5_000,
        env: '2027-01-01T00:00:00Z',
      }),
    ).toBe('2027-01-01T00:00:00.000Z');
  });
});

function fakeLogger() {
  return { info: vi.fn<(msg: string) => void>(), warn: vi.fn<(msg: string) => void>() };
}

/** Every log call, as text, so a test can prove no instant reached a log line. */
function logged(logger: ReturnType<typeof fakeLogger>): string {
  return JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
}

describe('recordTenderRefsCutoverOnce / readTenderRefsSince — on the migrated database', () => {
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

  function rows(): unknown[][] {
    return db.exec('SELECT * FROM sale_tender_refs_cutover')[0]?.values ?? [];
  }

  function start(env: Record<string, string | undefined>, now = NOW) {
    const logger = fakeLogger();
    const since = recordTenderRefsCutoverOnce({ db: handleFor(db), env, now: () => now, logger });
    return { since, logger };
  }

  const ENV = (value: string | undefined) => ({ [TENDER_REFS_SINCE_ENV]: value });

  it('no environment value: nothing is recorded, nothing is logged, and the cutoff is off', () => {
    const { since, logger } = start({});
    expect(since).toBeNull();
    expect(rows()).toEqual([]);
    expect(logged(logger)).toBe('[[],[]]');
    expect(readTenderRefsSince(handleFor(db), fakeLogger())).toBeNull();
  });

  it('an invalid value: off, one warning without the value, nothing recorded', () => {
    const { since, logger } = start(ENV('2026-12-01'));
    expect(since).toBeNull();
    expect(rows()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(TENDER_REFS_LOG.unparseable);
    expect(logged(logger)).not.toContain('2026-12');
  });

  it('a valid value opts in: one row, source env_opt_in, the instant after now and every sale, logged without values', () => {
    seedSale(db, { sale_id: 's-1', finalized_at: '2026-11-21T11:00:00.000Z' });
    seedSale(db, { sale_id: 's-2', finalized_at: '2026-11-21T12:00:07.000Z' });
    seedSale(db, { sale_id: 's-3', finalized_at: 'not-a-date' });
    const { since, logger } = start(ENV('2020-01-01T00:00:00Z'));
    expect(since).toBe('2026-11-21T12:00:07.001Z');
    expect(rows()).toEqual([
      [1, '2026-11-21T12:00:07.001Z', '2026-11-21T12:00:00.000Z', 'env_opt_in'],
    ]);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(TENDER_REFS_LOG.recorded);
    expect(logged(logger)).not.toContain('12:00:07');
    expect(readTenderRefsSince(handleFor(db), fakeLogger())).toBe('2026-11-21T12:00:07.001Z');
  });

  it('a later start reads the same row, whatever the environment says now', () => {
    const first = start(ENV('2026-11-21T12:00:00Z')).since;
    expect(first).toBe('2026-11-21T12:00:00.000Z');
    const later = new Date('2027-06-01T00:00:00.000Z');

    // Removed (lost) variable: the stored instant stays, with nothing to warn about.
    const removed = start({}, later);
    expect(removed.since).toBe(first);
    expect(removed.logger.warn).not.toHaveBeenCalled();
    expect(removed.logger.info).not.toHaveBeenCalled();

    // The same variable, or an earlier one: already honoured, no warning.
    for (const value of ['2026-11-21T12:00:00Z', '2020-01-01T00:00:00Z']) {
      const same = start(ENV(value), later);
      expect(same.since).toBe(first);
      expect(same.logger.warn).not.toHaveBeenCalled();
    }

    // A later variable, or garbage: ignored, one warning, no write.
    for (const value of ['2030-01-01T00:00:00Z', 'garbage']) {
      const moved = start(ENV(value), later);
      expect(moved.since).toBe(first);
      expect(moved.logger.warn).toHaveBeenCalledExactlyOnceWith(TENDER_REFS_LOG.envIgnored);
      expect(logged(moved.logger)).not.toContain('2030');
    }
    expect(rows()).toEqual([[1, first, '2026-11-21T12:00:00.000Z', 'env_opt_in']]);
  });

  it('a read that throws is off with one warning (body-stable, like the 0062 read)', () => {
    const logger = fakeLogger();
    const broken = {
      prepare: () => {
        throw new Error('no such table: sale_tender_refs_cutover');
      },
    };
    expect(readTenderRefsSince(broken, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(TENDER_REFS_LOG.readFailedOff);
  });

  it('a malformed stored instant reads as off', () => {
    db.run(
      `INSERT INTO sale_tender_refs_cutover (id, tender_refs_since, recorded_at, source)
       VALUES (1, 'yesterday', '2026-11-21T12:00:00.000Z', 'env_opt_in')`,
    );
    const logger = fakeLogger();
    expect(readTenderRefsSince(handleFor(db), logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(TENDER_REFS_LOG.readFailedOff);
  });

  it('the row is append-only: the first start wins, a second write changes nothing', () => {
    start(ENV('2026-11-21T12:00:00Z'));
    expect(() => {
      db.run("UPDATE sale_tender_refs_cutover SET tender_refs_since = '2030-01-01T00:00:00.000Z'");
    }).toThrow(/append-only/);
  });
});
