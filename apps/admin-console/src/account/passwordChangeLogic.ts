/**
 * RT-807: the `changePassword` outcome → the «حسابي» page's state. Pure, no
 * React. The cases are the contract's responses (auth.openapi.yaml, RT-937)
 * drawn on the Password-states board:
 *
 * - 204: changed; the user's OTHER sessions are revoked, this one stays.
 * - 400: ONE generic refusal. A wrong current password, a rejected new one and a
 *   malformed body cannot be told apart, so the code is never read.
 * - 409: blocked; the account has no active identity-provider link.
 * - 429: the per-user budget answers with `Retry-After` only, the console limit
 *   with the full envelope too; status and header decide, never the body.
 * - 503, another 5xx or no response: the outcome is NOT confirmed (the provider
 *   may have replaced the password), so the copy never says it failed.
 * - 401: the session ended. 403 (`origin_rejected`) and any other 4xx: a plain
 *   failure, never the 400 copy, which would point at the password.
 */
import { parseRetryAfter } from "@/lib/rate-limit";

interface BackendError {
  error?: { code?: string; request_id?: string };
}

export interface PasswordChangeResult {
  status: number;
  error?: BackendError;
  retryAfter?: string | null;
}

export type PasswordChangeOutcome =
  | { kind: "changed" }
  | { kind: "refused"; requestId?: string }
  | { kind: "no-link"; requestId?: string }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "not-confirmed"; requestId?: string }
  | { kind: "session-expired" }
  | { kind: "failed"; requestId?: string };

export function resolvePasswordChange(result: PasswordChangeResult): PasswordChangeOutcome {
  const requestId = result.error?.error?.request_id;
  const withId = requestId ? { requestId } : {};
  const { status } = result;
  if (status >= 200 && status < 300) return { kind: "changed" };
  if (status === 400) return { kind: "refused", ...withId };
  if (status === 401) return { kind: "session-expired" };
  if (status === 409) return { kind: "no-link", ...withId };
  if (status === 429) {
    return { kind: "rate-limited", retryAfterSeconds: parseRetryAfter(result.retryAfter) };
  }
  if (status === 0 || status >= 500) return { kind: "not-confirmed", ...withId };
  return { kind: "failed", ...withId };
}

export interface PasswordChangeFields {
  current: string;
  next: string;
  confirm: string;
}

/**
 * The request body: exactly the two contract fields (`additionalProperties:
 * false`, so a stray key would be a 400). The confirm value is a client-side
 * check only (PW-4) and is never sent. Values go as typed: no trimming and no
 * Unicode normalization.
 */
export function passwordChangeBody(fields: PasswordChangeFields): {
  current_password: string;
  new_password: string;
} {
  return { current_password: fields.current, new_password: fields.next };
}
