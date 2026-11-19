/**
 * RT-1312 pure helpers for the sale quarantine queue (sales a till could not get Backend-Core to
 * accept). No React, no fetch. RT-399: helpers return catalog message keys, never copy.
 *
 * Truth rules: the state is the server's (`open`, `captured`, `already-captured`, `written-off`),
 * a value this build does not know is unknown and never `open` (the contract's Evolution clause),
 * and the till's `reasonKind` is a claim, not a finding. A written-off item created no sale, no
 * posting and no stock effect; the copy never says it was posted or lost.
 *
 * This is NOT the ERP-sync dead-letter queue of `src/sale-sync/` (RT-726): that one lists sales
 * Backend-Core captured whose processing stopped. The roles are the same and are shared.
 */
import type { MessageKey } from "@/i18n";
import type { QuarantinedSale } from "@/lib/sale-quarantine-queries";
import { errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";

/** The contract's `QuarantineWriteOffRequest.note` bound (1 to 500 characters). */
export const WRITE_OFF_NOTE_MAX = 500;

const STATES = ["open", "captured", "already-captured", "written-off"] as const;

/** The `?state=` filter: "" (the open queue) or one of the contract's four states. */
export function isQuarantineStateFilter(value: string): boolean {
  return value === "" || (STATES as readonly string[]).includes(value);
}

export interface QuarantineStateView {
  labelKey: MessageKey;
  /** The sentence under the state that says what it does and does not mean. */
  meaningKey: MessageKey;
  /** The label always carries the meaning; the colour only reinforces it. */
  badge: "" | "badge--pending" | "badge--warning" | "badge--danger";
}

const STATE_VIEWS: Record<string, QuarantineStateView> = {
  open: {
    labelKey: "saleQuarantine.state.open",
    meaningKey: "saleQuarantine.meaning.open",
    badge: "badge--warning",
  },
  captured: {
    labelKey: "saleQuarantine.state.captured",
    meaningKey: "saleQuarantine.meaning.captured",
    badge: "",
  },
  "already-captured": {
    labelKey: "saleQuarantine.state.alreadyCaptured",
    meaningKey: "saleQuarantine.meaning.alreadyCaptured",
    badge: "",
  },
  "written-off": {
    labelKey: "saleQuarantine.state.writtenOff",
    meaningKey: "saleQuarantine.meaning.writtenOff",
    badge: "badge--pending",
  },
};

const UNKNOWN_STATE: QuarantineStateView = {
  labelKey: "saleQuarantine.state.unknown",
  meaningKey: "saleQuarantine.meaning.unknown",
  badge: "badge--danger",
};

export function quarantineStateView(code: string): QuarantineStateView {
  return Object.hasOwn(STATE_VIEWS, code) ? STATE_VIEWS[code] : UNKNOWN_STATE;
}

/** The write-off is offered only for an item the server says is `open`; it still decides (409). */
export function canWriteOff(item: Pick<QuarantinedSale, "state">): boolean {
  return item.state === "open";
}

const REASON_KEYS: Record<string, MessageKey> = {
  refused: "saleQuarantine.reason.refused",
  payload_divergence: "saleQuarantine.reason.payloadDivergence",
  cashier_claim_refused: "saleQuarantine.reason.cashierClaimRefused",
  held_previous_pairing: "saleQuarantine.reason.heldPreviousPairing",
};

/** The till's claim of why the sale is stuck. An unlisted kind reads as unknown. */
export function reasonKindKey(code: string): MessageKey {
  return Object.hasOwn(REASON_KEYS, code) ? REASON_KEYS[code] : "saleQuarantine.reason.unknown";
}

/** The reason note: required (the server's `minLength: 1` accepts spaces, this does not). */
export function writeOffNoteProblem(raw: string): MessageKey | null {
  const note = raw.trim();
  if (note.length === 0) return "saleQuarantine.writeOff.note.required";
  return note.length > WRITE_OFF_NOTE_MAX ? "saleQuarantine.writeOff.note.tooLong" : null;
}

/** Keyset paging: only a null cursor ends the walk. */
export function nextQuarantineCursor(page: { nextCursor: string | null }): string | undefined {
  return page.nextCursor ?? undefined;
}

// --- Write-off outcome ----------------------------------------------------------------

export interface WriteOffResult {
  status: number;
  data?: QuarantinedSale;
  error?: unknown;
  retryAfter?: number;
}

type RefusalKind =
  | "conflict"
  | "key-conflict"
  | "not-found"
  | "forbidden"
  | "session"
  | "rejected"
  | "rate-limited"
  | "unconfirmed";

export type WriteOffOutcome =
  | { kind: "written-off"; item: QuarantinedSale }
  | { kind: RefusalKind; messageKey: MessageKey; requestId?: string; retryAfter?: number };

type RefusalView = { kind: RefusalKind; messageKey: MessageKey };

/** Refusals by status, or by `status:code` where the code changes the meaning. */
const REFUSALS: Record<string, RefusalView> = {
  "400": { kind: "rejected", messageKey: "saleQuarantine.writeOff.error.rejected" },
  "401": { kind: "session", messageKey: "saleSync.error.session" },
  "403": { kind: "forbidden", messageKey: "saleQuarantine.writeOff.error.forbidden" },
  "403:origin_rejected": {
    kind: "forbidden",
    messageKey: "saleQuarantine.writeOff.error.originRejected",
  },
  "404": { kind: "not-found", messageKey: "saleQuarantine.writeOff.error.notFound" },
  "409": { kind: "conflict", messageKey: "saleQuarantine.writeOff.error.conflict" },
  "409:idempotency_key_conflict": {
    kind: "key-conflict",
    messageKey: "saleQuarantine.writeOff.error.keyConflict",
  },
};

/** Anything unlisted (a 5xx, no response, a 200 without the item) may have been applied. */
const UNCONFIRMED: RefusalView = {
  kind: "unconfirmed",
  messageKey: "saleQuarantine.writeOff.error.unconfirmed",
};

/**
 * Maps the server's answer to what the operator sees. Only a 200 with the item is a write-off; a
 * 5xx or a lost response is "unconfirmed" (the server may have acted), never "failed". Nothing
 * here retries.
 */
export function classifyWriteOff(result: WriteOffResult): WriteOffOutcome {
  if (result.status === 200 && result.data) return { kind: "written-off", item: result.data };
  const requestId = errorRequestIdOf(result.error);
  if (result.status === 429) {
    const { retryAfter } = result;
    return {
      kind: "rate-limited",
      messageKey: retryAfter
        ? "saleQuarantine.writeOff.error.rateLimitedFor"
        : "saleQuarantine.writeOff.error.rateLimited",
      requestId,
      retryAfter,
    };
  }
  const code = errorCodeOf(result.error);
  const view = REFUSALS[`${result.status}:${code}`] ?? REFUSALS[String(result.status)];
  return { ...(view ?? UNCONFIRMED), requestId };
}

/**
 * Whether the next confirmation may send the same Idempotency-Key: after an unconfirmed or
 * rate-limited attempt the same key replays the stored answer instead of asking twice. Any
 * answered outcome ends the key.
 */
export function keepsKey(outcome: WriteOffOutcome): boolean {
  return outcome.kind === "unconfirmed" || outcome.kind === "rate-limited";
}
