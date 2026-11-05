/**
 * RT-1213: the shared opaque keyset-cursor codec. A cursor is base64url (no padding) of
 * `JSON.stringify(payload)`, so the payload's key insertion order is the token's byte order.
 * Callers keep their own payload shape, schema, tenant check and error class; only the
 * encode, parse and validate steps live here.
 */
import type { ZodType } from "zod";

/** Base class for every "cursor this operation did not issue" error (each maps to a 400). */
export class InvalidCursorError extends Error {
  constructor(message = "cursor is not a valid continuation token for this operation") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/** base64url of the payload's JSON, keys in insertion order. */
export function encodeOpaque(payload: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * The payload of a cursor this operation issued, validated by `schema`. A token that is not
 * base64url JSON, or that fails the schema, throws `onInvalid()`. Any tenant binding is the
 * caller's check on the returned payload.
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
