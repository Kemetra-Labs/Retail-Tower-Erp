/**
 * RT-1498 S4 — the void guard's "live return" query (`has_return`) and a return disposition: a
 * terminally CLOSED return (the server never recorded it) no longer blocks a void of its sale;
 * a needs_support return still does (OD-196-4), and so does any other live return.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createReturnDispositionsRepository } from '../../returns/returns-dispositions-repository.js';
import { createReturnsRepository } from '../../returns/returns-repository.js';
import {
  automaticMismatch,
  closing,
  seedResolveApproval,
} from '../../returns/__tests__/__helpers__/dispositions-fixture.js';
import { LINE_A, SALE_REF, SCOPE } from '../../returns/__tests__/__helpers__/returns-fixture.js';
import { LIVE_RETURN_SQL } from '../compose-sale-void.js';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
});

afterEach(() => {
  db.close();
});

function journalUnknown(returnId: string): void {
  const repo = createReturnsRepository(handleFor(db));
  repo.insert({
    returnId,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    serverSaleRef: SALE_REF,
    externalId: `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-00000000000${returnId.slice(1)}`,
    operatorId: 'op',
    operatorSessionId: 'sess',
    currencyCode: 'EGP',
    quotedTotalMinor: 3500,
    requestBodyJson: '{"k":1}',
    lines: [{ lineRef: LINE_A, quantity: 1 }],
    now: '2026-10-04T10:00:01.000Z',
  });
  repo.recordAttempt({ returnId, now: 't1' });
  repo.markUnknown({ returnId, now: 't1' });
}

function blocksVoid(): boolean {
  const statement = handleFor(db).prepare(LIVE_RETURN_SQL) as { get(...p: unknown[]): unknown };
  return statement.get('sale-1') !== undefined;
}

describe('the void guard and a return disposition', () => {
  it('an unknown return blocks a void', () => {
    journalUnknown('r1');
    expect(blocksVoid()).toBe(true);
  });

  it('a needs_support return still blocks a void', () => {
    journalUnknown('r1');
    createReturnDispositionsRepository(handleFor(db)).insert(automaticMismatch());
    expect(blocksVoid()).toBe(true);
  });

  it('a closed return no longer blocks a void', () => {
    journalUnknown('r1');
    seedResolveApproval(db, { disposition: 'close' });
    createReturnDispositionsRepository(handleFor(db)).insert(closing());
    expect(blocksVoid()).toBe(false);
  });

  it('closing one return leaves another live return blocking', () => {
    journalUnknown('r1');
    journalUnknown('r2');
    seedResolveApproval(db, { disposition: 'close' });
    createReturnDispositionsRepository(handleFor(db)).insert(closing());
    expect(blocksVoid()).toBe(true);
  });
});
