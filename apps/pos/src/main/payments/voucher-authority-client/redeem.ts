/**
 * 006 T251 — `vouchers.redeem` HTTP client (GREEN).
 *
 * Calls `POST /api/pos/v1/vouchers/redeem` against Data-Pulse-2 and
 * maps the response into the same `{ kind: 'redeemed' | 'refused' |
 * 'authority_unreachable' }` envelope shape used by `validateVoucher`.
 *
 * Mutating endpoint — `Idempotency-Key` MUST be supplied by the
 * caller and is the same key reused across the matched
 * `validate` → `redeem` pair (the OpenAPI contract supports replay
 * with `idempotent_replayed: true`).
 *
 * **Redaction (FR-017):** the request `redemption_intent_token` and
 * the response `redemption_id` are never stringified into log
 * arguments. Only the structured `error.code` is propagated on
 * refusal.
 */
import type { PosPaymentsVouchers } from '../../../shared/api-types.js';

import {
  bearerHeaderFor,
  voucherRequestHeaders,
  type DeviceTokenRead,
} from './device-credential.js';
import { interpretVoucherResponse } from './interpret-response.js';
import type { VoucherAuthorityLogger, VoucherRefusalReason } from './refusal-mapping.js';

function isRedeemedResponse(raw: unknown): raw is RedeemVoucherOk {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'redeemed';
}

export type RedeemVoucherInput =
  PosPaymentsVouchers.components['schemas']['PosRedeemVoucherRequest'];
export type RedeemVoucherOk = PosPaymentsVouchers.components['schemas']['PosRedeemVoucherResponse'];

export type RedeemVoucherOutcome =
  | RedeemVoucherOk
  | { kind: 'refused'; reason: VoucherRefusalReason }
  | { kind: 'authority_unreachable' };

export interface RedeemVoucherDeps {
  baseUrl: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  logger: VoucherAuthorityLogger;
  /** Caller-generated UUID v4 — replays MUST reuse the same key. */
  idempotencyKey: string;
  /**
   * RT-1110: the paired terminal's device token (`device` scheme), sent as
   * `Authorization: Bearer`. No token or a failing read: nothing is sent and
   * the outcome is `authority_unreachable`. Never logged.
   */
  getDeviceToken: DeviceTokenRead;
  timeoutMs?: number;
}

const REDEEM_PATH = '/api/pos/v1/vouchers/redeem';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function redeemVoucher(
  input: RedeemVoucherInput,
  deps: RedeemVoucherDeps,
): Promise<RedeemVoucherOutcome> {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // RT-1110: no usable device token means nothing is sent.
  const authorization = await bearerHeaderFor(deps.getDeviceToken, 'redeem', deps.logger);
  if (authorization === null) return { kind: 'authority_unreachable' };

  let response: Response;
  try {
    response = await deps.fetch(`${root}${REDEEM_PATH}`, {
      method: 'POST',
      headers: voucherRequestHeaders(deps.idempotencyKey, authorization),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    deps.logger.warn(
      { endpoint: 'redeem', outcome: 'authority_unreachable' },
      'voucher_authority:transport_failure',
    );
    return { kind: 'authority_unreachable' };
  }

  return interpretVoucherResponse(response, 'redeem', isRedeemedResponse, deps.logger);
}
