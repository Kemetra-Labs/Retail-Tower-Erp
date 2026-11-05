/**
 * SHA-256 over a canonical (sorted-key) JSON serialization of a value
 * (gate C). Deterministic key ordering so US5/T062 provenance-reconcile can
 * reproduce the hash from the stored payload. No float involved — the input
 * is a request DTO whose money fields are strings.
 *
 * `canonicalJsonPayload` is one of three canonical-JSON serializers kept on
 * purpose (RT-1214); the others are `canonicalJson` in
 * `idempotency/canonical-json.ts` and in `ai-entitlements/revision-content.ts`.
 * Their bytes differ, and persisted hashes depend on each, so none may be
 * swapped for another.
 *
 * Semantics (pinned by golden vectors in `test/_helpers/canonical-json-golden.ts`):
 *   - object keys sorted by UTF-16 code unit (`compareCodeUnits`), every level;
 *   - an `undefined` member or element is written as `null` (NOT dropped);
 *   - a `Date` (or any object) is serialized by its own enumerable keys, so a
 *     `Date` becomes `{}` — `toJSON` is never called;
 *   - arrays keep their order; JSON primitives as `JSON.stringify`;
 *   - function and symbol values are NOT supported: a member is written as the
 *     text `undefined` and an array element is dropped. Callers pass
 *     JSON-parsed request bodies, where such values cannot occur.
 *
 * Persisted bytes that depend on it:
 *   - `payload_hash` on `sales`, `sale_voids`, `sale_refunds`, `sale_returns`,
 *     `refund_executions` and `sale_credit_reversals` (via `sha256CanonicalHex`);
 *   - `erpnext_posting_status.payload_hash`, which the worker copies from the
 *     parent sale's `sales.payload_hash`;
 *   - `idempotency_keys.request_hash` for settlement intents (key prefix
 *     `settlement-intent:`, `settlement/receivable.service.ts`).
 */
import { createHash } from "node:crypto";

import { compareCodeUnits } from "../../common/compare-code-units";

export function canonicalJsonPayload(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonPayload).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort(compareCodeUnits);
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonPayload((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

export function sha256CanonicalHex(value: unknown): string {
  return createHash("sha256").update(canonicalJsonPayload(value)).digest("hex");
}
