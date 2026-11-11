/**
 * RT-1109: what the vouchers page does with each answer. Pure, no React.
 *
 * ISSUE is non-replayable (RT-82 K3). The codes are never stored server-side,
 * so a same-key retry is 409 `idempotency_key_conflict` within the 72 h window
 * and never returns the first batch. Every issue attempt therefore carries a
 * NEW key (`newIdempotencyKey`) and is never retried automatically. When the answer
 * is lost or unclear (network failure, 5xx, 425, a key conflict), the batch may
 * already exist: the page says so, stops offering Issue, and sends the operator
 * to the list to cancel any voucher they cannot hand out, as the contract asks.
 *
 *   201                          → issued: show the codes, once
 *   400 validation_failure       → form-level error (nothing was issued)
 *   400 idempotency_key_*        → generic error (rejected before any issue)
 *   401                          → session
 *   403                          → forbidden (role, all-stores scope or Origin)
 *   404 store_not_found          → store unavailable (non-disclosing)
 *   409 store_inactive           → store inactive
 *   409 idempotency_key_conflict → uncertain
 *   425, 5xx, network            → uncertain
 *   429                          → rate limited (nothing was issued)
 *
 * CANCEL is replayable: the same key and request replay the stored 200, so the
 * key belongs to the voucher being cancelled and is kept until a terminal answer.
 *
 * Copy is a catalog key; the server's message never shows, the request id does.
 */
import type { MessageKey } from "@/i18n";

interface ErrorBody {
  error?: { code?: string; request_id?: string } | string;
}

export interface WrapperResult {
  status: number;
  error?: unknown;
}

function codeOf(result: WrapperResult): string | undefined {
  const inner = (result.error as ErrorBody | undefined)?.error;
  return typeof inner === "object" ? inner?.code : undefined;
}

export function requestIdOf(result: WrapperResult): string | undefined {
  const inner = (result.error as ErrorBody | undefined)?.error;
  return typeof inner === "object" ? inner?.request_id : undefined;
}

/** A fresh Idempotency-Key (v4 UUID, inside `^[\x21-\x7E]{16,128}$`): one per issue attempt, one per voucher cancel. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export type IssueOutcome =
  | { kind: "issued" }
  | { kind: "rejected"; messageKey: MessageKey; requestId?: string }
  | { kind: "session"; messageKey: MessageKey }
  | { kind: "uncertain"; requestId?: string };

const ISSUE_404: MessageKey = "vouchers.issue.errors.storeUnavailable";

export function classifyIssueOutcome(result: WrapperResult): IssueOutcome {
  const requestId = requestIdOf(result);
  const code = codeOf(result);
  switch (result.status) {
    case 201:
      return { kind: "issued" };
    case 400:
      return code === "validation_failure"
        ? { kind: "rejected", messageKey: "vouchers.issue.errors.validation", requestId }
        : { kind: "rejected", messageKey: "vouchers.issue.errors.generic", requestId };
    case 401:
      return { kind: "session", messageKey: "vouchers.errors.session" };
    case 403:
      return { kind: "rejected", messageKey: "vouchers.issue.errors.forbidden", requestId };
    case 404:
      return { kind: "rejected", messageKey: ISSUE_404, requestId };
    case 409:
      return code === "store_inactive"
        ? { kind: "rejected", messageKey: "vouchers.issue.errors.storeInactive", requestId }
        : { kind: "uncertain", requestId };
    case 429:
      return { kind: "rejected", messageKey: "vouchers.errors.rateLimited", requestId };
    default:
      // 425 and every 5xx: the server may have issued the batch.
      return result.status >= 400 && result.status < 500 && result.status !== 425
        ? { kind: "rejected", messageKey: "vouchers.issue.errors.generic", requestId }
        : { kind: "uncertain", requestId };
  }
}

export type CancelOutcome =
  | { kind: "cancelled"; alreadyCancelled: boolean }
  | { kind: "failed"; messageKey: MessageKey; requestId?: string; keepKey: boolean };

export function classifyCancelOutcome(
  result: WrapperResult & { data?: { already_cancelled?: boolean } },
): CancelOutcome {
  const requestId = requestIdOf(result);
  const code = codeOf(result);
  if (result.status === 200) {
    return { kind: "cancelled", alreadyCancelled: result.data?.already_cancelled === true };
  }
  const fail = (messageKey: MessageKey, keepKey: boolean): CancelOutcome => ({
    kind: "failed",
    messageKey,
    requestId,
    keepKey,
  });
  switch (result.status) {
    case 401:
      return fail("vouchers.errors.session", false);
    case 403:
      return fail("vouchers.detail.cancelForbidden", false);
    case 404:
      return fail("vouchers.detail.notFound", false);
    case 409:
      return code === "voucher_already_redeemed"
        ? fail("vouchers.detail.cancelRedeemed", false)
        : fail("vouchers.detail.cancelFailed", false);
    case 425:
      // Still in progress under this key: retrying with the same key replays its answer.
      return fail("vouchers.detail.cancelInProgress", true);
    case 429:
      return fail("vouchers.errors.rateLimited", true);
    default:
      // A 5xx may have cancelled it: the same key replays the stored answer.
      return fail("vouchers.detail.cancelFailed", result.status >= 500);
  }
}
