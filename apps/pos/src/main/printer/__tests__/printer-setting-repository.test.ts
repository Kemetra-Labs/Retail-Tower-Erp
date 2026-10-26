/**
 * RT-886 — the printer choice repository over the real migration stack (0057).
 * AC3: the choice survives a restart (a new handle on the same database) and a
 * re-pair (the pairing row is rewritten; this table is not touched).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { bindPrinterSettingRepository, rowToChoice } from '../printer-setting-repository.js';

let db: SqlJsDatabase;
const META = { updatedAt: '2026-10-26T10:00:00.000Z', operatorId: 'user_cashier' };

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
});

afterEach(() => {
  db.close();
});

describe('printer setting repository (RT-886)', () => {
  it('reads no choice on a fresh terminal', () => {
    expect(bindPrinterSettingRepository(handleFor(db)).get()).toBeNull();
  });

  it('saves a chosen printer and replaces it in place', () => {
    const repo = bindPrinterSettingRepository(handleFor(db));
    repo.set({ source: 'chosen', printer_name: 'BIXOLON SRP-330II' }, META);
    expect(repo.get()).toEqual({ source: 'chosen', printer_name: 'BIXOLON SRP-330II' });
    repo.set({ source: 'os_default' }, { updatedAt: '2026-10-26T11:00:00.000Z', operatorId: 'm' });
    expect(repo.get()).toEqual({ source: 'os_default' });
    expect(
      db.exec(
        'SELECT COUNT(*), MAX(updated_at), MAX(updated_by_operator_id) FROM terminal_printer_setting',
      )[0]?.values,
    ).toEqual([[1, '2026-10-26T11:00:00.000Z', 'm']]);
  });

  it('survives a restart: a new handle reads the saved choice', () => {
    bindPrinterSettingRepository(handleFor(db)).set(
      { source: 'chosen', printer_name: 'XP-80C' },
      META,
    );
    expect(bindPrinterSettingRepository(handleFor(db)).get()).toEqual({
      source: 'chosen',
      printer_name: 'XP-80C',
    });
  });

  it('survives a re-pair: rewriting the pairing row leaves the choice', () => {
    const repo = bindPrinterSettingRepository(handleFor(db));
    repo.set({ source: 'chosen', printer_name: 'XP-80C' }, META);
    // A re-pair rewrites every terminal_assignment row (pairing/store.ts).
    db.exec('DELETE FROM terminal_assignment;');
    expect(repo.get()).toEqual({ source: 'chosen', printer_name: 'XP-80C' });
  });

  it('reads a row that holds no valid choice as none', () => {
    expect(rowToChoice(undefined)).toBeNull();
    expect(rowToChoice({ printer_source: 'chosen', printer_name: null })).toBeNull();
    expect(rowToChoice({ printer_source: 'other', printer_name: 'x' })).toBeNull();
  });
});
