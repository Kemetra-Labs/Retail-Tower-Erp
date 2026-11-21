/**
 * RT-1403 S2 — the sale-void payout repository (migration 0069): one record per void and per sale,
 * written in one transaction with its audit, read back whole.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleVoidPayoutRepository } from '../sale-void-payout-repository.js';
import {
  PAYOUT_1,
  closeShift,
  journalVoid,
  newException,
  newPayout,
  openShift,
} from './__helpers__/sale-void-payout-fixture.js';

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

function repo() {
  return createSaleVoidPayoutRepository(handleFor(db));
}

describe('sale-void payout repository', () => {
  it('reads nothing for a void or sale without a record', () => {
    expect(repo().readByVoid('v1')).toBeNull();
    expect(repo().readBySale('sale-1')).toBeNull();
  });

  it('writes a payout and reads it back by void and by sale', () => {
    journalVoid(db, 'confirmed');
    openShift(db);
    repo().insertFrom(() => newPayout());
    expect(repo().readByVoid('v1')).toEqual(newPayout());
    expect(repo().readBySale('sale-1')).toEqual(newPayout());
  });

  it('writes an exception with its approval evidence and flag', () => {
    journalVoid(db, 'refused');
    openShift(db);
    repo().insertFrom(() => newException());
    expect(repo().readByVoid('v1')).toEqual(newException());
  });

  it('runs the audit hook in the same transaction: a hook failure rolls the record back', () => {
    journalVoid(db, 'confirmed');
    openShift(db);
    expect(() => {
      repo().insertFrom(
        () => newPayout(),
        () => {
          throw new Error('audit failed');
        },
      );
    }).toThrow('audit failed');
    expect(repo().readByVoid('v1')).toBeNull();
  });

  it('hands the inserted record to the hook', () => {
    journalVoid(db, 'confirmed');
    openShift(db);
    const seen: string[] = [];
    repo().insertFrom(
      () => newPayout(),
      (inserted) => seen.push(inserted.payoutId),
    );
    expect(seen).toEqual([PAYOUT_1]);
  });

  it('a builder failure writes nothing', () => {
    journalVoid(db, 'confirmed');
    openShift(db);
    expect(() => {
      repo().insertFrom(() => {
        throw new Error('approval refused');
      });
    }).toThrow('approval refused');
    expect(repo().readByVoid('v1')).toBeNull();
  });

  it('the schema backstop refuses a payout into a closed shift', () => {
    journalVoid(db, 'confirmed');
    openShift(db);
    closeShift(db);
    expect(() => {
      repo().insertFrom(() => newPayout());
    }).toThrow(/open shift/);
  });
});
