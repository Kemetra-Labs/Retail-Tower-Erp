/**
 * RT-1213: the shared opaque keyset-cursor codec. A cursor is base64url (no padding) of
 * `JSON.stringify(payload)`, so the payload's key insertion order is the token's byte order.
 * Callers keep their own payload shape, schema, tenant check and error class; only the
 * encode, parse and validate steps live here.
 */
import { z, type ZodType } from "zod";

/**
 * Base class for every "cursor this operation did not issue" error (each maps to a 400).
 * `catalog/erpnext-reconciliation/negative-on-hand.projection.ts` exports a subclass that is also
 * named `InvalidCursorError`: import the right one for `instanceof`.
 */
export class InvalidCursorError extends Error {
  constructor(message = "cursor is not a valid continuation token for this operation") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/**
 * Any JSON object, for the callers that validate the fields themselves (and answer each failed
 * field with its own message). Refuses `null`, arrays and primitives as a malformed token.
 */
export const anyJsonObject = z.record(z.string(), z.unknown());

/** base64url of the payload's JSON, keys in insertion order. */
export function encodeOpaque(payload: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * The payload of a cursor this operation issued, validated by `schema`. A token that is not
 * base64url JSON, or that fails the schema, throws `onInvalid()`: it should return the error,
 * not throw it, and it is called at most once. Any tenant binding is the caller's check on the
 * returned payload.
 */
export function decodeOpaque<T>(raw: string, schema: ZodType<T>, onInvalid: () => Error): T {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw onInvalid();
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw onInvalid();
  return parsed.data;
}

/**
 * True when `key` (UTC, ISO text) names a real instant. `Date.parse` rolls an out-of-range day
 * over ("02-31" becomes "03-03") where Postgres refuses the cast, so the date and time are
 * checked to survive the round trip unchanged.
 */
export function isCalendarInstant(key: string): boolean {
  const ms = Date.parse(key);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === key.slice(0, 19);
}
