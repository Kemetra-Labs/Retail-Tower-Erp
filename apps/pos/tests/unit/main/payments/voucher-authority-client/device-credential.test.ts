/**
 * RT-1110 (RT-1098 R-1, contract V-A amendment) — the voucher clients authenticate
 * with the paired terminal's device token (`device` scheme), the same credential as
 * sale capture.
 *
 * Pins, for `validateVoucher`, `redeemVoucher` and `reverseVoucher`:
 *   - `Authorization: Bearer <device token>` is sent;
 *   - the token never reaches a logger sink;
 *   - no token (null / undefined / empty) or a failing token read means NO network
 *     call and `{ kind: 'authority_unreachable' }` (a closed-set log line, no secret);
 *   - `operatorUserId` is in the validate / redeem body and not in the reverse body;
 *   - the amended closed set: the redeem-time codes and the generic 403 `refused`.
 */
import { describe, expect, it } from 'vitest';

import { redeemVoucher } from '../../../../../src/main/payments/voucher-authority-client/redeem.js';
import { reverseVoucher } from '../../../../../src/main/payments/voucher-authority-client/reverse.js';
import { validateVoucher } from '../../../../../src/main/payments/voucher-authority-client/validate.js';

import type { VoucherAuthorityLogger } from '../../../../../src/main/payments/voucher-authority-client/refusal-mapping.js';

import {
  BASE_URL,
  FAKE_DEVICE_TOKEN,
  FAKE_IDEMPOTENCY_KEY,
  FAKE_OPERATOR_USER_ID,
  FAKE_PAYMENT_ATTEMPT_ID,
  FAKE_REDEMPTION_ID,
  captureFetch,
  errorBody,
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
const VALIDATE_OK = {
  kind: 'validated' as const,
  applied_amount_minor: 1_500,
  forfeited_amount_minor: 250,
  intent_expires_at: '2026-06-01T10:05:00.000Z',
  redemption_intent_token: 'opaque-intent-token-AAA',
};
const REDEEM_INPUT = {
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  redemption_intent_token: 'opaque-intent-token-AAA',
  operatorUserId: FAKE_OPERATOR_USER_ID,
};
const REDEEM_OK = {
  kind: 'redeemed' as const,
  redemption_id: FAKE_REDEMPTION_ID,
  redeemed_at: '2026-06-01T10:00:00.000Z',
  idempotent_replayed: false,
};
const REVERSE_INPUT = { redemption_id: FAKE_REDEMPTION_ID };
const REVERSE_OK = {
  kind: 'reversed' as const,
  redemption_id: FAKE_REDEMPTION_ID,
  reversed_at: '2026-06-01T10:01:00.000Z',
  already_reversed: false,
};

type FetchImpl = ReturnType<typeof captureFetch>['fetchImpl'];
type TokenRead = () => Promise<string | null | undefined>;
type Logger = ReturnType<typeof makeLogger>;

interface Client {
  readonly name: string;
  readonly ok: unknown;
  readonly call: (
    fetchImpl: FetchImpl,
    getDeviceToken: TokenRead,
    logger: Logger,
  ) => Promise<{ kind: string }>;
}

const VALIDATE: Client = {
  name: 'validateVoucher',
  ok: VALIDATE_OK,
  call: (fetchImpl, getDeviceToken, logger) =>
    validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: asLogger(logger),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
      getDeviceToken,
    }),
};
const REDEEM: Client = {
  name: 'redeemVoucher',
  ok: REDEEM_OK,
  call: (fetchImpl, getDeviceToken, logger) =>
    redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: asLogger(logger),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
      getDeviceToken,
    }),
};
const REVERSE: Client = {
  name: 'reverseVoucher',
  ok: REVERSE_OK,
  call: (fetchImpl, getDeviceToken, logger) =>
    reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: asLogger(logger),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
      getDeviceToken,
    }),
};

const TOKEN: TokenRead = () => Promise.resolve(FAKE_DEVICE_TOKEN);

function asLogger(logger: Logger): VoucherAuthorityLogger {
  // makeLogger()'s vi.fn sinks are the (fields, msg) methods of the pino-style logger.
  return logger as unknown as VoucherAuthorityLogger;
}

function loggedText(logger: Logger): string {
  return [logger.info, logger.warn, logger.error]
    .flatMap((sink) => sink.mock.calls)
    .map((call) => JSON.stringify(call))
    .join('\n');
}

