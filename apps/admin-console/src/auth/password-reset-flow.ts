/**
 * Password-reset request & confirmation state transitions (RT-1497).
 *
 * Pure logic, no React. Keeps the error outcome as a catalog `MessageKey`
 * so a locale switch re-renders it without losing state.
 */
import type { MessageKey } from "@/i18n";
import type { ErrorEnvelope } from "@/lib/backend-envelope";

interface ResetApiInput {
  status: number;
  error?: ErrorEnvelope;
  retryAfterSeconds?: number;
}

type ResetFailure =
  | { kind: "rate-limited"; retryAfterSeconds: number; requestId?: string }
  | { kind: "error"; messageKey: MessageKey; requestId?: string };

export type ResetPhase =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "sent" }
  | { status: "done" }
  | { status: "error"; messageKey: MessageKey; requestId?: string }
  | { status: "rate-limited"; retryAfterSeconds: number; requestId?: string };

export type ResetResolution = { kind: "sent" } | { kind: "done" } | ResetFailure;

interface ResetErrorKeys {
  badRequest: MessageKey;
  unavailable: MessageKey;
  failed: MessageKey;
}

function classifyResetFailure(input: ResetApiInput, keys: ResetErrorKeys): ResetFailure | null {
  const requestId = input.error?.error?.request_id;
  if (input.status === 429) {
    return { kind: "rate-limited", retryAfterSeconds: input.retryAfterSeconds ?? 0, requestId };
  }
  if (input.status === 400) return { kind: "error", messageKey: keys.badRequest, requestId };
  if (input.status === 503) return { kind: "error", messageKey: keys.unavailable, requestId };
  if (input.status >= 400) return { kind: "error", messageKey: keys.failed, requestId };
  return null;
}

/** Convert a classified API resolution into the UI phase state. */
export function phaseFromResolution(resolution: ResetResolution): ResetPhase {
  if (resolution.kind === "rate-limited") {
    return {
      status: "rate-limited",
      retryAfterSeconds: resolution.retryAfterSeconds,
      requestId: resolution.requestId,
    };
  }
  if (resolution.kind === "error") {
    return { status: "error", messageKey: resolution.messageKey, requestId: resolution.requestId };
  }
  return { status: resolution.kind };
}

/** Extract the recovery token from `?t=` (Descope) or `?token=` (native). */
export function extractResetToken(params: URLSearchParams): string {
  return params.get("t") ?? params.get("token") ?? "";
}

/** Client-side check for the forgot-password email input. */
export function validateResetEmail(raw: string): MessageKey | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "auth.forgotPassword.errors.emailRequired";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
    ? null
    : "auth.forgotPassword.errors.invalidEmail";
}

/** Client-side check for the set-new-password form (never trims passwords, RT-153). */
export function validateResetPasswordForm(
  newPassword: string,
  confirmPassword: string,
): MessageKey | null {
  if (newPassword.length === 0) return "auth.account.errors.newRequired";
  if (confirmPassword.length === 0) return "auth.account.errors.confirmRequired";
  return newPassword === confirmPassword ? null : "auth.account.errors.mismatch";
}

export function resolvePasswordResetRequest(input: ResetApiInput): { kind: "sent" } | ResetFailure {
  return (
    classifyResetFailure(input, {
      badRequest: "auth.forgotPassword.errors.invalidEmail",
      unavailable: "auth.forgotPassword.errors.unavailable",
      failed: "auth.forgotPassword.errors.failed",
    }) ?? { kind: "sent" }
  );
}

export function resolvePasswordResetConfirm(input: ResetApiInput): { kind: "done" } | ResetFailure {
  return (
    classifyResetFailure(input, {
      badRequest: "auth.resetPassword.errors.invalidOrRefused",
      unavailable: "auth.resetPassword.errors.unavailable",
      failed: "auth.resetPassword.errors.failed",
    }) ?? { kind: "done" }
  );
}
