/**
 * RT-965: what a failed read tells the operator to do next. Pure: no client, no React.
 *
 * The Console has no backend error-code retry registry (RT-965 asks for none and forbids new
 * Backend-Core codes), so this is the one place that says whether retrying can help. A retry is
 * offered only when it can: no answer at all (the network), a timeout or "too early" (408, 425),
 * and a 5xx. A 429 offers no immediate retry (the shell's rate-limit banner owns the countdown and
 * the retry once the wait is over); the copy says to try again later. A 4xx, or a code the contract documents as
 * a settled refusal, answers the same way every time.
 */
import { errorCodeStringOf, requestIdNonEmptyOf } from "@/lib/backend-envelope";

/**
 * Where a load failed: nothing came back, the server failed, the server refused the request, or
 * it asked the caller to slow down (429).
 */
export type LoadCause = "network" | "server" | "request" | "rateLimited";

export interface LoadFailure {
  cause: LoadCause;
  /** False when retrying the same request cannot change the answer. */
  retryable: boolean;
  /** The correlation id the API returned, for support. */
  requestId?: string;
}

/** Documented error codes that are settled answers, whatever their status. */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "validation",
  "validation_error",
  "forbidden",
  "not_found",
  "already_reconciled",
  "alias_conflict",
  "idempotency_key_conflict",
  "origin_rejected",
  "scope_too_large",
]);

/** 5xx statuses that name a permanent condition of the server, not a transient fault. */
const PERMANENT_SERVER_STATUSES: ReadonlySet<number> = new Set([501, 505]);

const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425]);

/** Can the same request succeed if sent again? `status` undefined or 0 means no answer. */
export function isRetryable(status: number | undefined, code?: string): boolean {
  if (code !== undefined && NON_RETRYABLE_CODES.has(code)) return false;
  if (!status) return true;
  if (status >= 500) return !PERMANENT_SERVER_STATUSES.has(status);
  return RETRYABLE_CLIENT_STATUSES.has(status);
}

/** The failure of one settled call (`status` absent when the call threw: the network). */
export function loadFailureOf(
  result: { status?: number; error?: unknown } | undefined,
): LoadFailure {
  const status = result?.status;
  const requestId = requestIdNonEmptyOf(result?.error);
  const retryable = isRetryable(status, errorCodeStringOf(result?.error));
  let cause: LoadCause = "request";
  if (status === 429) cause = "rateLimited";
  else if (!status) cause = "network";
  else if (status >= 500) cause = "server";
  return { cause, retryable, ...(requestId ? { requestId } : {}) };
}

/** The failure of a read that threw before any answer arrived. */
export const NETWORK_FAILURE: LoadFailure = { cause: "network", retryable: true };

/** The generic server-error copy: advises a retry only when the status and code allow one. */
export function serverErrorKey(
  status: number | undefined,
  code?: string,
): "errors.server" | "errors.serverFinal" {
  return status === 429 || isRetryable(status, code) ? "errors.server" : "errors.serverFinal";
}
