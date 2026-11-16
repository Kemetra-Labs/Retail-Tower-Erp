/**
 * RT-1420 — Count Session rules (pure). Lifecycle, variance, position
 * corrections, flags and refusals, acknowledgements, approval policy, late
 * pre-cut assessment and the Count Cut barrier. No database.
 */
import {
  CountRuleError,
  approvalOutcome,
  canApply,
  checkAcknowledgements,
  lateAssessment,
  lineQuantities,
  needsAcknowledgement,
  nextState,
  positionCorrections,
  refusalFor,
  sumQuantities,
  type CountCommand,
  type CountSessionState,
} from '../../../src/inventory/count-sessions/count-session.rules';
import { evaluateBarrier, type BarrierDevice } from '../../../src/inventory/count-sessions/count-barrier';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof CountRuleError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

describe('lifecycle', () => {
  const legal: Array<[CountSessionState, CountCommand, CountSessionState]> = [
    ['open', 'cut', 'cut_taken'],
    ['cut_taken', 'submit', 'submitted'],
    ['submitted', 'approve', 'approved'],
    ['submitted', 'recount', 'cut_taken'],
    ['open', 'cancel', 'cancelled'],
    ['cut_taken', 'cancel', 'cancelled'],
    ['submitted', 'cancel', 'cancelled'],
    ['open', 'observe', 'open'],
    ['cut_taken', 'observe', 'cut_taken'],
  ];
  it.each(legal)('%s --%s--> %s', (from, command, to) => {
    expect(canApply(from, command)).toBe(true);
    expect(nextState(from, command)).toBe(to);
  });

  const states: CountSessionState[] = [
    'open', 'cut_taken', 'submitted', 'approved', 'posting', 'confirmed', 'needs_attention', 'closed', 'cancelled',
  ];
  const commands: CountCommand[] = ['observe', 'cut', 'submit', 'recount', 'approve', 'cancel'];
  const illegal = states.flatMap((s) =>
    commands.filter((c) => !legal.some(([f, cmd]) => f === s && cmd === c)).map((c): [CountSessionState, CountCommand] => [s, c]),
  );
  it.each(illegal)('%s cannot %s', (state, command) => {
    expect(canApply(state, command)).toBe(false);
    expect(code(() => nextState(state, command))).toBe('count_session_not_in_state');
  });
});

describe('variance', () => {
  it('is counted minus expected, exactly', () => {
    expect(lineQuantities('10.0000', ['4.5000', '2.5000'])).toEqual({
      expectedTotal: '10.0000',
      countedTotal: '7.0000',
      varianceQuantity: '-3.0000',
    });
  });
  it('sums positions beyond one position limit and refuses a total over 15 integer digits', () => {
    expect(sumQuantities(['1.0001', '2.0002'], 'q')).toBe('3.0003');
    expect(code(() => lineQuantities('0', ['600000000000000', '600000000000000']))).toBe('validation_error');
  });
});

describe('position corrections (G6-1)', () => {
  const L1 = 'loc-1';
  const L2 = 'loc-2';
  it('corrects each position by counted minus expected, and the deltas sum to the variance', () => {
    const out = positionCorrections(
      [
        { locationId: L1, inventoryStatus: 'sellable', quantity: '6.0000' },
        { locationId: L2, inventoryStatus: 'sellable', quantity: '4.0000' },
      ],
      [
        { locationId: L1, inventoryStatus: 'sellable', quantity: '5.0000' },
        { locationId: L2, inventoryStatus: 'sellable', quantity: '2.0000' },
      ],
    );
    expect(out).toEqual([
      { locationId: L1, inventoryStatus: 'sellable', quantity: '-1.0000' },
      { locationId: L2, inventoryStatus: 'sellable', quantity: '-2.0000' },
    ]);
  });
  it('counts an unobserved position as zero, and writes nothing for a zero delta', () => {
    const out = positionCorrections(
      [
        { locationId: L1, inventoryStatus: 'sellable', quantity: '3.0000' },
        { locationId: L2, inventoryStatus: 'damaged', quantity: '1.0000' },
      ],
      [{ locationId: L1, inventoryStatus: 'sellable', quantity: '3.0000' }],
    );
    expect(out).toEqual([{ locationId: L2, inventoryStatus: 'damaged', quantity: '-1.0000' }]);
  });
  it('adds stock found at a position with no expected quantity', () => {
    const out = positionCorrections([], [{ locationId: L1, inventoryStatus: 'sellable', quantity: '2.0000' }]);
    expect(out).toEqual([{ locationId: L1, inventoryStatus: 'sellable', quantity: '2.0000' }]);
  });
});

describe('flags and refusals (G6-2)', () => {
  it('needs an acknowledgement for divergence, stale snapshot and pending only', () => {
    expect(needsAcknowledgement(['divergence'])).toBe(true);
    expect(needsAcknowledgement(['stale_snapshot'])).toBe(true);
    expect(needsAcknowledgement(['pending'])).toBe(true);
    expect(needsAcknowledgement(['unmapped'])).toBe(false);
    expect(needsAcknowledgement([])).toBe(false);
  });
  it('refuses unmapped and UOM-mismatch lines, which cannot be acknowledged into posting', () => {
    expect(refusalFor({ flags: ['unmapped'], varianceQuantity: '-1.0000', hasValuationHistory: true })).toBe('count_line_unmapped');
    expect(refusalFor({ flags: ['uom_mismatch'], varianceQuantity: '0.0000', hasValuationHistory: true })).toBe('count_line_uom_mismatch');
  });
  it('refuses a count-up with no valuation history, but not a count-down or a count-up with history', () => {
    expect(refusalFor({ flags: [], varianceQuantity: '2.0000', hasValuationHistory: false })).toBe('count_up_without_valuation_history');
    expect(refusalFor({ flags: [], varianceQuantity: '-2.0000', hasValuationHistory: false })).toBeNull();
    expect(refusalFor({ flags: [], varianceQuantity: '2.0000', hasValuationHistory: true })).toBeNull();
  });
});

