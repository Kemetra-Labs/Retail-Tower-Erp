/**
 * RT-965 (DESIGN.md §8): a load error reads What → Safety → Action → Evidence. This builds the
 * middle of that sentence from a `LoadFailure`: the cause, the safety statement (a read changes
 * nothing) and, only when retrying cannot help, what to do instead. The retry control and the
 * request reference are rendered by the caller (`Banner` and `PanelError` already own them).
 */
import type { MessageKey, T } from "@/i18n";
import type { LoadCause, LoadFailure } from "@/lib/error-recovery";

const CAUSE_KEY: Record<LoadCause, MessageKey> = {
  network: "errors.load.cause.network",
  server: "errors.load.cause.server",
  request: "errors.load.cause.request",
  rateLimited: "errors.load.cause.rateLimited",
};

/** Cause, safety and (when not retryable) the way forward, as one string. */
export function loadFailureDetail(t: T, failure: LoadFailure): string {
  const parts = [t(CAUSE_KEY[failure.cause]), t("errors.load.safety")];
  if (failure.cause === "rateLimited") parts.push(t("errors.load.tryLater"));
  else if (!failure.retryable) parts.push(t("errors.load.noRetry"));
  return parts.join(" ");
}
