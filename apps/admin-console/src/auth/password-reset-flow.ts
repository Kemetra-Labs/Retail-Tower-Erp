/**
 * Password-reset request & confirmation state transitions (RT-1497).
 *
 * Pure logic, no React. Keeps the error outcome as a catalog `MessageKey`
 * so a locale switch re-renders it without losing state.
 *
 * Security posture:
 * - Request (`POST /api/v1/auth/password-reset/request`) always answers 202
 *   whether or not the address exists; the UI renders one opaque confirmation
 *   state (no account enumeration).
 * - Confirm (`POST /api/v1/auth/password-reset/confirm`) sends `new_password`
 *   verbatim without trimming or Unicode normalization (RT-153).
 * - Token links from Descope use `?t=<token>` (RT-1327, `RESET_RETURN_PATH`);
 *   native links may use `?token=<token>`. Both are accepted.
 */
import type { MessageKey } from "@/i18n";
import type { ErrorEnvelope } from "@/lib/backend-envelope";

interface ResetApiInput {
  status: number;
  error?: ErrorEnvelope;
  retryAfterSeconds?: number;
}

type ResetRequestResolution =
  | { kind: "sent" }
  | { kind: "rate-limited"; retryAfterSeconds: number; requestId?: string }
  | { kind: "error"; messageKey: MessageKey; requestId?: string };

type ResetConfirmResolution =
  | { kind: "done" }
  | { kind: "rate-limited"; retryAfterSeconds: number; requestId?: string }
  | { kind: "error"; messageKey: MessageKey; requestId?: string };

/** Extract the recovery token from `?t=` (Descope) or `?token=` (native). */
export function extractResetToken(params: URLSearchParams): string {
  return params.get("t") ?? params.get("token") ?? "";
}

/** Client-side check for the forgot-password email input. */
export function validateResetEmail(raw: string): MessageKey | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "auth.forgotPassword.errors.emailRequired";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "auth.forgotPassword.errors.invalidEmail";
  }
  return null;
}

/** Client-side check for the set-new-password form (never trims passwords, RT-153). */
export function validateResetPasswordForm(
  newPassword: string,
  confirmPassword: string,
): MessageKey | null {
  if (newPassword.length === 0) return "auth.account.errors.newRequired";
  if (confirmPassword.length === 0) return "auth.account.errors.confirmRequired";
  if (newPassword !== confirmPassword) return "auth.account.errors.mismatch";
  return null;
}

export function resolvePasswordResetRequest(input: ResetApiInput): ResetRequestResolution {
  const requestId = input.error?.error?.request_id;
  if (input.status === 429) {
    return {
      kind: "rate-limited",
      retryAfterSeconds: input.retryAfterSeconds ?? 0,
      requestId,
    };
  }
  if (input.status === 400) {
    return { kind: "error", messageKey: "auth.forgotPassword.errors.invalidEmail", requestId };
  }
  if (input.status === 503) {
    return { kind: "error", messageKey: "auth.forgotPassword.errors.unavailable", requestId };
  }
  if (input.status >= 400) {
    return { kind: "error", messageKey: "auth.forgotPassword.errors.failed", requestId };
  }
  return { kind: "sent" };
}

export function resolvePasswordResetConfirm(input: ResetApiInput): ResetConfirmResolution {
  const requestId = input.error?.error?.request_id;
  if (input.status === 429) {
    return {
      kind: "rate-limited",
      retryAfterSeconds: input.retryAfterSeconds ?? 0,
      requestId,
    };
  }
  if (input.status === 400) {
    return { kind: "error", messageKey: "auth.resetPassword.errors.invalidOrRefused", requestId };
  }
  if (input.status === 503) {
    return { kind: "error", messageKey: "auth.resetPassword.errors.unavailable", requestId };
  }
  if (input.status >= 400) {
    return { kind: "error", messageKey: "auth.resetPassword.errors.failed", requestId };
  }
  return { kind: "done" };
}
