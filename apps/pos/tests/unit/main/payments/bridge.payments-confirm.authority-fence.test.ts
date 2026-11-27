import { describe, expect, it, vi } from 'vitest';

import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import type { OperatorSessionForPayments } from '../../../../src/main/payments/require-operator-session.js';
import type {
  RedeemVoucherInput,
  RedeemVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/redeem.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/reverse.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLineRow,
  makeLinesRepoDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSettlementDeps,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';

/**
 * RT-309 D9 review round (coordinator, Codex finding 4) — `payments.confirm`
 * awaits the voucher redeem; the session lock is checked only at entry. If the
 * session is conflict-locked, ended or replaced while the redeem is in flight,
 * the attempt must NOT settle: it is failed (`operator_session_terminated`) and
 * the redemption V-A already committed is reversed through the existing
 * compensation path (or left `reversal_pending` for the deferred resolver).
 */

const OPERATOR_USER_ID = '44444444-4444-4444-8444-444444444444';

type Change = 'conflict_locked' | 'ended' | 'replaced' | 'none';

function setup(change: Change, reverse: ReverseVoucherOutcome['kind'] = 'reversed') {
  const session = makeSession({ user_id: OPERATOR_USER_ID });
  let current: OperatorSessionForPayments | null = session;
  let conflictLocked = false;
  const fsm = makePaymentAttemptFsmDouble();
  const tenderFsm = makeTenderLineFsmDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const redeemVoucher = vi.fn<(input: RedeemVoucherInput) => Promise<RedeemVoucherOutcome>>(() => {
    // The authority change lands while the redeem is in flight.
    if (change === 'conflict_locked') conflictLocked = true;
    if (change === 'ended') current = null;
    if (change === 'replaced') current = { ...session, operator_session_id: 'sess-other' };
    return Promise.resolve({
      kind: 'redeemed',
      idempotent_replayed: false,
      redeemed_at: '2026-05-25T10:00:05.000Z',
      redemption_id: 'redemption-ABC',
    });
  });
  const reverseVoucher = vi.fn<(input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>>(() =>
    Promise.resolve(
      reverse === 'reversed'
        ? {
            kind: 'reversed',
            already_reversed: false,
            redemption_id: 'redemption-ABC',
            reversed_at: '2026-05-25T10:00:06.000Z',
          }
        : { kind: 'authority_unreachable' },
    ),
  );
  const handler = createPaymentsConfirmHandler({
    ...makeSettlementDeps(fsm, auditEmitter),
    getCurrentSession: () => current,
    isAuthorityConflictLocked: () => conflictLocked,
    attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow({ envelope_subtotal_minor: 1500 })]),
    linesRepo: makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-voucher-1',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1500,
        voucher_redemption_intent_token: 'TOKEN-SECRET',
        applied_at: '2026-05-25T10:00:01.000Z',
      }),
    ]),
    paymentAttemptFsm: fsm,
    tenderLineFsm: tenderFsm,
    idempotency: makeIdempotencyHelperDouble(),
    auditEmitter,
    redeemVoucher,
    reverseVoucher,
    uuid: () => 'uuid-fence',
    clock: () => new Date('2026-05-25T10:00:05.000Z'),
  });
  return { handler, fsm, tenderFsm, reverseVoucher, auditEmitter };
}

const REQ = { payment_attempt_id: 'pa-1', idempotency_key: 'idem-fence-1' };

describe('RT-309 D9 — payments.confirm is fenced by the session across the voucher redeem', () => {
  it.each(['conflict_locked', 'ended', 'replaced'] as const)(
    'session %s during the redeem: never settles; fails the attempt and reverses the redemption',
    async (change) => {
      const h = setup(change);
      const res = await h.handler(REQ);
      expect(res).toEqual({ kind: 'refused', reason: 'no_session' });
      expect(h.fsm.confirm).not.toHaveBeenCalled();
      expect(h.fsm.fail).toHaveBeenCalledWith(
        expect.objectContaining({ failure_reason: 'operator_session_terminated' }),
      );
      expect(h.reverseVoucher).toHaveBeenCalledWith({ redemption_id: 'redemption-ABC' });
      expect(h.tenderFsm.reverse).toHaveBeenCalledTimes(1);
    },
  );

  it('V-A unreachable for the reversal: the line is left reversal_pending for the resolver', async () => {
    const h = setup('conflict_locked', 'authority_unreachable');
    await h.handler(REQ);
    expect(h.fsm.confirm).not.toHaveBeenCalled();
    expect(h.tenderFsm.markReversalPending).toHaveBeenCalledTimes(1);
  });

  it('control: no authority change, the attempt settles', async () => {
    const h = setup('none');
    expect(await h.handler(REQ)).toEqual({ kind: 'ok', settled_at: '2026-05-25T10:00:05.000Z' });
    expect(h.reverseVoucher).not.toHaveBeenCalled();
  });
});
