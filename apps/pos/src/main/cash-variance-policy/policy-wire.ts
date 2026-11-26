/**
 * RT-388 — the wire shapes of the shift variance policy.
 *
 *   • `readPolicyBody` — the device read's 200 body
 *     (`cash-variance-policy.openapi.yaml` `DeviceCashVariancePolicy`), read
 *     strictly: no unknown key, the source never `fallback` (a POS-side value),
 *     a revision id exactly for source `tenant` / `store`, the `system` default
 *     always `none`, a `limit` with an exact-decimal amount
 *     (`^\d{1,15}(\.\d{1,4})?$`) and an ISO-4217-shaped currency. Anything else
 *     is `null`, and the caller keeps the policy it had. The file is vendored in
 *     the POS pin (RT-388) and the conformance suite checks the route; this validator reads the 200
 *     body strictly, not through the generated types.
 *   • `frozenPolicyBody` — a policy as the open's `FrozenPolicy` object
 *     (`pos-shifts.openapi.yaml`).
 *
 * Pure; never throws on untrusted input.
 */
import type { PolicySource, VariancePolicy } from './policy-core.js';

export interface WirePolicy {
  readonly policy: VariancePolicy;
  /** The server clock when the policy was resolved. */
  readonly serverTime: string;
}

export interface FrozenPolicyBody {
  readonly policySource: PolicySource;
  readonly policyRevisionId: string | null;
  readonly policyValue:
    | { readonly mode: 'none' }
    | { readonly mode: 'limit'; readonly limitAmount: string; readonly currencyCode: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT_AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T/;
const DELIVERED_SOURCES: readonly string[] = ['system', 'tenant', 'store'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/** A plain object whose keys are exactly `keys` (each present); null otherwise. */
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const own = Object.keys(value);
  const same = own.length === keys.length && keys.every((key) => own.includes(key));
  return same ? value : null;
}

interface Value {
  readonly mode: 'none' | 'limit';
  readonly limitAmount?: string;
  readonly currencyCode?: string;
}

function readValue(raw: unknown): Value | null {
  if (!isPlainObject(raw)) return null;
  if (raw['mode'] === 'none') return exactRecord(raw, ['mode']) === null ? null : { mode: 'none' };
  if (raw['mode'] !== 'limit') return null;
  const limit = exactRecord(raw, ['mode', 'limitAmount', 'currencyCode']);
  const amount = limit?.['limitAmount'];
  const currency = limit?.['currencyCode'];
  if (typeof amount !== 'string' || !LIMIT_AMOUNT.test(amount)) return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  return { mode: 'limit', limitAmount: amount, currencyCode: currency };
}

function revisionOf(source: string, raw: unknown): string | null | undefined {
  const needsRevision = source === 'tenant' || source === 'store';
  if (!needsRevision) return raw === null ? null : undefined;
  return typeof raw === 'string' && UUID.test(raw) ? raw.toLowerCase() : undefined;
}

/** The device read's body, or null when it is not exactly the contract's. */
export function readPolicyBody(json: unknown): WirePolicy | null {
  const body = exactRecord(json, ['policySource', 'policyRevisionId', 'policyValue', 'serverTime']);
  if (body === null) return null;
  const source = body['policySource'];
  if (typeof source !== 'string' || !DELIVERED_SOURCES.includes(source)) return null;
  const revisionId = revisionOf(source, body['policyRevisionId']);
  const value = readValue(body['policyValue']);
  const serverTime = body['serverTime'];
  if (revisionId === undefined || value === null) return null;
  if (typeof serverTime !== 'string' || !INSTANT.test(serverTime)) return null;
  if (!Number.isFinite(Date.parse(serverTime))) return null;
  if (source === 'system' && value.mode !== 'none') return null;
  const base = { source: source as PolicySource, revisionId };
  const policy: VariancePolicy =
    value.mode === 'none'
      ? { ...base, mode: 'none' }
      : {
          ...base,
          mode: 'limit',
          limitAmount: value.limitAmount ?? '',
          currencyCode: value.currencyCode ?? '',
        };
  return { policy, serverTime };
}

/**
 * `policy` as the `FrozenPolicy` contract admits it (source `fallback` included),
 * with the revision id in lower case; null when it is malformed: a revision id
 * not exactly for `tenant` / `store`, a `system` policy that is a limit, or a
 * limit that is not an exact decimal in an ISO-4217-shaped currency.
 */
export function normalizeFrozenPolicy(policy: VariancePolicy): VariancePolicy | null {
  const revisionId = revisionOf(policy.source, policy.revisionId);
  if (revisionId === undefined) return null;
  if (policy.mode === 'none') return { source: policy.source, revisionId, mode: 'none' };
  if (policy.source === 'system') return null;
  const value = readValue({
    mode: 'limit',
    limitAmount: policy.limitAmount,
    currencyCode: policy.currencyCode,
  });
  if (value === null) return null;
  return {
    source: policy.source,
    revisionId,
    mode: 'limit',
    limitAmount: policy.limitAmount,
    currencyCode: policy.currencyCode,
  };
}

/** A policy as the `FrozenPolicy` object an open carries. */
export function frozenPolicyBody(policy: VariancePolicy): FrozenPolicyBody {
  return {
    policySource: policy.source,
    policyRevisionId: policy.revisionId,
    policyValue:
      policy.mode === 'none'
        ? { mode: 'none' }
        : { mode: 'limit', limitAmount: policy.limitAmount, currencyCode: policy.currencyCode },
  };
}
