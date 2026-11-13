/**
 * RT-1379 (RT-1377 decision, Confluence 77168641, O-1 option B) — the tender and receipt
 * capture instant, recorded once in the local database.
 *
 *   • Acceptance 1 — `decideCutover` / `newestFinalizedAtMs`: Rule 1,
 *     `T = max(now, newest parseable finalized_at + 1 ms)`.
 *   • Acceptance 2 — seeding (Rule 2): valid env values are stored verbatim in their own
 *     column; the stored row wins afterwards and a difference logs `env_ignored`.
 *   • Acceptance 3 (read side) — a second start reads the same row.
 *
 * The DB cases run on the sql.js fixture with every migration applied (0062 included).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  CAPTURE_CUTOVER_LOG,
  RECEIPT_SINCE_ENV,
  TENDERS_SINCE_ENV,
  decideCutover,
  newestFinalizedAtMs,
  readCaptureCutover,
  readEngineCutoffs,
  recordCaptureCutoverOnce,
  type CaptureCutoverLogger,
} from '../capture-cutover.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const NOW_MS = NOW.getTime();

describe('decideCutover — Rule 1 (acceptance 1)', () => {
  it('an empty database gives T = now, for both columns, source first_start', () => {
    expect(decideCutover({ now: NOW, maxFinalizedAt: null })).toEqual({
      tendersSince: '2026-11-13T12:00:00.000Z',
      receiptSince: '2026-11-13T12:00:00.000Z',
      source: 'first_start',
      aheadOfClock: false,
    });
  });

  it('existing sales older than now give T = now', () => {
    const d = decideCutover({ now: NOW, maxFinalizedAt: NOW_MS - 60_000 });
    expect(d.tendersSince).toBe('2026-11-13T12:00:00.000Z');
    expect(d.aheadOfClock).toBe(false);
  });

  it('a sale finalized exactly at now pushes T one millisecond later', () => {
    const d = decideCutover({ now: NOW, maxFinalizedAt: NOW_MS });
    expect(d.tendersSince).toBe('2026-11-13T12:00:00.001Z');
    expect(d.receiptSince).toBe('2026-11-13T12:00:00.001Z');
    expect(d.aheadOfClock).toBe(true);
  });

  it('a newest finalized_at later than now (backward clock) gives T = that + 1 ms', () => {
    const d = decideCutover({ now: NOW, maxFinalizedAt: Date.parse('2026-11-13T12:00:05.000Z') });
    expect(d).toEqual({
      tendersSince: '2026-11-13T12:00:05.001Z',
      receiptSince: '2026-11-13T12:00:05.001Z',
      source: 'first_start',
      aheadOfClock: true,
    });
  });

  it('a computed receipt_since is never earlier than tenders_since', () => {
    // Tenders seeded in the future, receipt computed: receipt follows tenders.
    const d = decideCutover({
      now: NOW,
      maxFinalizedAt: null,
      envTenders: '2026-12-01T00:00:00Z',
    });
    expect(d.tendersSince).toBe('2026-12-01T00:00:00.000Z');
    expect(d.receiptSince).toBe('2026-12-01T00:00:00.000Z');
    expect(Date.parse(d.receiptSince)).toBeGreaterThanOrEqual(Date.parse(d.tendersSince));
  });
});

describe('newestFinalizedAtMs (acceptance 1)', () => {
  it('no sales -> null', () => {
    expect(newestFinalizedAtMs([])).toBeNull();
  });

  it('returns the newest instant in milliseconds, whatever the text order or zone form', () => {
    expect(
      newestFinalizedAtMs([
        '2026-11-13T12:00:00.000Z',
        '2026-11-13T14:30:00+02:00', // 12:30Z — the newest
        '2026-11-13T12:10:00.000Z',
      ]),
    ).toBe(Date.parse('2026-11-13T12:30:00.000Z'));
  });

  it('ignores unparseable finalized_at values (the per-sale test never sends them T/R either)', () => {
    expect(
      newestFinalizedAtMs(['zzz-not-a-date', '', '2026-11-13T11:00:00.000Z', '9999-99-99']),
    ).toBe(Date.parse('2026-11-13T11:00:00.000Z'));
    expect(newestFinalizedAtMs(['garbage'])).toBeNull();
  });
});

describe('decideCutover — Rule 2 seeds (acceptance 2)', () => {
  it('valid env values are stored verbatim, each in its own column, even receipt earlier than tenders', () => {
    const d = decideCutover({
      now: NOW,
      maxFinalizedAt: Date.parse('2026-11-13T13:00:00.000Z'),
      envTenders: '2026-10-01T00:00:00Z',
      envReceipt: '2026-09-01T00:00:00.000Z',
    });
    expect(d).toEqual({
      tendersSince: '2026-10-01T00:00:00.000Z',
      receiptSince: '2026-09-01T00:00:00.000Z',
      source: 'env_seed',
      aheadOfClock: true,
    });
  });

  it('a tenders-only seed: tenders verbatim, receipt = max(Rule 1 value, tenders)', () => {
    const d = decideCutover({ now: NOW, maxFinalizedAt: null, envTenders: '2026-10-01T00:00:00Z' });
    expect(d.tendersSince).toBe('2026-10-01T00:00:00.000Z');
    expect(d.receiptSince).toBe('2026-11-13T12:00:00.000Z');
    expect(d.source).toBe('env_seed');
  });

  it('a receipt-only seed: receipt verbatim, tenders = the Rule 1 value', () => {
    const d = decideCutover({ now: NOW, maxFinalizedAt: null, envReceipt: '2026-10-01T00:00:00Z' });
    expect(d.tendersSince).toBe('2026-11-13T12:00:00.000Z');
    expect(d.receiptSince).toBe('2026-10-01T00:00:00.000Z');
    expect(d.source).toBe('env_seed');
  });

  it('an invalid env value is ignored (Rule 1 value), and blank counts as unset', () => {
    const d = decideCutover({
      now: NOW,
      maxFinalizedAt: null,
      envTenders: '2026-11-13 12:00', // zone-less: refused by the explicit-zone grammar
      envReceipt: '   ',
    });
    expect(d).toEqual({
      tendersSince: '2026-11-13T12:00:00.000Z',
      receiptSince: '2026-11-13T12:00:00.000Z',
      source: 'first_start',
      aheadOfClock: false,
    });
  });
});

function fakeLogger() {
  const logger = {
    info: vi.fn<CaptureCutoverLogger['info']>(),
    warn: vi.fn<CaptureCutoverLogger['warn']>(),
  };
  return logger satisfies CaptureCutoverLogger;
}

/** Every log call, as text, so a test can prove no instant reached a log line. */
function logged(logger: ReturnType<typeof fakeLogger>): string {
  return JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
}

