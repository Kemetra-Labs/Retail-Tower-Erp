/**
 * RT-1110 — how the three voucher clients read a V-A response. `validate`, `redeem`
 * and `reverse` map a response the same way, so the mapping lives here once:
 *
 *   - 2xx: the body is the success shape (checked by the client's own guard), else
 *     `authority_unreachable` (a malformed or unparsable success body);
 *   - a 4xx that is not 401 / 425 / 429: the closed-set refusal (`error.code`), or
 *     `validation_failure` when the body has no code;
 *   - 401 / 425 / 429 / 5xx / anything else: `authority_unreachable`.
 *
 * Redaction (FR-017): only the validated `error.code` is propagated; the raw body is
 * never stringified into a log argument.
 */
import type { VoucherEndpoint } from './device-credential.js';
import { extractErrorCode } from './error-body.js';
import {
  mapRefusalCode,
  type VoucherAuthorityLogger,
  type VoucherRefusalReason,
} from './refusal-mapping.js';

/** What a voucher client returns: its success shape, a closed-set refusal, or unreachable. */
export type VoucherClientOutcome<T> =
  | T
  | { kind: 'refused'; reason: VoucherRefusalReason }
  | { kind: 'authority_unreachable' };

const UNREACHABLE = { kind: 'authority_unreachable' } as const;

/**
 * A 4xx the closed refusal set can describe: not 401 (auth), not 425 (in flight) and, RT-1331,
 * not 429 (`RATE_LIMITED`: the authority is throttling this terminal, which says nothing about
 * the voucher, so it is the retryable `authority_unreachable`, never a "not found").
 */
function isRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 425 && status !== 429;
}

async function readSuccessBody<T>(
  response: Response,
  endpoint: VoucherEndpoint,
  isSuccess: (raw: unknown) => raw is T,
  logger: VoucherAuthorityLogger,
): Promise<VoucherClientOutcome<T>> {
  try {
    const raw = (await response.json()) as unknown;
    // Defensive: confirm the discriminator is present before trusting it.
    if (isSuccess(raw)) return raw;
    logger.warn(
      { endpoint, reason: 'malformed_success_body' },
      'voucher_authority:malformed_response',
    );
    return UNREACHABLE;
  } catch {
    logger.warn({ endpoint, reason: 'json_parse_failure' }, 'voucher_authority:malformed_response');
    return UNREACHABLE;
  }
}

async function readRefusal(
  response: Response,
  endpoint: VoucherEndpoint,
  logger: VoucherAuthorityLogger,
): Promise<{ kind: 'refused'; reason: VoucherRefusalReason }> {
  let code: string | undefined;
  try {
    // Extract ONLY the `error.code`: never log the whole body.
    code = extractErrorCode((await response.json()) as unknown);
  } catch {
    // fall through to validation_failure
  }
  if (!code) {
    logger.warn(
      { endpoint, reason: 'missing_error_code', status: response.status },
      'voucher_authority:refused_no_code',
    );
    return { kind: 'refused', reason: 'validation_failure' };
  }
  return { kind: 'refused', reason: mapRefusalCode(code, endpoint, logger) };
}

export async function interpretVoucherResponse<T>(
  response: Response,
  endpoint: VoucherEndpoint,
  isSuccess: (raw: unknown) => raw is T,
  logger: VoucherAuthorityLogger,
): Promise<VoucherClientOutcome<T>> {
  if (response.ok) return readSuccessBody(response, endpoint, isSuccess, logger);
  if (isRefusalStatus(response.status)) return readRefusal(response, endpoint, logger);
  // 401 / 425 / 5xx / anything else.
  logger.warn(
    { endpoint, status: response.status, outcome: 'authority_unreachable' },
    'voucher_authority:non_ok_response',
  );
  return UNREACHABLE;
}
