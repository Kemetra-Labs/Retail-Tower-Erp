/**
 * RT-1110 (RT-1098 R-1, contract V-A amendment) — the credential of the voucher
 * clients: the paired terminal's opaque device token, sent as
 * `Authorization: Bearer <device_token>` (the `device` security scheme of
 * `pos-payments/vouchers.yaml`, the same credential as sale capture).
 *
 * Production binds `getDeviceToken` to `createSendableDeviceTokenRead` (null unless
 * the terminal is paired, null once revoked). A token that is absent, empty or
 * unreadable means the request is NOT sent: the caller answers
 * `{ kind: 'authority_unreachable' }`, exactly as for a transport failure, so a
 * redeem that cannot authenticate drives the existing deferred-reversal posture.
 *
 * The token is returned to the in-process caller only. It is never logged here: the
 * closed-set log line carries the endpoint and a reason, never the token or the
 * message of a failed read (a secret-store error text could echo it).
 */
import type { VoucherAuthorityLogger } from './refusal-mapping.js';

/** The device-token read the three voucher clients take as `getDeviceToken`. */
export type DeviceTokenRead = () => Promise<string | null | undefined>;

export type VoucherEndpoint = 'validate' | 'redeem' | 'reverse';

/**
 * The `Authorization` header value for a request, or null when there is no usable
 * device token (already logged as a closed-set warn). Never throws.
 */
export async function bearerHeaderFor(
  getDeviceToken: DeviceTokenRead,
  endpoint: VoucherEndpoint,
  logger: VoucherAuthorityLogger,
): Promise<string | null> {
  let token: string | null | undefined;
  try {
    token = await getDeviceToken();
  } catch {
    logger.warn(
      { endpoint, outcome: 'authority_unreachable', reason: 'device_token_read_failed' },
      'voucher_authority:no_device_token',
    );
    return null;
  }
  if (typeof token !== 'string' || token === '') {
    logger.warn(
      { endpoint, outcome: 'authority_unreachable', reason: 'no_device_token' },
      'voucher_authority:no_device_token',
    );
    return null;
  }
  return `Bearer ${token}`;
}

/**
 * The request headers the three voucher clients share: the JSON body, the caller's
 * idempotency key and the device bearer from `bearerHeaderFor`. One builder, so the
 * three clients carry no copy of the header literal.
 */
export function voucherRequestHeaders(
  idempotencyKey: string,
  authorization: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    Authorization: authorization,
  };
}