describe.each([VALIDATE, REDEEM, REVERSE])('$name — device credential', ({ ok, call }) => {
  it('sends Authorization: Bearer <device token>', async () => {
    const { fetchImpl, captured } = captureFetch(jsonResponse(ok, 200));
    await call(fetchImpl, TOKEN, makeLogger());
    expect(captured).toHaveLength(1);
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${FAKE_DEVICE_TOKEN}`);
    expect(headers['Idempotency-Key']).toBe(FAKE_IDEMPOTENCY_KEY);
  });

  it.each([
    ['null', (): Promise<string | null> => Promise.resolve(null)],
    ['undefined', (): Promise<undefined> => Promise.resolve(undefined)],
    ['an empty string', (): Promise<string> => Promise.resolve('')],
  ])('%s token: no network call, authority_unreachable', async (_label, read) => {
    const logger = makeLogger();
    const { fetchImpl, captured } = captureFetch(jsonResponse(ok, 200));
    const result = await call(fetchImpl, read, logger);
    expect(result).toEqual({ kind: 'authority_unreachable' });
    expect(captured).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a rejecting token read: no network call, authority_unreachable, no secret logged', async () => {
    const logger = makeLogger();
    const { fetchImpl, captured } = captureFetch(jsonResponse(ok, 200));
    const result = await call(
      fetchImpl,
      () => Promise.reject(new Error(`secret store failed for ${FAKE_DEVICE_TOKEN}`)),
      logger,
    );
    expect(result).toEqual({ kind: 'authority_unreachable' });
    expect(captured).toHaveLength(0);
    expect(loggedText(logger)).not.toContain(FAKE_DEVICE_TOKEN);
  });

  it('never logs the token (success, refusal and transport failure)', async () => {
    for (const response of [
      jsonResponse(ok, 200),
      jsonResponse(errorBody('voucher_not_found'), 404),
      new Error('ECONNREFUSED'),
    ]) {
      const logger = makeLogger();
      const { fetchImpl } = captureFetch(response);
      await call(fetchImpl, TOKEN, logger);
      expect(loggedText(logger)).not.toContain(FAKE_DEVICE_TOKEN);
    }
  });

  it('a 401 stays authority_unreachable (missing, invalid or revoked device token)', async () => {
    const { fetchImpl } = captureFetch(new Response('', { status: 401 }));
    const result = await call(fetchImpl, TOKEN, makeLogger());
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });
});

describe('operatorUserId in the request body', () => {
  it('validate sends operatorUserId', async () => {
    const { fetchImpl, captured } = captureFetch(jsonResponse(VALIDATE_OK, 200));
    await VALIDATE.call(fetchImpl, TOKEN, makeLogger());
    const body = JSON.parse(captured[0]?.init.body as string) as Record<string, unknown>;
    expect(body['operatorUserId']).toBe(FAKE_OPERATOR_USER_ID);
  });

  it('redeem sends operatorUserId', async () => {
    const { fetchImpl, captured } = captureFetch(jsonResponse(REDEEM_OK, 200));
    await REDEEM.call(fetchImpl, TOKEN, makeLogger());
    const body = JSON.parse(captured[0]?.init.body as string) as Record<string, unknown>;
    expect(body['operatorUserId']).toBe(FAKE_OPERATOR_USER_ID);
  });

  it('reverse sends no operatorUserId (device token only)', async () => {
    const { fetchImpl, captured } = captureFetch(jsonResponse(REVERSE_OK, 200));
    await REVERSE.call(fetchImpl, TOKEN, makeLogger());
    const body = JSON.parse(captured[0]?.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ redemption_id: FAKE_REDEMPTION_ID });
  });
});

describe('amended closed set (RT-1110)', () => {
  it('validate success carries forfeited_amount_minor through', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(VALIDATE_OK, 200));
    const result = await VALIDATE.call(fetchImpl, TOKEN, makeLogger());
    expect(result).toMatchObject({ kind: 'validated', forfeited_amount_minor: 250 });
  });

  it.each([
    'voucher_cancelled',
    'voucher_expired',
    'voucher_branch_mismatch',
    'voucher_already_redeemed',
  ])('redeem 409 %s → refused with the same reason, no unknown-code warn', async (code) => {
    const logger = makeLogger();
    const { fetchImpl } = captureFetch(jsonResponse(errorBody(code), 409));
    const result = await REDEEM.call(fetchImpl, TOKEN, logger);
    expect(result).toEqual({ kind: 'refused', reason: code });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['validate', VALIDATE],
    ['redeem', REDEEM],
  ])(
    '%s 403 refused (a valid device, a refused cashier claim) → validation_failure, no unknown-code warn',
    async (_name, client) => {
      const logger = makeLogger();
      const { fetchImpl } = captureFetch(jsonResponse(errorBody('refused'), 403));
      const result = await client.call(fetchImpl, TOKEN, logger);
      expect(result).toEqual({ kind: 'refused', reason: 'validation_failure' });
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
});