describe('acknowledgements', () => {
  const line = (over: object = {}) => ({
    productId: 'p1', lineVersion: '3', flags: ['divergence' as const], refusal: null, ...over,
  });
  it('accepts a flagged line acknowledged at its current version', () => {
    expect(code(() => checkAcknowledgements([line()], [{ productId: 'p1', lineVersion: '3' }]))).toBeUndefined();
  });
  it('refuses a flagged line with no acknowledgement', () => {
    expect(code(() => checkAcknowledgements([line()], []))).toBe('count_flagged_line_not_acknowledged');
  });
  it('refuses a stale acknowledgement before a missing one', () => {
    expect(code(() => checkAcknowledgements([line()], [{ productId: 'p1', lineVersion: '2' }]))).toBe('count_line_version_stale');
  });
  it('needs no acknowledgement for an unflagged or a refused line', () => {
    expect(code(() => checkAcknowledgements([line({ flags: [] })], []))).toBeUndefined();
    expect(code(() => checkAcknowledgements([line({ refusal: 'count_line_unmapped' })], []))).toBeUndefined();
  });
});

describe('approval policy (G6-10)', () => {
  const base = { approverId: 'a', counterIds: ['c1', 'c2'], submittedBy: 's', exceptionEnabled: false };
  it('is strict separation for an approver who is neither counter nor submitter', () => {
    expect(approvalOutcome(base)).toEqual({ policy: 'strict_separation', selfApproved: false });
  });
  it('refuses a counter and the submitter', () => {
    expect(code(() => approvalOutcome({ ...base, approverId: 'c2' }))).toBe('count_approver_conflict');
    expect(code(() => approvalOutcome({ ...base, approverId: 's' }))).toBe('count_approver_conflict');
  });
  it('lets the exception approve and marks the session self-approved', () => {
    expect(approvalOutcome({ ...base, approverId: 'c1', exceptionEnabled: true })).toEqual({
      policy: 'small_merchant_exception',
      selfApproved: true,
    });
  });
  it('does not mark an unrelated approver self-approved even with the exception on', () => {
    expect(approvalOutcome({ ...base, exceptionEnabled: true })).toEqual({ policy: 'strict_separation', selfApproved: false });
  });
});

describe('late pre-cut assessment (G6-4)', () => {
  it('a late sale understates availability and carries no oversell risk', () => {
    expect(lateAssessment('-2.0000')).toEqual({ assessment: 'understated', quantity: '2.0000', oversellRisk: false });
  });
  it('a late receipt overstates availability and carries oversell risk', () => {
    expect(lateAssessment('5.0000')).toEqual({ assessment: 'overstated', quantity: '5.0000', oversellRisk: true });
  });
});

describe('Count Cut barrier', () => {
  const cutAt = new Date('2026-11-16T10:00:00Z');
  const healthy = (id: string, over: Partial<BarrierDevice> = {}): BarrierDevice => ({
    deviceId: id,
    hasHealthRow: true,
    lastSeenAt: new Date('2026-11-16T10:00:01Z'),
    pending: 0,
    deadLetter: 0,
    held: 0,
    ...over,
  });
  const wh = (ref: string, endedAt: string | null) => ({
    warehouseMapId: `m-${ref}`,
    erpnextWarehouseRef: ref,
    lastCompletedEndedAt: endedAt ? new Date(endedAt) : null,
  });

  it('allows the cut when every device is drained and every warehouse imported past the cut', () => {
    expect(evaluateBarrier(cutAt, [healthy('d1')], [wh('W1', '2026-11-16T10:00:05Z')])).toEqual({
      allowed: true,
      blockingDeviceIds: [],
      blockingWarehouses: [],
    });
  });
  it('blocks a device with no health row, a stale beat, a pending, dead-letter or held sale, or a NULL count', () => {
    const verdict = evaluateBarrier(
      cutAt,
      [
        healthy('ok'),
        healthy('no-health', { hasHealthRow: false, lastSeenAt: null, pending: null, deadLetter: null, held: null }),
        healthy('stale', { lastSeenAt: new Date('2026-11-16T09:59:59Z') }),
        healthy('pending', { pending: 1 }),
        healthy('dead', { deadLetter: 2 }),
        healthy('held', { held: 1 }),
        healthy('null-counts', { pending: null, deadLetter: null, held: null }),
      ],
      [],
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockingDeviceIds).toEqual(['no-health', 'stale', 'pending', 'dead', 'held', 'null-counts']);
  });
  it('blocks a warehouse with no completed run or one that ended before the cut request', () => {
    const verdict = evaluateBarrier(
      cutAt,
      [healthy('d1')],
      [wh('never', null), wh('old', '2026-11-16T09:59:59Z'), wh('fresh', '2026-11-16T10:00:00Z')],
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockingWarehouses).toEqual(['never', 'old']);
  });
  it('allows a store with no live device and no mapped warehouse (nothing to wait for)', () => {
    expect(evaluateBarrier(cutAt, [], []).allowed).toBe(true);
  });
});
