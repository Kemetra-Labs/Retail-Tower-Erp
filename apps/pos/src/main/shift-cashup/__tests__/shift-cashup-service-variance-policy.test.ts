/**
 * RT-388 — the shift variance policy in the cash-up service (AD-CASH-001 F5):
 *
 *   • an open FREEZES the policy the till resolves at that instant (K-2): the
 *     policy is stored with the open and sent in its stored body;
 *   • a close evaluates the FROZEN policy only, never the live one: a change after
 *     the open applies from the next open;
 *   • a terminal that never fetched the policy freezes the fail-closed fallback
 *     (`limit 0`, DR-6): any non-zero variance needs a verified manager;
 *   • an open recorded before the upgrade (no frozen policy) is legacy: no limit;
 *   • the forced close (RT-554) keeps refusing `variance_approval_required` under a frozen
 *     policy that asks (the manager is the closer and cannot approve their own close; owner
 *     decision "keep refusal" on RT-388);
 *   • approval never changes the variance, and an offline close needs nothing from
 *     the network (the approver is checked on the local PIN records).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fallbackPolicy, type VariancePolicy } from '../../cash-variance-policy/policy-core.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createShiftCashupRepo } from '../shift-cashup-repo.js';
import { ShiftCashupRefusedError } from '../shift-cashup-service.js';
import {
  CLOSED_AT,
  MANAGER,
  MANAGER_PIN,
  MANAGER_REF,
  OPENED_AT,
  managerSession,
  onlineManager,
  seedPreRolloutShift,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { SCOPE } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abc9';
const NONE: VariancePolicy = { source: 'system', revisionId: null, mode: 'none' };
const LIMIT_5: VariancePolicy = {
  source: 'store',
  revisionId: REVISION,
  mode: 'limit',
  limitAmount: '5.00',
  currencyCode: 'EGP',
};

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db, { varianceApprovalThresholdMinor: null });
});

afterEach(() => {
  db.close();
});

function openedWith(policy: VariancePolicy): void {
  harness.state.policy = policy;
  harness.service.openShift({ openingFloatMinor: FLOAT });
}

function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ShiftCashupRefusedError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('freeze at open', () => {
  it('asks for the policy of the terminal scope and currency, once, at the open', () => {
    openedWith(LIMIT_5);
    expect(harness.state.policyCalls).toEqual([{ scope: SCOPE, shiftCurrencyCode: 'EGP' }]);
  });

  it('stores the resolved policy with the open and sends it in the open body', () => {
    openedWith(LIMIT_5);
    expect(createShiftCashupRepo(handleFor(db)).findOpenShift(SCOPE)?.frozenPolicy).toEqual(
      LIMIT_5,
    );
    expect(storedBody(db, 1)['frozenPolicy']).toEqual({
      policySource: 'store',
      policyRevisionId: REVISION,
      policyValue: { mode: 'limit', limitAmount: '5.00', currencyCode: 'EGP' },
    });
  });

  it('freezes the fail-closed fallback when the till never fetched a policy', () => {
    openedWith(fallbackPolicy('EGP'));
    expect(storedBody(db, 1)['frozenPolicy']).toEqual({
      policySource: 'fallback',
      policyRevisionId: null,
      policyValue: { mode: 'limit', limitAmount: '0.00', currencyCode: 'EGP' },
    });
  });

  it('does not resolve a policy for a refused open', () => {
    harness.state.enabled = false;
    expect(refusalOf(() => harness.service.openShift({ openingFloatMinor: FLOAT }))).toBe(
      'feature_disabled',
    );
    expect(harness.state.policyCalls).toEqual([]);
  });
});

describe('RT-592: an open held long before delivery keeps the revision it froze', () => {
  it('re-sends the open byte for byte (revision and openedAt) after the live policy moved on', () => {
    openedWith(LIMIT_5);
    const repo = createShiftCashupRepo(handleFor(db));
    const sentFirst = repo.nextFact({ scope: SCOPE, now: OPENED_AT });
    // Days offline: the store's policy changed and the till even read the new one.
    harness.state.policy = { ...LIMIT_5, revisionId: '0190f5a2-3b4c-7d8e-9f01-23456789abca' };
    harness.state.clock = new Date(Date.parse(OPENED_AT) + 3 * 86_400_000).toISOString();
    const sentLater = repo.nextFact({ scope: SCOPE, now: harness.state.clock });
    expect(sentFirst).toMatchObject({ kind: 'due' });
    expect(sentLater).toEqual(sentFirst);
    const body = storedBody(db, 1);
    expect(body['openedAt']).toBe(OPENED_AT);
    expect((body['frozenPolicy'] as { policyRevisionId: string }).policyRevisionId).toBe(REVISION);
  });

  it('sends the revision the till held at the open, with the open instant it recorded', () => {
    openedWith(LIMIT_5);
    const frozen = createShiftCashupRepo(handleFor(db)).findOpenShift(SCOPE);
    expect(frozen?.openedAt).toBe(OPENED_AT);
    expect(frozen?.frozenPolicy?.revisionId).toBe(REVISION);
  });
});

describe('the close applies the frozen policy, not the live one', () => {
  it('keeps asking when the live policy was loosened after the open', () => {
    openedWith(LIMIT_5);
    harness.state.policy = NONE;
    expect(refusalOf(() => harness.service.closeShift({ countedCashMinor: FLOAT - 600 }))).toBe(
      'variance_approval_required',
    );
  });

  it('keeps closing alone when the live policy was tightened after the open', () => {
    openedWith(NONE);
    harness.state.policy = fallbackPolicy('EGP');
    const closed = harness.service.closeShift({ countedCashMinor: FLOAT - 600 });
    expect(closed.varianceMinor).toBe(-600);
    expect(storedBody(db, 2)).not.toHaveProperty('varianceApprovedByUserId');
  });

  it('applies a later policy from the next open', () => {
    openedWith(NONE);
    harness.service.closeShift({ countedCashMinor: FLOAT });
    harness.state.clock = new Date(Date.parse(OPENED_AT) + 3_600_000).toISOString();
    openedWith(fallbackPolicy('EGP'));
    expect(refusalOf(() => harness.service.closeShift({ countedCashMinor: FLOAT - 1 }))).toBe(
      'variance_approval_required',
    );
  });
});

describe('the limit', () => {
  beforeEach(() => {
    openedWith(LIMIT_5);
    harness.state.clock = CLOSED_AT;
  });

  it.each([
    ['exactly at the limit', FLOAT - 500],
    ['over by exactly the limit', FLOAT + 500],
    ['no variance', FLOAT],
  ])('closes alone %s', (_name, counted) => {
    expect(harness.service.closeShift({ countedCashMinor: counted }).closedAt).toBe(CLOSED_AT);
  });

  it.each([
    ['one unit short of the limit', FLOAT - 501],
    ['one unit over the limit', FLOAT + 501],
  ])('needs a manager %s', (_name, counted) => {
    expect(refusalOf(() => harness.service.closeShift({ countedCashMinor: counted }))).toBe(
      'variance_approval_required',
    );
  });

  it('asks for no approver within the limit and for one above it', async () => {
    const within = await harness.service.verifyApprover({
      countedCashMinor: FLOAT - 500,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    expect(within).toBeNull();
    expect(harness.state.verifyCalls).toEqual([]);
    const above = await harness.service.verifyApprover({
      countedCashMinor: FLOAT - 501,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    expect(above).not.toBeNull();
    expect(harness.state.verifyCalls).toHaveLength(1);
  });
});

describe('the fail-closed fallback (DR-6)', () => {
  beforeEach(() => {
    openedWith(fallbackPolicy('EGP'));
    harness.state.clock = CLOSED_AT;
  });

  it('closes alone only at a zero variance', () => {
    expect(harness.service.closeShift({ countedCashMinor: FLOAT }).varianceMinor).toBe(0);
  });

  it.each([-1, 1, -50_000])('needs a manager for a variance of %i', (variance) => {
    expect(
      refusalOf(() => harness.service.closeShift({ countedCashMinor: FLOAT + variance })),
    ).toBe('variance_approval_required');
  });
});

describe('a legacy open (recorded before the upgrade)', () => {
  it('has no limit, even when the till now resolves the fallback', async () => {
    seedPreRolloutShift(db, { openingFloatMinor: FLOAT });
    harness.state.policy = fallbackPolicy('EGP');
    harness.state.clock = CLOSED_AT;
    const approver = await harness.service.verifyApprover({
      countedCashMinor: FLOAT - 40_000,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    expect(approver).toBeNull();
    const closed = harness.service.closeShift({ countedCashMinor: FLOAT - 40_000 });
    expect(closed.varianceMinor).toBe(-40_000);
    expect(harness.state.policyCalls).toEqual([]);
    expect(storedBody(db, 2)).not.toHaveProperty('varianceApprovedByUserId');
  });

  it('sends no frozenPolicy in its stored open body', () => {
    seedPreRolloutShift(db, { openingFloatMinor: FLOAT });
    expect(storedBody(db, 1)).not.toHaveProperty('frozenPolicy');
  });
});

describe('approval', () => {
  it('records the approver and keeps the variance exactly as counted (never zeroed)', async () => {
    openedWith(fallbackPolicy('EGP'));
    harness.state.clock = CLOSED_AT;
    const approver = await harness.service.verifyApprover({
      countedCashMinor: FLOAT - 700,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    const closed = harness.service.closeShift({
      countedCashMinor: FLOAT - 700,
      ...(approver === null ? {} : { approver }),
    });
    expect(closed.varianceMinor).toBe(-700);
    const body = storedBody(db, 2);
    expect(body['varianceApprovedByUserId']).toBe(MANAGER);
    expect(body['variance']).toBe('-7.00');
    expect(body['countedCash']).toBe('493.00');
  });

  it('closes offline: the approver is checked on the local PIN records and the close is queued', async () => {
    // Nothing in the service reaches the network: the policy was frozen at the open and the
    // manager PIN store is local. The queued close waits for the shift sync engine.
    openedWith(LIMIT_5);
    harness.state.clock = CLOSED_AT;
    const approver = await harness.service.verifyApprover({
      countedCashMinor: FLOAT - 900,
      managerRef: MANAGER_REF,
      managerPin: MANAGER_PIN,
    });
    harness.service.closeShift({
      countedCashMinor: FLOAT - 900,
      ...(approver === null ? {} : { approver }),
    });
    expect(
      db.exec(`SELECT s.sync_status FROM shift_sync_state s ORDER BY s.seq DESC LIMIT 1`)[0]
        ?.values,
    ).toEqual([['pending']]);
  });

  it('refuses a manager whose cached authority expired (30 days without an online sign-in)', async () => {
    openedWith(LIMIT_5);
    harness.state.clock = CLOSED_AT;
    harness.state.verdict = { kind: 'expired' };
    await expect(
      harness.service.verifyApprover({
        countedCashMinor: FLOAT - 900,
        managerRef: MANAGER_REF,
        managerPin: MANAGER_PIN,
      }),
    ).rejects.toMatchObject({ reason: 'approver_expired' });
  });
});

describe('the forced close (RT-554) under the fail-closed fallback', () => {
  function forceClose(variance: number): () => unknown {
    harness.state.clock = CLOSED_AT;
    harness.state.session = managerSession();
    harness.state.manager = onlineManager();
    const shiftId = createShiftCashupRepo(handleFor(db)).findOpenShift(SCOPE)?.shiftId ?? '';
    return () =>
      harness.service.forceCloseShift({
        operatorSessionId: managerSession().operator_session_id,
        managerUserId: MANAGER,
        shiftId,
        countedCashMinor: FLOAT + variance,
        forcedReason: 'Cashier left',
      });
  }

  // Owner decision "keep refusal" (RT-388): a single-manager store whose shift froze the fallback
  // cannot close a non-zero variance here. It is a follow-up candidate, not worked around.
  it('refuses a non-zero variance (the manager cannot approve their own close) and closes nothing', () => {
    openedWith(fallbackPolicy('EGP'));
    expect(refusalOf(forceClose(-1_200))).toBe('variance_approval_required');
    expect(db.exec('SELECT COUNT(*) FROM shift_cashup_closes')[0]?.values).toEqual([[0]]);
  });

  it('refuses a manager force-closing their OWN shift under a tenant limit when the variance is past it', () => {
    // RT-1004: a manager signed in online opens their own shift (envelope path), freezing the tenant
    // limit; closing it by force makes them the closer, and they cannot approve their own close.
    harness.state.session = managerSession();
    harness.state.manager = onlineManager();
    openedWith(LIMIT_5);
    expect(createShiftCashupRepo(handleFor(db)).findOpenShift(SCOPE)?.openingUserId).toBe(MANAGER);
    expect(refusalOf(forceClose(-600))).toBe('variance_approval_required');
    expect(db.exec('SELECT COUNT(*) FROM shift_cashup_closes')[0]?.values).toEqual([[0]]);
    // Within the limit it closes.
    expect(forceClose(-500)()).toMatchObject({ varianceMinor: -500 });
  });

  it('closes a zero variance', () => {
    openedWith(fallbackPolicy('EGP'));
    expect(forceClose(0)()).toMatchObject({ varianceMinor: 0 });
  });

  it('closes a shift opened before the upgrade (legacy: no limit) whatever the variance', () => {
    seedPreRolloutShift(db, { openingFloatMinor: FLOAT });
    harness.state.policy = fallbackPolicy('EGP');
    expect(forceClose(-1_200)()).toMatchObject({ varianceMinor: -1_200 });
  });
});
