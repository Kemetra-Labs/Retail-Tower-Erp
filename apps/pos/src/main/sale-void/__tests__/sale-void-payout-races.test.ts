/**
 * RT-1403 S2 — the payout steps against the races their pre-checks cannot see: a claim another
 * process wrote a moment earlier, a kick mark that no longer applies, a shift that vanishes between
 * the gate and the write, a store that fails. Each leaves the till fail-closed: nothing recorded
 * that the gate did not allow, and no claim left behind by a failed step.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { SCOPE } from './__helpers__/sale-void-fixture.js';
import {
  createHarness,
  freshState,
  type PayoutHarness,
} from './__helpers__/sale-void-payout-harness.js';
import {
  OPENED_BEFORE_VOID,
  SHIFT_A,
  journalVoid,
  openShift,
} from './__helpers__/sale-void-payout-fixture.js';
import { createSaleVoidPayoutRepository } from '../sale-void-payout-repository.js';
import { handleFor } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { SaleVoidPayoutDeps } from '../sale-void-payout.js';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  journalVoid(db, 'confirmed');
  openShift(db, SHIFT_A, OPENED_BEFORE_VOID);
});

afterEach(() => {
  db.close();
});

const start = { void_id: 'v1', action: 'start' } as const;
const retry = { void_id: 'v1', action: 'retry_drawer' } as const;
const manual = { void_id: 'v1', action: 'manual' } as const;

/** The payout repository the service writes through, with some members replaced. */
function racing(
  over: Partial<ReturnType<typeof createSaleVoidPayoutRepository>>,
): (deps: SaleVoidPayoutDeps) => SaleVoidPayoutDeps {
  return (deps) => ({
    ...deps,
    payouts: new Proxy(deps.payouts, {
      get(target, prop) {
        if (prop in over) return (over as Record<string | symbol, unknown>)[prop];
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }),
  });
}

/** A shift read that answers the shift `n` times, then none (the shift vanished mid-step). */
function shiftGoneAfter(n: number): (deps: SaleVoidPayoutDeps) => SaleVoidPayoutDeps {
  return (deps) => {
    let reads = 0;
    return {
      ...deps,
      openShift: (scope) => {
        reads += 1;
        return reads <= n ? deps.openShift(scope) : null;
      },
    };
  };
}

function claimCount(): number {
  return Number(db.exec('SELECT COUNT(*) FROM sale_void_payout_claims')[0]?.values[0]?.[0]);
}

describe('the claim step', () => {
  it('loses the race to another claim: payout_started, no kick, nothing more written', async () => {
    const h = createHarness(db, freshState(), undefined, racing({ startClaim: () => false }));
    expect(await h.service.payOut(start)).toEqual({ kind: 'refused', reason: 'payout_started' });
    expect(h.kicks).toBe(0);
    expect(claimCount()).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('a kick mark that cannot be written aborts the whole claim (no claim without its mark)', async () => {
    const h = createHarness(db, freshState(), undefined, racing({ markSending: () => false }));
    await expect(h.service.payOut(start)).rejects.toThrow('claim not kickable');
    expect(claimCount()).toBe(0);
    expect(h.kicks).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('the shift vanishing between the gate and the claim refuses it', async () => {
    // The refusal check and the gate inside the transaction each read the shift once.
    const h = createHarness(db, freshState(), undefined, shiftGoneAfter(2));
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_no_open_shift',
    });
    expect(claimCount()).toBe(0);
    expect(h.kicks).toBe(0);
  });
});

describe('the retry step', () => {
  /** A claim whose kick never left, with the service's later calls tweaked. */
  async function claimedNeverLeft(tweak?: (deps: SaleVoidPayoutDeps) => SaleVoidPayoutDeps) {
    const state = freshState();
    const first = createHarness(db, state);
    state.kick = () => {
      state.locked = true; // refuses the commit; the kick never left
      return Promise.resolve('no_drawer');
    };
    await first.service.payOut(start);
    state.locked = false;
    return createHarness(db, state, undefined, tweak);
  }

  it('a kick mark that no longer applies makes the retry unsafe', async () => {
    const h: PayoutHarness = await claimedNeverLeft(racing({ markSending: () => false }));
    expect(await h.service.payOut(retry)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_retry_unsafe',
    });
    expect(h.kicks).toBe(0);
  });

  it('a store failure that is not a refusal is never turned into one', async () => {
    const h = await claimedNeverLeft(
      racing({
        markSending: () => {
          throw new Error('disk full');
        },
      }),
    );
    await expect(h.service.payOut(retry)).rejects.toThrow('disk full');
  });
});

describe('the commit step', () => {
  it.each([
    // Reads: the refusal check (1), the claim's gate (2) and shift (3), the commit's gate (4) and shift (5).
    ['the commit gate', 3],
    ['the record itself', 4],
  ] as const)(
    'the shift vanishing before %s refuses it, says the drawer may be open, keeps the claim',
    async (_where, reads) => {
      const h = createHarness(db, freshState(), undefined, shiftGoneAfter(reads));
      expect(await h.service.payOut(start)).toEqual({
        kind: 'refused',
        reason: 'payout_no_open_shift',
        drawer_may_be_open: true,
      });
      expect(h.record()).toBeNull();
      expect(claimCount()).toBe(1);
    },
  );

  it('a store failure at the record rethrows (never a silent success) and keeps the claim', async () => {
    const h = createHarness(
      db,
      freshState(),
      undefined,
      racing({
        insertFrom: () => {
          throw new Error('disk full');
        },
      }),
    );
    await expect(h.service.payOut(start)).rejects.toThrow('disk full');
    expect(h.record()).toBeNull();
    expect(claimCount()).toBe(1);
  });

  it('a manual completion is the same step: a failed record is a rethrow, not a refusal', async () => {
    const state = freshState();
    state.kick = () => Promise.resolve('failed');
    const first = createHarness(db, state);
    await first.service.payOut(start);
    const h = createHarness(
      db,
      state,
      undefined,
      racing({
        insertFrom: () => {
          throw new Error('disk full');
        },
      }),
    );
    await expect(h.service.payOut(manual)).rejects.toThrow('disk full');
  });
});

describe('the kick outcome', () => {
  it('a kick whose outcome could not be recorded keeps the mark: the record waits for the lease', async () => {
    const h = createHarness(db, freshState(), undefined, racing({ recordKick: () => false }));
    // The mark stays `sending` (a kick that may be in flight): no outcome audit, no record.
    expect(await h.service.payOut(start)).toEqual({
      kind: 'refused',
      reason: 'payout_drawer_in_progress',
      drawer_may_be_open: true,
    });
    expect(h.trail).not.toContain('sale.void.payout_drawer');
    expect(h.record()).toBeNull();
    expect(SCOPE.terminalId).toBe('term-1');
  });
});
