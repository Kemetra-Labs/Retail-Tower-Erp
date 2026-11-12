/**
 * RT-1331 — a 429 `RATE_LIMITED` from V-A `validate` / `redeem` is a transient answer, not a
 * verdict on the voucher. It must come back as `authority_unreachable` (the retryable
 * outcome the cashier already gets for a down authority), never as the closed-set refusal
 * that reads "voucher not found" on the till.
 */
import { describe, expect, it } from 'vitest';

import { redeemVoucher } from '../../../../../src/main/payments/voucher-authority-client/redeem.js';
import type { VoucherAuthorityLogger } from '../../../../../src/main/payments/voucher-authority-client/refusal-mapping.js';
import { validateVoucher } from '../../../../../src/main/payments/voucher-authority-client/validate.js';

import {
  BASE_URL,
  FAKE_IDEMPOTENCY_KEY,
  FAKE_OPERATOR_USER_ID,
  FAKE_PAYMENT_ATTEMPT_ID,
  captureFetch,
  errorBody,
  fakeDeviceToken,
  jsonResponse,
  makeLogger,
} from './_fixtures.js';

const VALIDATE_INPUT = {
  code: 'V-CODE-1',
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  applied_amount_minor: 1_500,
  remaining_balance_minor: 2_000,
  operatorUserId: FAKE_OPERATOR_USER_ID,
};

const REDEEM_INPUT = {
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  redemption_intent_token: 'opaque-intent-token-AAA',
  operatorUserId: FAKE_OPERATOR_USER_ID,
};

/** The spies are `vi.fn`; the client sees them as the plain logger surface. */
function deps(fetchImpl: ReturnType<typeof captureFetch>['fetchImpl']) {
  const spies = makeLogger();
  return {
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    logger: spies as unknown as VoucherAuthorityLogger,
    spies,
    idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    getDeviceToken: fakeDeviceToken,
  };
}

describe('RT-1331 — 429 RATE_LIMITED is transient (retryable), not a refusal', () => {
  it('validate: 429 RATE_LIMITED -> authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('RATE_LIMITED'), 429));
    expect(await validateVoucher(VALIDATE_INPUT, deps(fetchImpl))).toEqual({
      kind: 'authority_unreachable',
    });
  });

  it('redeem: 429 RATE_LIMITED -> authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('RATE_LIMITED'), 429));
    expect(await redeemVoucher(REDEEM_INPUT, deps(fetchImpl))).toEqual({
      kind: 'authority_unreachable',
    });
  });

  it('a 429 with no body or an unknown code is still transient (the status decides)', async () => {
    for (const response of [new Response('', { status: 429 }), jsonResponse({}, 429)]) {
      const { fetchImpl } = captureFetch(response);
      expect(await validateVoucher(VALIDATE_INPUT, deps(fetchImpl))).toEqual({
        kind: 'authority_unreachable',
      });
    }
  });

  it('a 429 never reaches the refusal mapper (no unknown-code or refused log)', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('RATE_LIMITED'), 429));
    const d = deps(fetchImpl);
    await validateVoucher(VALIDATE_INPUT, d);
    const messages = d.spies.warn.mock.calls.map((c: unknown[]) => c[1]);
    expect(messages).not.toContain('voucher_authority:unknown_refusal_code');
    expect(messages).not.toContain('voucher_authority:refused_no_code');
  });

  it('other 4xx statuses are still refusals (a 404 voucher_not_found stays a refusal)', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('voucher_not_found'), 404));
    expect(await validateVoucher(VALIDATE_INPUT, deps(fetchImpl))).toEqual({
      kind: 'refused',
      reason: 'voucher_not_found',
    });
  });
});
