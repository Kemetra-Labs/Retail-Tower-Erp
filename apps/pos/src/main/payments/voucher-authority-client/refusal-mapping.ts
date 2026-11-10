/**
 * 006 T253 — voucher V-A closed-set refusal mapping (GREEN).
 *
 * Single source of truth for the closed-set refusal codes returned by
 * the three Data-Pulse-2 voucher endpoints
 * (`/api/pos/v1/vouchers/{validate,redeem,reverse}`). The literal-union
 * is hand-maintained against
 * `contracts/backend-core/openapi/pos-payments/vouchers.yaml` and MUST be kept in sync whenever
 * Data-Pulse-2 publishes a new closed-set entry.
 *
 * **F-A4B-001 guard:** at runtime, every `error.code` string returned
 * by Data-Pulse-2 is validated against the literal-union before being
 * returned to a caller. Unknown codes fall through to
 * `'validation_failure'` (the generic refusal carried by every
 * endpoint's 400 contract) AND emit a `logger.warn` so an unmapped
 * server-side code can be triaged.
 *
 * **F-A4B-002 guard:** this module imports nothing from the admin
 * `Voucher*` schemas (`VoucherCreate` / `VoucherResponse` /
 * `VoucherStatus` / `VoucherType`). Only the operationId-derived
 * `Pos*Voucher*` shapes are in scope for POS-Pulse.
 */

/**
 * Pino-style logger surface used by every voucher V-A client.
 * Matches `InitSentryMainLogger` in `src/main/observability/sentry-main.ts`
 * so the production wiring can pass the same pino instance.
 */
export interface VoucherAuthorityLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/**
 * Closed set of refusal codes returned by ANY of the three voucher
 * endpoints. Union of all three endpoint-specific closed sets
 * documented in `contracts/backend-core/openapi/pos-payments/vouchers.yaml`:
 *
 *   - validate: voucher_not_found, voucher_expired, voucher_cancelled,
 *     voucher_already_redeemed, voucher_tenant_mismatch,
 *     voucher_branch_mismatch, non_cash_overpayment_refused,
 *     validation_failure, store_context_required,
 *     idempotency_key_required, idempotency_key_malformed,
 *     idempotency_key_conflict
 *   - redeem (adds): intent_token_not_found, intent_token_expired,
 *     intent_token_payment_attempt_mismatch (RT-1110 also lists the already
 *     present voucher_cancelled, voucher_expired, voucher_branch_mismatch, which
 *     redeem now returns when it re-evaluates the voucher)
 *   - validate / redeem (RT-1110): a 403 `refused` (valid device token, refused
 *     cashier claim) maps to `validation_failure`; it is not a reason of its own
 *   - reverse (adds): redemption_not_found,
 *     redemption_tenant_mismatch, redemption_branch_mismatch
 *
 * Authored once here so all three clients share a single mapping.
 */
export const REFUSAL_REASONS = [
  // validate
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
  'non_cash_overpayment_refused',
  'validation_failure',
  'store_context_required',
  'idempotency_key_required',
  'idempotency_key_malformed',
  'idempotency_key_conflict',
  // redeem
  'intent_token_not_found',
  'intent_token_expired',
  'intent_token_payment_attempt_mismatch',
  // reverse
  'redemption_not_found',
  'redemption_tenant_mismatch',
  'redemption_branch_mismatch',
] as const;

export type VoucherRefusalReason = (typeof REFUSAL_REASONS)[number];

const REFUSAL_REASON_SET: ReadonlySet<string> = new Set<string>(REFUSAL_REASONS);

/**
 * RT-1110 (contract V-A amendment): `error.code` of the generic 403 on validate and
 * redeem. It is deliberately NOT a `VoucherRefusalReason` (the closed reason set and
 * the cashier-facing copy stay as they were); it maps to `validation_failure`.
 */
const DEVICE_CLAIM_REFUSED_CODE = 'refused';

/**
 * Returns `true` when `code` is in the closed set, narrowing the type
 * for safe assignment to `VoucherRefusalReason`.
 */
export function isKnownRefusalReason(code: string): code is VoucherRefusalReason {
  return REFUSAL_REASON_SET.has(code);
}

/**
 * Map an `error.code` returned by Data-Pulse-2 to a closed-set
 * `VoucherRefusalReason`. Unknown codes fall through to
 * `'validation_failure'` (the generic refusal carried by every
 * endpoint per the OpenAPI snapshot) and emit a structured `warn` so
 * ops can detect unmapped server-side codes (F-A4B-001).
 *
 * The endpoint label (`'validate' | 'redeem' | 'reverse'`) is only
 * used for log enrichment — it never appears in the returned value.
 */
export function mapRefusalCode(
  code: string,
  endpoint: 'validate' | 'redeem' | 'reverse',
  logger: VoucherAuthorityLogger,
): VoucherRefusalReason {
  if (isKnownRefusalReason(code)) return code;
  // RT-1110: the generic 403 of validate / redeem (a valid device token, a refused
  // `operatorUserId` claim). One body for every cause, so it carries no more
  // detail here: it is the generic refusal, and a KNOWN code (no unknown-code warn).
  if (code === DEVICE_CLAIM_REFUSED_CODE) return 'validation_failure';
  logger.warn({ unknown_refusal_code: code, endpoint }, 'voucher_authority:unknown_refusal_code');
  return 'validation_failure';
}
