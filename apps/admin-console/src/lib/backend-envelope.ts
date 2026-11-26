/**
 * RT-1215: the one place that reads the backend error envelope `{ error: { code, message,
 * request_id? } }` (generated schema `Error`). Every Console feature used to carry its own copy of
 * these helpers; they live here once. Pure: no client, no React.
 *
 * Where the old copies differed on purpose, both behaviours stay and are named:
 *  - `requestIdOf` passes `request_id` through as the body sent it; `requestIdStringOf` keeps it only
 *    when it is a string; `requestIdNonEmptyOf` also drops the empty string.
 *  - `errorCodeOf` passes `code` through; `errorCodeStringOf` keeps it only when it is a string.
 *  - `UUID_PATTERN` accepts either case; `UUID_PATTERN_LOWERCASE` only lower-case hex.
 * Not part of the contracts tier (`client`, `auth-interceptor`, `request-id`, `contracts-pin`).
 */
import type { AuthSchema } from "@/generated/schema";

/** The canonical error body, as the generated schema defines it. */
export type BackendError = AuthSchema.components["schemas"]["Error"];

/**
 * The same body read defensively: a failed call can hand back anything (a proxy page, a string),
 * so every field is optional and the envelope itself may be absent.
 */
export interface ErrorEnvelope<Id extends string | null = string> {
  error?: Partial<Omit<BackendError["error"], "request_id">> & {
    /** `Id` is `string | null` for the few contracts that declare `request_id` nullable. */
    request_id?: Id;
  };
}

/** The envelope's inner `error` object (or whatever the body carried there); undefined for none. */
export function errorBodyOf(error: unknown): ErrorEnvelope["error"] | undefined {
  return (error as ErrorEnvelope | undefined)?.error;
}

/** `error.request_id` exactly as the body carried it. */
export function requestIdOf(error: unknown): string | undefined {
  return errorBodyOf(error)?.request_id;
}

/** `error.request_id` only when it is a string. */
export function requestIdStringOf(error: unknown): string | undefined {
  const id: unknown = errorBodyOf(error)?.request_id;
  return typeof id === "string" ? id : undefined;
}

/** `error.request_id` only when it is a non-empty string. */
export function requestIdNonEmptyOf(error: unknown): string | undefined {
  const id = requestIdStringOf(error);
  return id !== undefined && id.length > 0 ? id : undefined;
}

/** `error.code` exactly as the body carried it. */
export function errorCodeOf(error: unknown): string | undefined {
  return errorBodyOf(error)?.code;
}

/** `error.code` only when it is a string. */
export function errorCodeStringOf(error: unknown): string | undefined {
  const code: unknown = errorBodyOf(error)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A canonical UUID, either case. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A canonical UUID in lower case only (the contract's own form; `people/peopleDirectory.ts`). */
export const UUID_PATTERN_LOWERCASE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A typed status-kind map for one feature: the kind of each documented status. `statusKindOf`
 * answers `"generic"` for any status the map does not list.
 */
export type StatusKinds<K extends string> = Readonly<Record<number, K>>;

export function statusKindOf<K extends string>(
  kinds: StatusKinds<K>,
  status: number,
): K | "generic" {
  return kinds[status] ?? "generic";
}

/** The `{ status, data?, error?, retryAfter? }` result every typed wrapper returns. */
export interface ApiResult<P> {
  status: number;
  data?: P;
  error?: unknown;
  retryAfter?: number;
}

/**
 * Unwrap one wrapper result: its payload, or the error the feature builds (`toError`). A status of
 * 400 or more, or a missing body, is a failure.
 */
export function dataOrThrow<P>(res: ApiResult<P>, toError: (res: ApiResult<P>) => Error): P {
  if (res.status >= 400 || !res.data) throw toError(res);
  return res.data;
}