describe('recordCaptureCutoverOnce — on the migrated database', () => {
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

  function record(env: Record<string, string | undefined>, now = NOW) {
    const logger = fakeLogger();
    const cutover = recordCaptureCutoverOnce({ db: handleFor(db), env, now: () => now, logger });
    return { cutover, logger };
  }

  it('first start on an empty database records T = now, source first_start, and logs it without values', () => {
    const { cutover, logger } = record({});
    expect(cutover).toEqual({
      tendersSince: '2026-11-13T12:00:00.000Z',
      receiptSince: '2026-11-13T12:00:00.000Z',
      recordedAt: '2026-11-13T12:00:00.000Z',
      source: 'first_start',
    });
    expect(logger.info).toHaveBeenCalledWith(
      { source: 'first_start' },
      CAPTURE_CUTOVER_LOG.recorded,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logged(logger)).not.toContain('2026-11-13');
  });

  it('existing old-build sales push T past the newest parseable one and log ahead_of_clock', () => {
    seedSale(db, { sale_id: 's-1', finalized_at: '2026-11-13T11:00:00.000Z' });
    seedSale(db, { sale_id: 's-2', finalized_at: '2026-11-13T12:00:07.000Z' });
    seedSale(db, { sale_id: 's-3', finalized_at: 'not-a-date' });
    const { cutover, logger } = record({});
    expect(cutover.tendersSince).toBe('2026-11-13T12:00:07.001Z');
    expect(cutover.receiptSince).toBe('2026-11-13T12:00:07.001Z');
    expect(cutover.recordedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.aheadOfClock);
    expect(logged(logger)).not.toContain('12:00:07');
  });

  it('scans every sale, whatever its tenant, branch or terminal (an earlier pairing too)', () => {
    seedSale(db, {
      sale_id: 'held-1',
      tenant_id: 'tenant-old',
      branch_id: 'branch-old',
      terminal_id: 'term-old',
      finalized_at: '2026-11-13T12:30:00.000Z',
    });
    expect(record({}).cutover.tendersSince).toBe('2026-11-13T12:30:00.001Z');
  });

  it('valid env values seed their columns verbatim (source env_seed)', () => {
    const { cutover, logger } = record({
      [TENDERS_SINCE_ENV]: '2026-10-01T00:00:00Z',
      [RECEIPT_SINCE_ENV]: '2026-09-15T00:00:00+02:00',
    });
    expect(cutover).toMatchObject({
      tendersSince: '2026-10-01T00:00:00.000Z',
      receiptSince: '2026-09-14T22:00:00.000Z',
      source: 'env_seed',
    });
    expect(logger.info).toHaveBeenCalledWith({ source: 'env_seed' }, CAPTURE_CUTOVER_LOG.recorded);
  });

  it('an invalid env value is ignored, with the existing warning', () => {
    const { cutover, logger } = record({
      [TENDERS_SINCE_ENV]: 'garbage',
      [RECEIPT_SINCE_ENV]: '2026-11-13',
    });
    expect(cutover.source).toBe('first_start');
    expect(cutover.tendersSince).toBe('2026-11-13T12:00:00.000Z');
    expect(logger.warn).toHaveBeenCalledWith('sale_sync:tenders_since_unparseable_tenders_off');
    expect(logger.warn).toHaveBeenCalledWith('sale_sync:receipt_since_unparseable_receipt_off');
    expect(logged(logger)).not.toContain('garbage');
  });

  it('acceptance 3: a second start reads the same row, whatever the clock and the sales say', () => {
    const first = record({}).cutover;
    seedSale(db, { sale_id: 'later', finalized_at: '2027-05-01T00:00:00.000Z' });
    const { cutover, logger } = record({}, new Date('2027-06-01T00:00:00.000Z'));
    expect(cutover).toEqual(first);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(readCaptureCutover(handleFor(db))).toEqual(first);
  });

  it('on a later start a different env value changes nothing and logs env_ignored', () => {
    const first = record({}).cutover;
    const { cutover, logger } = record({ [TENDERS_SINCE_ENV]: '2026-01-01T00:00:00Z' });
    expect(cutover).toEqual(first);
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.envIgnored);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('on a later start an invalid env value changes nothing, warns, and logs env_ignored', () => {
    const first = record({}).cutover;
    const { cutover, logger } = record({ [RECEIPT_SINCE_ENV]: 'nope' });
    expect(cutover).toEqual(first);
    expect(logger.warn).toHaveBeenCalledWith('sale_sync:receipt_since_unparseable_receipt_off');
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.envIgnored);
  });

  it('on a later start the same seeded env values, or none on a first_start row, log nothing', () => {
    const env = { [TENDERS_SINCE_ENV]: '2026-10-01T00:00:00Z' };
    record(env);
    const again = record(env);
    expect(again.logger.warn).not.toHaveBeenCalled();

    const other = freshSalesSyncDb();
    try {
      recordCaptureCutoverOnce({
        db: handleFor(other),
        env: {},
        now: () => NOW,
        logger: fakeLogger(),
      });
      const quiet = fakeLogger();
      recordCaptureCutoverOnce({ db: handleFor(other), env: {}, now: () => NOW, logger: quiet });
      expect(quiet.warn).not.toHaveBeenCalled();
    } finally {
      other.close();
    }
  });

  it('on a later start an env_seed row whose variables were removed keeps its values and logs env_ignored', () => {
    const first = record({ [TENDERS_SINCE_ENV]: '2026-10-01T00:00:00Z' }).cutover;
    const { cutover, logger } = record({});
    expect(cutover).toEqual(first);
    expect(cutover.tendersSince).toBe('2026-10-01T00:00:00.000Z');
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.envIgnored);
  });
});

