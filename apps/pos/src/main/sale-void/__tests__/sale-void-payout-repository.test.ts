/**
 * RT-1403 S2 — the sale-void payout repository (migration 0069): a claim before the drawer, one
 * record per void and per sale, written in one transaction with its audit, read back whole.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleVoidPayoutRepository, type KickResult } from '../sale-void-payout-repository.js';
import { SCOPE } from './__helpers__/sale-void-fixture.js';
import {
  PAYOUT_1,
  closeShift,
  journalVoid,
  newClaim,
  newException,
  newPayout,
  openShift,
  seedApproval,
} from './__helpers__/sale-void-payout-fixture.js';

const KICKED_AT = '2026-06-07T12:58:30.000Z';

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

/** A confirmed void in an open shift whose payout was claimed and kicked to `outcome`. */
function claimed(outcome: KickResult | 'sending' | null = 'opened'): void {
  journalVoid(db, 'confirmed');
  openShift(db);
  repo().startClaim(newClaim());
  if (outcome === null) return;
  repo().markSending({ voidId: 'v1', now: KICKED_AT });
  if (outcome !== 'sending') repo().recordKick({ voidId: 'v1', outcome });
}

describe('sale-void payout claims', () => {
  it('starts a claim once and reads it back, never kicked', () => {
    claimed(null);
    expect(repo().readClaim('v1')).toEqual({
      ...newClaim(),
      kickOutcome: null,
      kickCount: 0,
      kickedAt: null,
    });
    expect(repo().startClaim(newClaim())).toBe(false);
  });

  it('reads no claim for a void without one', () => {
    expect(repo().readClaim('v1')).toBeNull();
  });

  it('marks a kick before it is sent and resolves it once', () => {
    claimed(null);
    expect(repo().markSending({ voidId: 'v1', now: KICKED_AT })).toBe(true);
    expect(repo().readClaim('v1')).toMatchObject({
      kickOutcome: 'sending',
      kickCount: 1,
      kickedAt: KICKED_AT,
    });
    expect(repo().recordKick({ voidId: 'v1', outcome: 'opened' })).toBe(true);
    expect(repo().recordKick({ voidId: 'v1', outcome: 'unknown' })).toBe(false);
    expect(repo().readClaim('v1')?.kickOutcome).toBe('opened');
  });

  it('allows another kick only after one that provably never left', () => {
    claimed('failed_before_send');
    expect(repo().markSending({ voidId: 'v1', now: '2026-06-07T12:59:00.000Z' })).toBe(true);
    expect(repo().readClaim('v1')?.kickCount).toBe(2);
    expect(repo().recordKick({ voidId: 'v1', outcome: 'unknown' })).toBe(true);
    expect(repo().markSending({ voidId: 'v1', now: '2026-06-07T12:59:30.000Z' })).toBe(false);
  });

  it.each(['opened', 'unknown', 'sending'] as const)('never kicks again after %s', (outcome) => {
    claimed(outcome);
    expect(repo().markSending({ voidId: 'v1', now: '2026-06-07T12:59:00.000Z' })).toBe(false);
  });

  it('counts the claims with no record yet, per terminal', () => {
    claimed('opened');
    expect(repo().countOpenClaims(SCOPE)).toBe(1);
    expect(repo().countOpenClaims({ ...SCOPE, terminalId: 'term-2' })).toBe(0);
    repo().insertFrom(() => newPayout());
    expect(repo().countOpenClaims(SCOPE)).toBe(0);
  });

  it('refuses a kick mark once the record exists', () => {
    claimed('failed_before_send');
    repo().insertFrom(() => newPayout({ method: 'manual' }));
    expect(repo().markSending({ voidId: 'v1', now: '2026-06-07T13:01:00.000Z' })).toBe(false);
  });

  it('knows whether the unpaid-void flag was audited', () => {
    expect(repo().hasUnpaidFlag('v1')).toBe(false);
    db.run(
      `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
         acting_operator_id, action_category, created_at, payload)
       VALUES ('e1', ?, ?, ?, 'op', 'sale.void.cash_mismatch_flagged', 't',
         '{"void_id":"v1","mismatch_reason":"payout_not_made"}')`,
      [SCOPE.tenantId, SCOPE.branchId, SCOPE.terminalId],
    );
    expect(repo().hasUnpaidFlag('v1')).toBe(true);
    expect(repo().hasUnpaidFlag('v2')).toBe(false);
  });

  it('runs a claim, its kick mark and its audit in one transaction', () => {
    journalVoid(db, 'confirmed');
    openShift(db);
    expect(() => {
      repo().transaction(() => {
        repo().startClaim(newClaim());
        repo().markSending({ voidId: 'v1', now: KICKED_AT });
        throw new Error('audit failed');
      });
    }).toThrow('audit failed');
    expect(repo().readClaim('v1')).toBeNull();
  });
});

describe('sale-void payout records', () => {
  it('reads nothing for a void or sale without a record', () => {
    expect(repo().readByVoid('v1')).toBeNull();
    expect(repo().readBySale('sale-1')).toBeNull();
  });

  it('writes a payout and reads it back by void and by sale', () => {
    claimed();
    repo().insertFrom(() => newPayout());
    expect(repo().readByVoid('v1')).toEqual(newPayout());
    expect(repo().readBySale('sale-1')).toEqual(newPayout());
  });

  it('writes an exception with its approval evidence and flag', () => {
    journalVoid(db, 'refused');
    openShift(db);
    seedApproval(db);
    repo().insertFrom(() => newException());
    expect(repo().readByVoid('v1')).toEqual(newException());
  });

  it('runs the audit hook in the same transaction: a hook failure rolls the record back', () => {
    claimed();
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
    claimed();
    const seen: string[] = [];
    repo().insertFrom(
      () => newPayout(),
      (inserted) => seen.push(inserted.payoutId),
    );
    expect(seen).toEqual([PAYOUT_1]);
  });

  it('a builder failure writes nothing', () => {
    claimed();
    expect(() => {
      repo().insertFrom(() => {
        throw new Error('approval refused');
      });
    }).toThrow('approval refused');
    expect(repo().readByVoid('v1')).toBeNull();
  });

  it('the schema backstop refuses a payout into a closed shift', () => {
    claimed();
    closeShift(db);
    expect(() => {
      repo().insertFrom(() => newPayout());
    }).toThrow(/open shift/);
  });
});
