/**
 * RT-1498 (`0073_return_journal_origin`) — unit tests for `createReturnOriginRepository`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createReturnOriginRepository } from '../returns-origin-repository.js';
import { createReturnsRepository } from '../returns-repository.js';
import { LINE_A, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

let raw: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

afterEach(() => {
  raw.close();
});

describe('createReturnOriginRepository', () => {
  it('records trimmed lower-case origin_user_id and returns null for legacy rows without one', () => {
    raw = freshSalesSyncDb();
    seedSale(raw, { sale_id: 'sale-1' });
    const db = handleFor(raw);
    const repo = createReturnsRepository(db);
    const origins = createReturnOriginRepository(db);

    const common = {
      scope: SCOPE,
      saleId: 'sale-1',
      saleNumber: 'SN-sale-1',
      serverSaleRef: SALE_REF,
      operatorId: 'op-mgr-a',
      operatorSessionId: 'sess-a',
      currencyCode: 'EGP',
      quotedTotalMinor: 1500,
      requestBodyJson: '{}',
      lines: [{ lineRef: LINE_A, quantity: 1 }],
      now: '2026-11-27T10:00:00.000Z',
    } as const;

    repo.insert({
      ...common,
      returnId: 'ret-legacy',
      externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001',
    });
    expect(origins.originUserIdOf('ret-legacy')).toBeNull();

    repo.insert(
      {
        ...common,
        returnId: 'ret-origin',
        externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000002',
      },
      (inserted) => {
        origins.recordOrigin(inserted.returnId, '  User-Mgr-A  ', inserted.createdAt);
      },
    );
    expect(origins.originUserIdOf('ret-origin')).toBe('user-mgr-a');
  });

  it('rejects duplicate origin writes for the same return', () => {
    raw = freshSalesSyncDb();
    seedSale(raw, { sale_id: 'sale-1' });
    const db = handleFor(raw);
    const repo = createReturnsRepository(db);
    const origins = createReturnOriginRepository(db);

    repo.insert({
      returnId: 'ret-1',
      externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000003',
      scope: SCOPE,
      saleId: 'sale-1',
      saleNumber: 'SN-sale-1',
      serverSaleRef: SALE_REF,
      operatorId: 'op-mgr-a',
      operatorSessionId: 'sess-a',
      currencyCode: 'EGP',
      quotedTotalMinor: 1500,
      requestBodyJson: '{}',
      lines: [{ lineRef: LINE_A, quantity: 1 }],
      now: '2026-11-27T10:00:00.000Z',
    });

    origins.recordOrigin('ret-1', 'user-a', '2026-11-27T10:00:00.000Z');
    expect(() => {
      origins.recordOrigin('ret-1', 'user-b', '2026-11-27T10:01:00.000Z');
    }).toThrow();
  });
});