describe('readEngineCutoffs — what the sale-sync engine is given', () => {
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

  it('the stored row, as the two cut-offs', () => {
    recordCaptureCutoverOnce({
      db: handleFor(db),
      env: { [RECEIPT_SINCE_ENV]: '2026-10-01T00:00:00Z' },
      now: () => NOW,
      logger: fakeLogger(),
    });
    const logger = fakeLogger();
    expect(readEngineCutoffs(handleFor(db), logger)).toEqual({
      tendersSince: '2026-11-13T12:00:00.000Z',
      receiptSince: '2026-10-01T00:00:00.000Z',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('no row (the boot write failed) -> both off, with a warning and no value', () => {
    const logger = fakeLogger();
    expect(readEngineCutoffs(handleFor(db), logger)).toEqual({
      tendersSince: null,
      receiptSince: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.missingOff);
  });

  it('a read that throws -> both off, with the same warning', () => {
    const logger = fakeLogger();
    const broken = {
      prepare: () => {
        throw new Error('SQLITE_IOERR');
      },
    };
    expect(readEngineCutoffs(broken, logger)).toEqual({ tendersSince: null, receiptSince: null });
    expect(logger.warn).toHaveBeenCalledWith(CAPTURE_CUTOVER_LOG.missingOff);
  });
});
