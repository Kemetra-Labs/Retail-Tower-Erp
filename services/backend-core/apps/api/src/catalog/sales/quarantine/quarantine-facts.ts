/**
 * RT-1312 Phase 3(b): the pure rules of a quarantined sale body
 * (`pos-sales/sale-quarantine.yaml` 1.0.0-draft).
 *
 * The body is the till's capture body, stored verbatim and NOT validated as a
 * capture request (a body refused with 400 is not a valid one). Everything
 * here therefore runs on arbitrary JSON and never throws on a field's shape:
 * a field that is missing or malformed gives `null`, never a refused upload.
 */
import { sha256CanonicalHex } from "../../../common/hashing/payload-hash";

/**
 * The fields `captureSale` leaves out of `payload_hash` (RT-1206; the
 * destructuring in `SalesController.captureSale`). Two bodies with the same
 * remaining facts are the same sale, whatever these say.
 */
export const CAPTURE_HASH_EXCLUDED_FIELDS = [
  "operatorUserId",
  "admissionCheckAt",
  "receipt",
  "safetyRevision",
  "safetySyncedAt",
] as const;

/**
 * RT-1565: the per-entry fields capture also leaves out (`splitSaleAttribution`): each line's
 * `sellerUserId` and each tender's `receivedByUserId`.
 */
const CAPTURE_HASH_EXCLUDED_ENTRY_FIELDS = { lines: "sellerUserId", tenders: "receivedByUserId" } as const;

/** `value` without `field` when it is a plain object; anything else as it is (arbitrary JSON). */
function withoutField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(field in value)) return value;
  const { [field]: _dropped, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** The body without the fields capture leaves out of its hash. */
export function saleFactsOf(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const facts: Record<string, unknown> = { ...body };
  for (const field of CAPTURE_HASH_EXCLUDED_FIELDS) delete facts[field];
  for (const [list, field] of Object.entries(CAPTURE_HASH_EXCLUDED_ENTRY_FIELDS)) {
    const entries = facts[list];
    if (Array.isArray(entries)) facts[list] = entries.map((entry) => withoutField(entry, field));
  }
  return facts;
}

/**
 * sha256 hex of the body's sale facts, canonical JSON (key order does not
 * matter). For a body `captureSale` accepts, this equals the `payload_hash` the
 * capture stores: the capture DTO has no transform, default or coercion, so its
 * parsed body has the same canonical form as the raw one. Returns `null` when
 * the body is too deeply nested to serialise (a stack overflow), so the caller
 * can refuse it as a validation error instead of a 500.
 */
export function saleFactsDigest(body: Readonly<Record<string, unknown>>): string | null {
  try {
    return sha256CanonicalHex(saleFactsOf(body));
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * Whether any string value or object key of `value` holds a NUL (U+0000).
 * Postgres refuses it in `jsonb` (22P05) and in `text` (22021), so such a body
 * can never be stored: the upload refuses it as a 400 before any write, and
 * the sale stays on the till (RT-1312 comment 16720). Iterative and
 * never spreading, so neither a deeply nested nor a wide body can overflow the
 * stack.
 */
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes("\u0000")) return true;
    } else if (Array.isArray(current)) {
      // One by one: spreading a wide array onto the call stack overflows it.
      for (const child of current) pending.push(child);
    } else if (typeof current === "object" && current !== null) {
      for (const [key, child] of Object.entries(current)) {
        if (key.includes("\u0000")) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

/** Decision C5: what an operator needs to identify the sale; each field null when absent or malformed. */
export interface QuarantineSummary {
  readonly occurredAt: Date | null;
  readonly posTotal: string | null;
  readonly currencyCode: string | null;
  readonly lineCount: number | null;
}

// RFC 3339 date-time with an offset or Z, as the capture request's `occurredAt`.
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
// NonNegativeDecimalAmount, as the contract's `summary.posTotal`.
const POS_TOTAL_RE = /^[0-9]{1,15}(\.[0-9]{1,4})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function occurredAtOf(value: unknown): Date | null {
  if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function summaryOf(body: Readonly<Record<string, unknown>>): QuarantineSummary {
  const { occurredAt, posTotal, currencyCode, lines } = body;
  return {
    occurredAt: occurredAtOf(occurredAt),
    posTotal: typeof posTotal === "string" && POS_TOTAL_RE.test(posTotal) ? posTotal : null,
    currencyCode: typeof currencyCode === "string" && CURRENCY_RE.test(currencyCode) ? currencyCode : null,
    lineCount: Array.isArray(lines) ? lines.length : null,
  };
}
