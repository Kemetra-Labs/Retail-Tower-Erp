/**
 * RT-388 — the shift variance policy as the till holds it, and the two pure
 * rules on it (AD-CASH-001 D-1, DR-6; `cash-variance-policy.openapi.yaml`,
 * `pos-shifts.openapi.yaml` `FrozenPolicy`).
 *
 *   • `fallbackPolicy` — a terminal that never fetched the policy freezes the
 *     fail-closed `limit 0` (`source = fallback`, no revision id).
 *   • `policyRequiresApproval` — approval is required exactly when
 *     `mode = limit` and `|variance| > limitAmount`. The comparison is exact
 *     (`bigint`, the limit scaled to the contract's four fractional digits):
 *     never a float, never rounded. A policy that cannot be compared in the
 *     shift's currency (another currency, or one the till has no exponent for)
 *     fails closed: any non-zero variance asks. A legacy open (no frozen
 *     policy, `null`) never asks.
 */
import {
  knownExponentFor,
  minorUnitsToDecimalString,
} from '../sales-sync/create-sale-sync-client.js';

/** The `policySource` of the device read, or `fallback` for a never-fetched terminal. */
export type PolicySource = 'system' | 'tenant' | 'store' | 'fallback';

interface PolicyBase {
  readonly source: PolicySource;
  /** A uuid exactly for source `tenant` or `store`; null otherwise. */
  readonly revisionId: string | null;
}

export type VariancePolicy =
  | (PolicyBase & { readonly mode: 'none' })
  | (PolicyBase & {
      readonly mode: 'limit';
      /** An exact-decimal string, as the contract carries it. */
      readonly limitAmount: string;
      readonly currencyCode: string;
    });

/** The contract's fractional digits for a limit (`NonNegativeDecimalAmount`). */
const LIMIT_SCALE = 4;

/** The decimal text of a zero in `currencyCode` (`0.00`, `0`, ...). */
function zeroAmount(currencyCode: string): string {
  const exponent = knownExponentFor(currencyCode);
  return exponent === undefined ? '0' : minorUnitsToDecimalString(0, exponent);
}

/** DR-6: the limit-0 policy a terminal freezes when it never fetched one. */
export function fallbackPolicy(shiftCurrencyCode: string): VariancePolicy {
  return {
    source: 'fallback',
    revisionId: null,
    mode: 'limit',
    limitAmount: zeroAmount(shiftCurrencyCode),
    currencyCode: shiftCurrencyCode,
  };
}

/** `amount` (`^\d+(\.\d{1,4})?$`) as an integer count of 10^-4 units, else null. */
function scaledLimit(amount: string): bigint | null {
  const match = /^(\d{1,15})(?:\.(\d{1,4}))?$/.exec(amount);
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(LIMIT_SCALE, '0');
  return BigInt(whole) * 10n ** BigInt(LIMIT_SCALE) + BigInt(fraction);
}

export interface ApprovalQuery {
  /** The policy frozen with the open; null for a legacy open. */
  readonly policy: VariancePolicy | null;
  /** counted − expected, in the shift currency's minor units. */
  readonly varianceMinor: number;
  readonly shiftCurrencyCode: string;
}

/** True when the close needs a verified manager under the frozen policy. */
export function policyRequiresApproval(query: ApprovalQuery): boolean {
  const { policy, varianceMinor } = query;
  if (policy === null || policy.mode === 'none') return false;
  if (varianceMinor === 0) return false;
  const exponent = knownExponentFor(query.shiftCurrencyCode);
  const limit = scaledLimit(policy.limitAmount);
  const comparable =
    exponent !== undefined &&
    exponent <= LIMIT_SCALE &&
    limit !== null &&
    policy.currencyCode === query.shiftCurrencyCode;
  if (!comparable) return true;
  const magnitude = BigInt(Math.abs(varianceMinor)) * 10n ** BigInt(LIMIT_SCALE - exponent);
  return magnitude > limit;
}
