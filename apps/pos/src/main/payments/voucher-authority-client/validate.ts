/**
 * 006 T250 — `vouchers.validate` HTTP client (GREEN).
 *
 * Calls `POST /api/pos/v1/vouchers/validate` against Data-Pulse-2 and
 * maps the response into a typed result envelope. Follows the
 * resolve-on-reachable / reject-only-on-transport contract established
 * by 002's `network.pair()` and 004's `createBackendClient` —
 * EVERY outcome resolves; the function never throws.
 *
 * Result envelope:
 *
 *   - `{ kind: 'validated', applied_amount_minor, intent_expires_at,
 *      redemption_intent_token }` — 200 success, body unwrapped.
 *   - `{ kind: 'refused', reason: VoucherRefusalReason }` — 4xx with
 *     a known `error.code` (or `'validation_failure'` for unknown
 *     codes per F-A4B-001).
 *   - `{ kind: 'authority_unreachable' }` — transport failure / 5xx /
 *     401 / 425 Too Early / malformed body. The Wave-4 FSM consumer
 *     uses this sentinel to drive `applied → reversal_pending`
 *     (research §R-13). The client itself MUST NOT call into the FSM
 *     module — that is Wave 4 scope.
 *
 * **Redaction (FR-017 / F-A4B-004):**
 *   - The cashier-keyed voucher `code` is NEVER logged.
 *   - The response `redemption_intent_token` is NEVER logged.
 *   - The raw 4xx response body is NEVER stringified into a log
 *     argument (only the validated `error.code` is propagated).
 */
import type { PosPaymentsVouchers } from '../../../shared/api-types.js';

import {
  bearerHeaderFor,
  voucherRequestHeaders,
  type DeviceTokenRead,
} from './device-credential.js';
import { interpretVoucherResponse } from './interpret-response.js';
import type { VoucherAuthorityLogger, VoucherRefusalReason } from './refusal-mapping.js';

function isValidatedResponse(raw: unknown): raw is ValidateVoucherOk {
  return (
    typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'validated'
  );
}

/**
 * Operation-derived request shape — F-A4B-002 compliant
 * (no import from the admin `Voucher*` schemas).
 */
export type ValidateVoucherInput =
  PosPaymentsVouchers.components['schemas']['PosValidateVoucherRequest'];

/** Operation-derived success-response shape (kind = 'validated'). */
export type ValidateVoucherOk =
  PosPaymentsVouchers.components['schemas']['PosValidateVoucherResponse'];

/** Discriminated union returned by `validateVoucher`. */
export type ValidateVoucherOutcome =
  | ValidateVoucherOk
  | { kind: 'refused'; reason: VoucherRefusalReason }
  | { kind: 'authority_unreachable' };

export interface ValidateVoucherDeps {
  /** Data-Pulse-2 base URL, e.g. `https://api.example.test`. */
  baseUrl: string;
  /** `fetch` implementation. Production binds the global; tests inject. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Pino-style structured logger. */
  logger: VoucherAuthorityLogger;
  /** Caller-generated UUID v4. */
  idempotencyKey: string;
  /**
   * RT-1110: the paired terminal's device token (`device` scheme), sent as
   * `Authorization: Bearer`. No token or a failing read: nothing is sent and
   * the outcome is `authority_unreachable`. Never logged.
   */
  getDeviceToken: DeviceTokenRead;
  /** Override the request timeout (ms). Defaults to 15s, matching 004. */
  timeoutMs?: number;
}

const VALIDATE_PATH = '/api/pos/v1/vouchers/validate';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function validateVoucher(
  input: ValidateVoucherInput,
  deps: ValidateVoucherDeps,
): Promise<ValidateVoucherOutcome> {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // RT-1110: no usable device token means nothing is sent.
  const authorization = await bearerHeaderFor(deps.getDeviceToken, 'validate', deps.logger);
  if (authorization === null) return { kind: 'authority_unreachable' };

  let response: Response;
  try {
    response = await deps.fetch(`${root}${VALIDATE_PATH}`, {
      method: 'POST',
      headers: voucherRequestHeaders(deps.idempotencyKey, authorization),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Transport failure (DNS / TLS / refused / timeout / abort) →
    // Wave-4 FSM uses the sentinel to drive reversal_pending.
    deps.logger.warn(
      { endpoint: 'validate', outcome: 'authority_unreachable' },
      'voucher_authority:transport_failure',
    );
    return { kind: 'authority_unreachable' };
  }

  return interpretVoucherResponse(response, 'validate', isValidatedResponse, deps.logger);
}
