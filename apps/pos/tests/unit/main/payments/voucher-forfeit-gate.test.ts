/* eslint-disable @typescript-eslint/unbound-method --
 * Same as bridge.vouchers-validate.test.ts: we read `mock.calls` off the `Mock`-typed
 * doubles; the fixtures are plain closures with no `this`, so the rule does not apply.
 */
/**
 * RT-1331 (RT-1098 R-5, decision 1A) — the forfeit confirmation gate, main side.
 *
 * A voucher redemption consumes the whole voucher; the part of its value above the
 * applied amount is forfeited. V-A returns that part as `forfeited_amount_minor` on
 * validate. The shared voucher helper (`applyVoucherLine`) refuses to persist a line
 * for a forfeit above zero until the request carries `voucher_forfeit_ack_minor`
 * equal to the amount V-A reported. Both bridge entry points (`tender.apply` and
 * `vouchers.validate`) go through it, so neither can skip the confirmation.
 *
 * Secrecy (V-A contract exception c16402): `forfeited_amount_minor` may reach the
 * renderer in the "confirmation required" answer and nowhere else. It never enters
 * the FSM call, the audit events or a log.
 */
import { describe, expect, it, vi } from 'vitest';

import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import { createVouchersValidateHandler } from '../../../../src/main/payments/handlers/vouchers-validate.js';
import type {
  ValidateVoucherInput,
  ValidateVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/validate.js';
import type {
  TenderApplyRequest,
  VouchersValidateRequest,
} from '../../../../src/shared/bridge-api.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLinesRepoDouble,
  makeSession,
  makeSessionSource,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';

const OPERATOR_USER_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-05-25T10:00:01.000Z';

function validated(forfeited: number): ValidateVoucherOutcome {
  return {
    kind: 'validated',
    applied_amount_minor: 1500,
    forfeited_amount_minor: forfeited,
    intent_expires_at: '2026-06-01T10:05:00.000Z',
    redemption_intent_token: 'opaque-intent-token-XYZ',
  };
}

function setup(outcome: ValidateVoucherOutcome) {
  const sessionSource = makeSessionSource(makeSession({ user_id: OPERATOR_USER_ID }));
  const fsm = makeTenderLineFsmDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const validateVoucher = vi.fn<(input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>>(
    () => Promise.resolve(outcome),
  );
  const deps = {
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow({ envelope_subtotal_minor: 3000 })]),
    linesRepo: makeLinesRepoDouble(),
    tenderLineFsm: fsm,
    idempotency: makeIdempotencyHelperDouble(),
    auditEmitter,
    validateVoucher,
    uuid: () => 'tl-v',
    clock: () => new Date(NOW),
  };
  return {
    fsm,
    auditEmitter,
    validateVoucher,
    tenderApply: createTenderApplyHandler(deps),
    vouchersValidate: createVouchersValidateHandler(deps),
  };
}

/** What both bridge requests share; `ack` is the cashier's confirmed forfeit, if any. */
function requestFields(ack?: number): VouchersValidateRequest {
  return {
    payment_attempt_id: 'pa-1',
    voucher_code: 'V-CODE-1',
    amount_applied_minor: 1500,
    idempotency_key: 'idem-1',
    ...(ack !== undefined ? { voucher_forfeit_ack_minor: ack } : {}),
  };
}

const applyReq = (ack?: number): TenderApplyRequest => ({
  ...requestFields(ack),
  tender_type: 'internal_voucher',
});

const ENTRY_POINTS = [
  ['tender.apply', (s: ReturnType<typeof setup>, ack?: number) => s.tenderApply(applyReq(ack))],
  [
    'vouchers.validate',
    (s: ReturnType<typeof setup>, ack?: number) => s.vouchersValidate(requestFields(ack)),
  ],
] as const;

describe.each(ENTRY_POINTS)('RT-1331 forfeit gate — %s', (_name, call) => {
  it('forfeit above zero and no acknowledgement: asks for confirmation, persists nothing', async () => {
    const s = setup(validated(250));
    expect(await call(s)).toEqual({
      kind: 'forfeit_confirmation_required',
      forfeited_amount_minor: 250,
    });
    expect(s.fsm.apply).not.toHaveBeenCalled();
    expect(s.auditEmitter.captured).toHaveLength(0);
  });

  it('acknowledgement equal to the forfeit: the line is applied', async () => {
    const s = setup(validated(250));
    const result = await call(s, 250);
    expect(result).toMatchObject({ kind: 'ok', tender_line_id: 'tl-v' });
    expect(s.fsm.apply).toHaveBeenCalledTimes(1);
  });

  it('acknowledgement that differs from the forfeit: asks again with the new amount', async () => {
    const s = setup(validated(400));
    expect(await call(s, 250)).toEqual({
      kind: 'forfeit_confirmation_required',
      forfeited_amount_minor: 400,
    });
    expect(s.fsm.apply).not.toHaveBeenCalled();
    expect(s.auditEmitter.captured).toHaveLength(0);
  });

  it('no forfeit: the line is applied without any acknowledgement', async () => {
    const s = setup(validated(0));
    expect(await call(s)).toMatchObject({ kind: 'ok' });
    expect(s.fsm.apply).toHaveBeenCalledTimes(1);
  });

  it('the confirmed call still validates with V-A (a fresh intent, never a cached one)', async () => {
    const s = setup(validated(250));
    await call(s);
    await call(s, 250);
    expect(s.validateVoucher).toHaveBeenCalledTimes(2);
  });

  it('the forfeit amount never reaches the FSM call or an audit event', async () => {
    const s = setup(validated(777));
    await call(s, 777);
    const sink = JSON.stringify([s.fsm.apply.mock.calls, s.auditEmitter.captured]);
    expect(sink).not.toContain('777');
    expect(sink).not.toContain('forfeit');
  });

  it('a refused voucher is unaffected by the gate', async () => {
    const s = setup({ kind: 'refused', reason: 'voucher_expired' });
    expect(await call(s, 250)).toEqual({ kind: 'refused', reason: 'voucher_expired' });
  });
});
