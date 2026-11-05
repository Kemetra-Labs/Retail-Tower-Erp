/**
 * Request canonical JSON (RT-1214). One of the two canonical-JSON serializers
 * kept on purpose; the other is `canonicalJsonPayload` in
 * `catalog/sales/payload-hash.ts`. Do not merge them.
 *
 * Why it differs: it follows `JSON.stringify` semantics for request bodies —
 * an `undefined` object member is DROPPED (payload-hash writes `null`) and a
 * `Date` is written as its ISO string (payload-hash writes `{}`). Either
 * change would alter stored hashes.
 *
 * Persisted / compared bytes that depend on it:
 *   - `idempotency_keys.request_hash` written by the HTTP idempotency
 *     interceptor (settlement-intent rows use payload-hash instead);
 *   - the idempotency store key, which embeds `canonicalJson(params)`
 *     (`store-key.ts`, RT-155 path-param binding);
 *   - the POS cashier-admission `request_hash` (`admission-request.ts`);
 *   - shift close, cash-up and force-close fact hashes (`pos-shifts/`);
 *   - the cash-variance policy ETag (`cash-variance-policy/policy.projections.ts`).
 * Golden bytes: `test/idempotency/canonical-json.golden.unit.spec.ts`.
 */
import { compareCodeUnits } from "../common/compare-code-units";

/**
 * Key-sorted JSON for idempotency fingerprints.
 *
 * `JSON.stringify` follows insertion order, so a retry whose object keys
 * were serialized in a different order hashed as a different body and
 * returned 409. This serializer sorts object keys and otherwise matches
 * JSON.stringify (undefined object values are omitted, arrays keep order).
 */
export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits);
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${stringify(record[key])}`,
  );
  return `{${members.join(",")}}`;
}
