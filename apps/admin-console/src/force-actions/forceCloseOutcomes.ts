/**
 * RT-1440 (U1): what the close-without-a-count dialog does with each answer of
 * `consoleForceCloseShift`. Pure, no React. The server decides; this only maps its answer to a
 * dialog state and a catalog key, so the server's words never show (the request id does, as a
 * support handle).
 *
 * The close is idempotent per shift and per reason (the natural key), and the dialog keeps one
 * Idempotency-Key per attempt (`KeyedAttempt`), so an unclear answer is retried with the same key:
 *
 *   201                          → closed (first time)
 *   200                          → closed (replay of the recorded close)
 *   409 preview_stale            → stale: read the preview again, send nothing
 *   409 shift_not_stuck          → blocked, with the server's `details.blockers`
 *   409 shift_force_closed       → settled: a force close (a till or another owner) got there first
 *   409 shift_closed             → settled: the till closed it with a cash-up first
 *   409 idempotency_key_conflict → rejected (nothing recorded by this request)
 *   403 support_session_*        → rejected: a support session is read-only
 *   403, 404, 429, 400           → rejected, one catalog key each
 *   425, 5xx, no answer          → retryable: the close may already be recorded
 *   401                          → session
 */
import type { MessageKey } from "@/i18n";
import { type WrapperResult, errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";

export type { WrapperResult };

export type ForceCloseOutcome =
  | { kind: "closed"; replay: boolean }
  | { kind: "stale" }
  | { kind: "blocked"; blockers: string[] }
  | { kind: "settled"; by: "force_close" | "cash_up"; requestId?: string }
  | { kind: "rejected"; messageKey: MessageKey; requestId?: string }
  | { kind: "retryable"; requestId?: string }
  | { kind: "session" };

const KEY = {
  generic: "forceActions.close.error.generic",
  tenantUnavailable: "forceActions.close.error.tenantUnavailable",
  forbidden: "forceActions.close.error.forbidden",
  notAvailable: "forceActions.close.error.notAvailable",
  capReached: "forceActions.close.error.capReached",
  rateLimited: "forceActions.close.error.rateLimited",
  validation: "forceActions.close.error.validation",
} as const satisfies Record<string, MessageKey>;

/** The `error.details.blockers` the server sent; anything that is not a string list is dropped. */
function blockersOf(error: unknown): string[] {
  const details = (error as { error?: { details?: { blockers?: unknown } } } | undefined)?.error
    ?.details;
  const blockers = details?.blockers;
  return Array.isArray(blockers) ? blockers.filter((b): b is string => typeof b === "string") : [];
}

function classify409(result: WrapperResult): ForceCloseOutcome {
  const code = errorCodeOf(result.error);
  const requestId = errorRequestIdOf(result.error);
  switch (code) {
    case "preview_stale":
      return { kind: "stale" };
    case "shift_not_stuck":
      return { kind: "blocked", blockers: blockersOf(result.error) };
    case "shift_force_closed":
      return { kind: "settled", by: "force_close", requestId };
    case "shift_closed":
      return { kind: "settled", by: "cash_up", requestId };
    default:
      return { kind: "rejected", messageKey: KEY.generic, requestId };
  }
}

function classify403(result: WrapperResult): ForceCloseOutcome {
  const code = errorCodeOf(result.error);
  const requestId = errorRequestIdOf(result.error);
  // RT-1468: a platform admin enters any organization directly, so the one support-session
  // refusal left is `support_session_required` (the organization no longer exists).
  return code === "support_session_required"
    ? { kind: "rejected", messageKey: KEY.tenantUnavailable, requestId }
    : { kind: "rejected", messageKey: KEY.forbidden, requestId };
}

export function classifyForceCloseOutcome(result: WrapperResult): ForceCloseOutcome {
  const requestId = errorRequestIdOf(result.error);
  switch (result.status) {
    case 200:
      return { kind: "closed", replay: true };
    case 201:
      return { kind: "closed", replay: false };
    case 400:
      return { kind: "rejected", messageKey: KEY.validation, requestId };
    case 401:
      return { kind: "session" };
    case 403:
      return classify403(result);
    case 404:
      return { kind: "rejected", messageKey: KEY.notAvailable, requestId };
    case 409:
      return classify409(result);
    case 429:
      return {
        kind: "rejected",
        messageKey:
          errorCodeOf(result.error) === "force_action_rate_limited"
            ? KEY.capReached
            : KEY.rateLimited,
        requestId,
      };
    default:
      // 425, every 5xx and a lost answer (status 0): the close may already be recorded.
      return result.status >= 400 && result.status < 500 && result.status !== 425
        ? { kind: "rejected", messageKey: KEY.generic, requestId }
        : { kind: "retryable", requestId };
  }
}

/** The blocker codes the contract names (`ShiftBlocker`), each with its own catalog key. */
const BLOCKER_KEYS: Readonly<Record<string, MessageKey>> = {
  shift_not_open: "forceActions.close.blocker.shift_not_open",
  not_stale: "forceActions.close.blocker.not_stale",
  live_operator_session: "forceActions.close.blocker.live_operator_session",
  live_cashier_admission: "forceActions.close.blocker.live_cashier_admission",
};

/**
 * One catalog key per distinct blocker, in the server's order. An unknown code never leaks: it reads as
 * not closable now. A blocked verdict with no usable blocker still reads as a reason (UX-11.11).
 */
export function blockerKeys(blockers: readonly string[]): MessageKey[] {
  const keys = blockers.map((b) =>
    Object.hasOwn(BLOCKER_KEYS, b)
      ? BLOCKER_KEYS[b]
      : ("forceActions.close.blocker.unknown" as const),
  );
  const distinct = [...new Set(keys)];
  return distinct.length > 0 ? distinct : ["forceActions.close.blocker.unknown"];
}
