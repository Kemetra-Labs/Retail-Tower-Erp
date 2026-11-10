/**
 * 006 T252 — `vouchers.reverse` HTTP client (GREEN).
 *
 * Calls `POST /api/pos/v1/vouchers/reverse` against Data-Pulse-2 and
 * maps the response into the same `{ kind: 'reversed' | 'refused' |
 * 'authority_unreachable' }` envelope shape used by the sibling
 * clients.
 *
 * **R-13 deferred-reversal posture:** on `authority_unreachable` the
 * Wave-4 FSM consumer is responsible for transitioning the tender line
 * to `reversal_pending`. This client MUST NOT call into
 * `src/main/payments/fsm/*` directly — it only returns the sentinel.
 *
 * **Redaction (FR-017):** no token-shaped strings cross the bridge to
 * the renderer; the request body carries only the `redemption_id`
 * which is allow-listed by FR-017. The raw response body is still
 * never logged.
 */
import type { PosPaymentsVouchers } from '../../../shared/api-types.js';

import {
  bearerHeaderFor,
  voucherRequestHeaders,
  type DeviceTokenRead,
} from './device-credential.js';
import { interpretVoucherResponse } from './interpret-response.js';
import type { VoucherAuthorityLogger, VoucherRefusalReason } from './refusal-mapping.js';

function isReversedResponse(raw: unknown): raw is ReverseVoucherOk {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'reversed';
}

export type ReverseVoucherInput =
  PosPaymentsVouchers.components['schemas']['PosReverseVoucherRequest'];
export type ReverseVoucherOk =
  PosPaymentsVouchers.components['schemas']['PosReverseVoucherResponse'];

export type ReverseVoucherOutcome =
  | ReverseVoucherOk
  | { kind: 'refused'; reason: VoucherRefusalReason }
  | { kind: 'authority_unreachable' };

export interface ReverseVoucherDeps {
  baseUrl: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  logger: VoucherAuthorityLogger;
  idempotencyKey: string;
  /**
   * RT-1110: the paired terminal's device token (`device` scheme), sent as
   * `Authorization: Bearer`. The reverse request carries no `operatorUserId`:
   * the reversal is attributed server-side to the redeeming operator. No token
   * or a failing read: nothing is sent and the outcome is `authority_unreachable`
   * (the deferred-reversal resolver retries). Never logged.
   */
  getDeviceToken: DeviceTokenRead;
  timeoutMs?: number;
}

const REVERSE_PATH = '/api/pos/v1/vouchers/reverse';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function reverseVoucher(
  input: ReverseVoucherInput,
  deps: ReverseVoucherDeps,
): Promise<ReverseVoucherOutcome> {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // RT-1110: no usable device token means nothing is sent.
  const authorization = await bearerHeaderFor(deps.getDeviceToken, 'reverse', deps.logger);
  if (authorization === null) return { kind: 'authority_unreachable' };

  let response: Response;
  try {
    response = await deps.fetch(`${root}${REVERSE_PATH}`, {
      method: 'POST',
      headers: voucherRequestHeaders(deps.idempotencyKey, authorization),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    deps.logger.warn(
      { endpoint: 'reverse', outcome: 'authority_unreachable' },
      'voucher_authority:transport_failure',
    );
    return { kind: 'authority_unreachable' };
  }

  return interpretVoucherResponse(response, 'reverse', isReversedResponse, deps.logger);
}
