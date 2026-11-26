/**
 * RT-1601: what the redistribution screens do with each answer of a command. Pure, no React.
 *
 * Every command is replayable under its Idempotency-Key, so the key belongs to the intended action
 * (`KeyedAttempt`): it is kept through an answer that may not have landed (425, 5xx, no answer) and a
 * 429 (nothing ran), and dropped on a terminal answer.
 *
 *   200 / 201                            → ok
 *   400                                  → validation (nothing was written)
 *   401                                  → session
 *   403 origin_rejected                  → origin
 *   404                                  → not available (non-disclosing: never says why)
 *   409 proposal_superseded / _expired /
 *       _state_conflict / _line_already_decided → moved: read the proposal again
 *   409 proposal_stale                   → every listed line would drop: compute a new proposal
 *   409 idempotency_key_conflict         → generic
 *   422 redistribution_*                 → one named compute refusal
 *   425, 5xx, no answer                  → uncertain: the command may have landed; same key replays
 *   429                                  → rate limited (nothing ran)
 *
 * Copy is a catalog key; the server's message never shows, the request id does.
 */
import type { MessageKey } from "@/i18n";
import { type WrapperResult, errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";

export type RedistributionOutcome<T> =
  | { kind: "ok"; data: T }
  | {
      kind: "failed";
      messageKey: MessageKey;
      requestId?: string;
      /** The answer may not have landed: the same key replays it. */
      keepKey: boolean;
      /** The proposal moved under the caller: read it again. */
      refresh: boolean;
    };

const CONFLICTS: Record<string, MessageKey> = {
  proposal_superseded: "redistribution.error.superseded",
  proposal_expired: "redistribution.error.expired",
  proposal_state_conflict: "redistribution.error.stateConflict",
  proposal_line_already_decided: "redistribution.error.lineDecided",
  proposal_stale: "redistribution.error.stale",
};

const REFUSALS: Record<string, MessageKey> = {
  redistribution_too_large: "redistribution.error.tooLarge",
  redistribution_deadline_exceeded: "redistribution.error.deadline",
  redistribution_plan_invalid: "redistribution.error.planInvalid",
};

function fail(
  messageKey: MessageKey,
  requestId: string | undefined,
  opts: { keepKey?: boolean; refresh?: boolean } = {},
): RedistributionOutcome<never> {
  return {
    kind: "failed",
    messageKey,
    requestId,
    keepKey: opts.keepKey ?? false,
    refresh: opts.refresh ?? false,
  };
}

function classify409(code: string | undefined, requestId?: string): RedistributionOutcome<never> {
  const key = code ? CONFLICTS[code] : undefined;
  if (!key) return fail("redistribution.error.generic", requestId);
  return fail(key, requestId, { refresh: true });
}

/** Where an answer goes. `data` of an ok is the response body, typed by the caller. */
export function classifyRedistributionResult<T>(
  result: WrapperResult & { data?: T },
): RedistributionOutcome<T> {
  const { status, error, data } = result;
  if (status < 300 && data !== undefined) return { kind: "ok", data };
  const requestId = errorRequestIdOf(error);
  const code = errorCodeOf(error);
  switch (status) {
    case 400:
      return fail("redistribution.error.validation", requestId);
    case 401:
      return fail("redistribution.error.session", requestId);
    case 403:
      return fail("redistribution.error.origin", requestId);
    case 404:
      return fail("redistribution.error.notAvailable", requestId);
    case 409:
      return classify409(code, requestId);
    case 422:
      return fail(REFUSALS[code ?? ""] ?? "redistribution.error.generic", requestId);
    case 425:
      return fail("redistribution.error.uncertain", requestId, { keepKey: true });
    case 429:
      return fail("redistribution.error.rateLimited", requestId, { keepKey: true });
    default:
      return status >= 500
        ? fail("redistribution.error.uncertain", requestId, { keepKey: true })
        : fail("redistribution.error.generic", requestId);
  }
}

/** A thrown request (offline, aborted) is the uncertain case: the command may have landed. */
export const UNCERTAIN: RedistributionOutcome<never> = {
  kind: "failed",
  messageKey: "redistribution.error.uncertain",
  keepKey: true,
  refresh: true,
};
