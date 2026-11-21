/**
 * The shared canonical JSON (RT-1214, RT-1456 A-09). Three serializers exist on purpose,
 * one per stored format; their bytes differ and persisted hashes depend on each, so none
 * may be swapped for another:
 *   - `canonicalJson` here, the default for request bodies and fact hashes;
 *   - `canonicalJsonPayload` in `common/hashing/payload-hash.ts` (`undefined` as `null`);
 *   - `canonicalRevisionJson` in `ai-entitlements/revision-content.ts` (typed `Json` only).
 * The count-emission and offer-pack copies were folded into this one: on every
 * JSON-shaped value they gave the same bytes (golden vectors), and they differed only on
 * `undefined` and `Date`, where their output was lossy or not valid JSON (neither caller can hold one).
 *
 * Why it differs from `canonicalJsonPayload`: it follows `JSON.stringify` semantics for request bodies —
 * an `undefined` object member is DROPPED (payload-hash writes `null`) and a
 * `Date` is written as its ISO string (payload-hash writes `{}`). Either
 * change would alter stored hashes.
 *
 * Persisted / compared bytes that depend on it:
 *   - `idempotency_keys.request_hash` written by the HTTP idempotency
 *     interceptor;
 *   - the idempotency store key, which embeds `canonicalJson(params)`
 *     (`store-key.ts`, RT-155 path-param binding);
 *   - the POS cashier-admission `request_hash` (`admission-request.ts`);
 *   - shift close, cash-up and force-close fact hashes (`pos-shifts/`);
 *   - the cash-variance policy ETag (`cash-variance-policy/policy.projections.ts`);
 *   - the count posting `payloadHash` (`inventory/count-sessions/count-emission.ts`) and the
 *     offer Pack ETag (`offers/offer-pack.service.ts`), folded in by RT-1456.
 * Golden bytes: `test/idempotency/canonical-json.golden.unit.spec.ts`.
 */
import { compareCodeUnits } from "../compare-code-units";

/**
 * Key-sorted JSON for idempotency fingerprints.
 *
 * `JSON.stringify` follows insertion order, so a retry whose object keys
 * were serialized in a different order hashed as a different body and
 * returned 409. This serializer sorts object keys and otherwise matches
 * JSON.stringify (undefined object values are omitted, arrays keep order; an `undefined`
 * array element or top-level value is written as `null`, a `Date` as its ISO string).
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
