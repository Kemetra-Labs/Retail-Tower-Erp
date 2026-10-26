/**
 * RT-906 — the `sale_discount_role_resolutions` reads and the insert-once write.
 *
 * Migration 0058's CHECK keeps any role other than `manager` / `admin` out of
 * the table, so the reader's own filter is reached only through a handle that
 * returns such a row. It must drop it, as the SQL twin's `approver_role IN
 * ('manager', 'admin')` does, rather than hand a reader a role the capture
 * contract refuses. On the real stack, a repeat insert keeps the first row.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { freshSalesSyncDb, handleFor, initSalesSyncSql } from './__helpers__/sales-sync-fixture.js';
import type { DatabaseHandle } from '../../db/client.js';
import {
  DISCOUNT_ROLE_SOURCE,
  insertResolutionOnce,
  readResolvedRoles,
  type DiscountRoleResolution,
} from '../discount-role-resolutions.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const ROW: DiscountRoleResolution = {
  sale_id: 'sale-1',
  placeholder_id: 'dp-1',
  approval_id: '0190f5a2-3b4c-7d8e-9f01-000000000001',
  approver_role: 'manager',
  source: DISCOUNT_ROLE_SOURCE,
  resolved_at: '2026-10-27T10:00:00.000Z',
};

function handleReturning(rows: { placeholder_id: string; approver_role: unknown }[]) {
  const seen: unknown[][] = [];
  const db: Pick<DatabaseHandle, 'prepare'> = {
    prepare: () => ({
      all: (...params: unknown[]) => {
        seen.push(params);
        return rows;
      },
    }),
  };
  return { db, seen };
}

describe('RT-906 — readResolvedRoles', () => {
  it('keeps only the roles the capture contract accepts', () => {
    const { db, seen } = handleReturning([
      { placeholder_id: 'dp-1', approver_role: 'manager' },
      { placeholder_id: 'dp-2', approver_role: 'admin' },
      { placeholder_id: 'dp-3', approver_role: 'cashier' },
      { placeholder_id: 'dp-4', approver_role: null },
    ]);
    expect(readResolvedRoles(db, 'sale-1')).toEqual(
      new Map([
        ['dp-1', 'manager'],
        ['dp-2', 'admin'],
      ]),
    );
    expect(seen).toEqual([['sale-1']]);
  });

  it('reads one sale only, and nothing for a sale with no resolution', () => {
    const raw = freshSalesSyncDb();
    const db = handleFor(raw);
    expect(insertResolutionOnce(db, ROW)).toBe(true);
    expect(insertResolutionOnce(db, { ...ROW, sale_id: 'sale-2', approver_role: 'admin' })).toBe(
      true,
    );
    expect(readResolvedRoles(db, 'sale-1')).toEqual(new Map([['dp-1', 'manager']]));
    expect(readResolvedRoles(db, 'sale-3')).toEqual(new Map());
    raw.close();
  });
});

describe('RT-906 — insertResolutionOnce', () => {
  it('a repeat for the same line writes nothing and keeps the first role', () => {
    const raw = freshSalesSyncDb();
    const db = handleFor(raw);
    expect(insertResolutionOnce(db, ROW)).toBe(true);
    expect(insertResolutionOnce(db, { ...ROW, approver_role: 'admin' })).toBe(false);
    expect(readResolvedRoles(db, 'sale-1')).toEqual(new Map([['dp-1', 'manager']]));
    raw.close();
  });
});
