/**
 * SHA-256 over a canonical (sorted-key) JSON serialization of a value
 * (gate C). Deterministic key ordering so US5/T062 provenance-reconcile can
 * reproduce the hash from the stored payload. No float involved — the input
 * is a request DTO whose money fields are strings.
 *
 * `canonicalJsonPayload` is one of the two canonical-JSON serializers kept on
 * purpose (RT-1214); the other is `canonicalJson` in
 * `idempotency/canonical-json.ts`. Their bytes differ, and persisted hashes
 * depend on each, so neither may be swapped for the other.
 *
 * Semantics (pinned by golden vectors in `test/_helpers/canonical-json-golden.ts`):
 *   - object keys sorted by UTF-16 code unit (`compareCodeUnits`), every level;
 *   - an `undefined` member or element is written as `null` (NOT dropped);
 *   - a `Date` (or any object) is serialized by its own enumerable keys, so a
 *     `Date` becomes `{}` — `toJSON` is never called;
 *   - arrays keep their order; primitives as `JSON.stringify`.
 *
 * Persisted bytes that depend on it:
 *   - `payload_hash` on `sales`, `sale_voids`, `sale_refunds`, `sale_returns`,
 *     `refund_executions` and `sale_credit_reversals` (via `sha256CanonicalHex`);
 *   - `erpnext_posting_status.payload_hash`, which the worker copies from the
 *     source fact's `payload_hash`;
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
