/**
 * RT-1441 (U2): what the store-deletion dialog does with each answer of `consoleDeleteStore` and
 * `consoleReauthenticate`. Pure, no React. The server decides; this only maps its answer to a
 * dialog state and a catalog key, so the server's words never show (the request id does, as a
 * support handle).
 *
 * The delete is idempotent per `Idempotency-Key`, and the dialog keeps one key per attempt
 * (`KeyedAttempt`), so an unclear answer is retried with the same key and body:
 *
 *   200                              → deleted (the first time, or a same-key replay)
 *   409 preview_stale                → stale: read the preview again, send nothing
 *   409 store_has_open_shift,
 *       store_has_unretired_device,
 *       store_device_queue_unsynced,
 *       store_has_open_count_session → blocked, with the server's `details.blockers`
 *   409 other                        → rejected (nothing deleted by this request)
 *   403 reauth_required              → reauthRequired: the grant is gone (one answer for every cause)
 *   403 store_deletion_owner_only    → rejected: the owner only
 *   403 support_session_required     → rejected: the organization is no longer available (RT-1468)
 *   403, 404, 429, 400               → rejected, one catalog key each
 *   425, 5xx, no answer              → retryable: the delete may already be recorded
 *   401                              → session
 *
 * The re-authentication answers either grant a token or refuse, and a refusal is deliberately
 * uniform (`reauth_failed` never says whether the password was the problem).
 */
import type { MessageKey } from "@/i18n";
import { type WrapperResult, errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";
import type { BlockerEntry } from "./storeDeletionLogic";

export type { WrapperResult };

export type DeletionOutcome =
  | { kind: "deleted"; replay: boolean }
  | { kind: "stale" }
  | { kind: "blocked"; blockers: BlockerEntry[] }
  | { kind: "reauthRequired" }
  | { kind: "rejected"; messageKey: MessageKey; requestId?: string }
  | { kind: "retryable"; requestId?: string }
  | { kind: "session" };

export type ReauthOutcome =
  | { kind: "granted"; token: string }
  | Extract<DeletionOutcome, { kind: "rejected" | "session" }>;

/** What the delete wrapper returns: the status, the bodies, and whether the answer was a replay. */
export interface DeleteResult extends WrapperResult {
  replayed?: boolean;
}

const KEY = {
  generic: "storeDeletion.error.generic",
  tenantUnavailable: "storeDeletion.error.tenantUnavailable",
  ownerOnly: "storeDeletion.error.ownerOnly",
  forbidden: "storeDeletion.error.forbidden",
  notAvailable: "storeDeletion.error.notAvailable",
  capReached: "storeDeletion.error.capReached",
  rateLimited: "storeDeletion.error.rateLimited",
  validation: "storeDeletion.error.validation",
} as const satisfies Record<string, MessageKey>;

const GUARD_CODES: ReadonlySet<string> = new Set([
  "store_has_open_shift",
  "store_has_unretired_device",
  "store_device_queue_unsynced",
  "store_has_open_count_session",
]);

function isBlocker(b: unknown): b is BlockerEntry {
  const x = b as { code?: unknown; count?: unknown } | null;
  return typeof x?.code === "string" && typeof x?.count === "number";
}

/** The `error.details.blockers` the server sent; an entry that is not `{ code, count }` is dropped. */
function blockersOf(error: unknown): BlockerEntry[] {
  const blockers = (error as { error?: { details?: { blockers?: unknown } } } | undefined)?.error
    ?.details?.blockers;
  return Array.isArray(blockers) ? blockers.filter(isBlocker) : [];
}

function rejected(messageKey: MessageKey, result: WrapperResult): DeletionOutcome {
  return { kind: "rejected", messageKey, requestId: errorRequestIdOf(result.error) };
}

function classify409(result: WrapperResult): DeletionOutcome {
  const code = errorCodeOf(result.error) ?? "";
  if (code === "preview_stale") return { kind: "stale" };
  if (GUARD_CODES.has(code)) return { kind: "blocked", blockers: blockersOf(result.error) };
  return rejected(KEY.generic, result);
}

/** The refusal a 403 carries, for the delete and for the re-authentication alike. */
function refusal403(result: WrapperResult): MessageKey {
  const code = errorCodeOf(result.error);
  // RT-1468: `support_session_required` now means the organization no longer exists.
  if (code === "support_session_required") return KEY.tenantUnavailable;
  return code === "store_deletion_owner_only" ? KEY.ownerOnly : KEY.forbidden;
}

function capOrRate(result: WrapperResult, rateLimited: MessageKey): MessageKey {
  return errorCodeOf(result.error) === "force_action_rate_limited" ? KEY.capReached : rateLimited;
}

/** Answers the delete read the same way whatever the route: 400, 401, 403, 404 and 429. */
function classifyCommon(
  result: WrapperResult,
  forbidden: (r: WrapperResult) => DeletionOutcome,
  rateLimited: MessageKey,
): DeletionOutcome | null {
  switch (result.status) {
    case 400:
      return rejected(KEY.validation, result);
    case 401:
      return { kind: "session" };
    case 403:
      return forbidden(result);
    case 404:
      return rejected(KEY.notAvailable, result);
    case 429:
      return rejected(capOrRate(result, rateLimited), result);
    default:
      return null;
  }
}

/** A 4xx the server decided on. 408 and 425 are a proxy or timing answer: the request may still be recorded. */
export function isDefiniteRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425;
}

export function classifyDeletionOutcome(result: DeleteResult): DeletionOutcome {
  if (result.status === 200) return { kind: "deleted", replay: result.replayed === true };
  const common = classifyCommon(
    result,
    (r) =>
      errorCodeOf(r.error) === "reauth_required"
        ? { kind: "reauthRequired" }
        : rejected(refusal403(r), r),
    KEY.rateLimited,
  );
  if (common) return common;
  if (result.status === 409) return classify409(result);
  // 408, 425, every 5xx and a lost answer (status 0): the delete may already be recorded.
  return isDefiniteRefusal(result.status)
    ? rejected(KEY.generic, result)
    : { kind: "retryable", requestId: errorRequestIdOf(result.error) };
}

export function classifyReauthOutcome(
  result: WrapperResult & { data?: { reauthToken?: unknown } },
): ReauthOutcome {
  const token = result.data?.reauthToken;
  if (result.status === 200 && typeof token === "string" && token !== "") {
    return { kind: "granted", token };
  }
  const common = classifyCommon(
    result,
    (r) =>
      rejected(
        errorCodeOf(r.error) === "reauth_failed" ? "storeDeletion.reauth.failed" : refusal403(r),
        r,
      ),
    "storeDeletion.reauth.rateLimited",
  );
  // Nothing was granted on 503, another 5xx or no answer: nothing was deleted either.
  const out = common ?? rejected("storeDeletion.reauth.unavailable", result);
  return out as ReauthOutcome;
}
