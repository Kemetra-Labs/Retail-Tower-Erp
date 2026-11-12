/**
 * RT-1338: what the offers screens do with each answer of a write or a preview. Pure, no React.
 *
 * Every offer write is replayable under its Idempotency-Key, so the key belongs to the intended
 * action (`KeyedAttempt`): it is kept through an answer that may not have landed (425, 5xx, no
 * answer) and a 429 (nothing ran), and dropped on a terminal answer.
 *
 *   200 / 201                            → ok
 *   400                                  → validation (nothing was written)
 *   401                                  → session
 *   403                                  → forbidden (role, store scope or Origin)
 *   404 offer_not_found                  → the offer is gone or not visible
 *   404 store_not_found                  → a store is outside the caller's scope
 *   409 offer_draft_changed_concurrently → stale: the draft moved; read it again
 *   409 offer_state_invalid              → stale view: the offer moved state; read it again
 *   409 offer_conflict                   → conflicts, listed (OD-7)
 *   409 idempotency_key_conflict         → generic (the key was used with another body)
 *   422 offer_*                          → one named reason (a publish refusal or a pause scope)
 *   425, 5xx, no answer                  → uncertain: the write may have landed; same key replays
 *   429                                  → rate limited (nothing ran)
 *
 * Copy is a catalog key; the server's message never shows, the request id does.
 */
import type { MessageKey } from "@/i18n";
import type { OfferConflict, OfferError } from "@/lib/offer-queries";
import { type WrapperResult, errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";

export type OfferOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "conflict"; conflicts: OfferConflict[]; requestId?: string }
  /** The draft or the offer moved under the caller; `stateInvalid` is the state, not the draft. */
  | { kind: "stale"; requestId?: string; stateInvalid?: boolean }
  | { kind: "failed"; messageKey: MessageKey; requestId?: string; keepKey: boolean };

const UNPROCESSABLE: Record<string, MessageKey> = {
  offer_reference_invalid: "offers.issue.offer_reference_invalid",
  offer_eligible_set_empty: "offers.issue.offer_eligible_set_empty",
  offer_eligible_set_too_large: "offers.issue.offer_eligible_set_too_large",
  offer_schedule_elapsed: "offers.issue.offer_schedule_elapsed",
  offer_store_offer_limit_exceeded: "offers.issue.offer_store_offer_limit_exceeded",
  offer_store_not_in_scope: "offers.error.storeNotInScope",
};

function conflictsOf(error: unknown): OfferConflict[] {
  const list = (error as OfferError | undefined)?.error?.conflicts;
  return Array.isArray(list) ? list : [];
}

const fail = (
  messageKey: MessageKey,
  requestId: string | undefined,
  keepKey = false,
): OfferOutcome<never> => ({ kind: "failed", messageKey, requestId, keepKey });

function classify409(code: string | undefined, error: unknown, requestId?: string) {
  switch (code) {
    case "offer_conflict":
      return { kind: "conflict", conflicts: conflictsOf(error), requestId } as const;
    case "offer_draft_changed_concurrently":
      return { kind: "stale", requestId } as const;
    case "offer_state_invalid":
      return { kind: "stale", requestId, stateInvalid: true } as const;
    default:
      return fail("offers.error.generic", requestId);
  }
}

/** Where an answer goes. `data` of an ok is the response body, typed by the caller. */
export function classifyOfferResult<T>(result: WrapperResult & { data?: T }): OfferOutcome<T> {
  const requestId = errorRequestIdOf(result.error);
  const code = errorCodeOf(result.error);
  const { status } = result;
  if (status < 300 && result.data !== undefined) return { kind: "ok", data: result.data };
  switch (status) {
    case 400:
      return fail("offers.error.validation", requestId);
    case 401:
      return fail("offers.error.session", requestId);
    case 403:
      return fail(
        code === "origin_rejected" ? "offers.error.origin" : "offers.error.forbidden",
        requestId,
      );
    case 404:
      return fail(
        code === "store_not_found" ? "offers.error.storeNotFound" : "offers.error.notFound",
        requestId,
      );
    case 409:
      return classify409(code, result.error, requestId);
    case 422:
      return fail(UNPROCESSABLE[code ?? ""] ?? "offers.error.generic", requestId);
    case 425:
      return fail("offers.error.uncertain", requestId, true);
    case 429:
      return fail("offers.error.rateLimited", requestId, true);
    default:
      return status >= 500
        ? fail("offers.error.uncertain", requestId, true)
        : fail("offers.error.generic", requestId);
  }
}

/** A thrown request (offline, aborted) is the uncertain case: the write may have landed. */
export const UNCERTAIN: OfferOutcome<never> = {
  kind: "failed",
  messageKey: "offers.error.uncertain",
  keepKey: true,
};

const ISSUE_KEYS: Record<string, MessageKey> = {
  offer_reference_invalid: "offers.issue.offer_reference_invalid",
  offer_eligible_set_empty: "offers.issue.offer_eligible_set_empty",
  offer_eligible_set_too_large: "offers.issue.offer_eligible_set_too_large",
  offer_schedule_elapsed: "offers.issue.offer_schedule_elapsed",
  offer_store_offer_limit_exceeded: "offers.issue.offer_store_offer_limit_exceeded",
};

/** The catalog key for a preview issue code; a code this build does not know reads as generic. */
export function issueKey(code: string): MessageKey {
  return ISSUE_KEYS[code] ?? "offers.issue.unknown";
}

/** One banner above the editor: the last thing that happened, in catalog copy. */
export interface OfferNotice {
  variant: "success" | "warning" | "danger";
  messageKey: MessageKey;
  requestId?: string;
  /** A publish or resume refused for overlapping offers (OD-7): listed under the banner. */
  conflicts?: OfferConflict[];
}

/** The banner for an outcome: `okKey` names a success; every failure has its own words. */
export function noticeOf(outcome: OfferOutcome<unknown>, okKey: MessageKey): OfferNotice {
  switch (outcome.kind) {
    case "ok":
      return { variant: "success", messageKey: okKey };
    case "conflict":
      return {
        variant: "danger",
        messageKey: "offers.error.conflict",
        requestId: outcome.requestId,
        conflicts: outcome.conflicts,
      };
    case "stale":
      return {
        variant: "warning",
        messageKey: outcome.stateInvalid ? "offers.error.stateInvalid" : "offers.error.stale",
        requestId: outcome.requestId,
      };
    default:
      return {
        variant: outcome.keepKey ? "warning" : "danger",
        messageKey: outcome.messageKey,
        requestId: outcome.requestId,
      };
  }
}
