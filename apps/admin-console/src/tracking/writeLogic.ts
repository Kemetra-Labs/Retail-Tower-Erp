/**
 * RT-455 pure helpers for the four governed tracking commands (owner approval,
 * RT-455 comment 15245): place a quality hold, release a hold (owner only),
 * create a recall and correct an expiry date. No React, no fetch.
 *
 * Backend-Core owns every rule (what a hold moves, who may release, which date
 * is acceptable). These checks only keep the operator from sending a command
 * the contract already refuses: the fixed reason list (`SafetyReasonCodeInput`)
 * with «أخرى» needing a note (checked after trimming, as the runtime does), the
 * note and reference lengths, 1 to 100 distinct identities, and an `effectiveAt`
 * that is not in the future. A refusal that does get through is shown as sent.
 *
 * Until RT-453 writes identities every command answers 404: the outcome is a
 * refusal, never a success (owner, comment 15245).
 */
import type { MessageKey } from "@/i18n";
import type {
  BindResolutionCommand,
  CorrectExpiryCommand,
  CreateInventoryRecallCommand,
  PlaceQualityHoldCommand,
  ReleaseTrackingHoldCommand,
  SafetyReasonCodeInput,
} from "@/lib/tracking-queries";
import { REASON_CODES } from "./trackingLogic";

export const NOTE_MAX_LENGTH = 500;
export const REFERENCE_MAX_LENGTH = 200;
export const MAX_RECALL_IDENTITIES = 100;

// --- Reason and note -------------------------------------------------------------

export interface ReasonDraft {
  reason: SafetyReasonCodeInput | "";
  note: string;
}

export type WriteFieldError =
  | "tracking.write.error.reason"
  | "tracking.write.error.noteRequired"
  | "tracking.write.error.noteLength"
  | "tracking.write.error.bindNote"
  | "tracking.write.error.bindLines"
  | "tracking.write.error.reference"
  | "tracking.write.error.identities"
  | "tracking.write.error.tooMany"
  | "tracking.write.error.effectiveAt"
  | "tracking.write.error.date"
  | "tracking.write.error.dateRequired";

export type WriteErrors = Partial<
  Record<
    "reason" | "note" | "reference" | "identities" | "effectiveAt" | "date" | "lines",
    WriteFieldError
  >
>;

export function isReasonCode(value: string): value is SafetyReasonCodeInput {
  return (REASON_CODES as readonly string[]).includes(value);
}

/** «أخرى» needs a note (trimmed, as the runtime checks it). */
export function noteRequired(reason: SafetyReasonCodeInput | ""): boolean {
  return reason === "other";
}

function noteError(draft: { note: string; reason?: SafetyReasonCodeInput | "" }) {
  const note = draft.note.trim();
  if (note.length > NOTE_MAX_LENGTH) return "tracking.write.error.noteLength" as const;
  if (draft.reason !== undefined && noteRequired(draft.reason) && !note) {
    return "tracking.write.error.noteRequired" as const;
  }
  return undefined;
}

export function validateReason(draft: ReasonDraft): WriteErrors {
  const errors: WriteErrors = {};
  if (!isReasonCode(draft.reason)) errors.reason = "tracking.write.error.reason";
  const note = noteError(draft);
  if (note) errors.note = note;
  return errors;
}

/** A trimmed note, or nothing at all (an empty note is never sent). */
function noteOf(note: string): { note?: string } {
  const trimmed = note.trim();
  return trimmed ? { note: trimmed } : {};
}

// --- Place a quality hold ------------------------------------------------------------

export function buildHoldCommand(identityId: string, draft: ReasonDraft): PlaceQualityHoldCommand {
  return {
    trackingIdentityId: identityId,
    reasonCode: draft.reason as SafetyReasonCodeInput,
    ...noteOf(draft.note),
  };
}

// --- Release -----------------------------------------------------------------------

export function validateRelease(note: string): WriteErrors {
  const error = noteError({ note });
  return error ? { note: error } : {};
}

export function buildReleaseCommand(note: string): ReleaseTrackingHoldCommand {
  return noteOf(note);
}

// --- Recall --------------------------------------------------------------------------

export interface RecallDraft extends ReasonDraft {
  productId: string;
  identityIds: readonly string[];
  reference: string;
  /** `datetime-local` text, or "" for now (the server's time). */
  effectiveAt: string;
}

/** The `datetime-local` value as an instant, or undefined when empty or not a date. */
export function instantOf(local: string): Date | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function validateRecall(draft: RecallDraft, now: Date = new Date()): WriteErrors {
  const errors = validateReason(draft);
  const reference = draft.reference.trim();
  if (!reference || reference.length > REFERENCE_MAX_LENGTH) {
    errors.reference = "tracking.write.error.reference";
  }
  const ids = new Set(draft.identityIds);
  if (ids.size === 0) errors.identities = "tracking.write.error.identities";
  else if (ids.size > MAX_RECALL_IDENTITIES) errors.identities = "tracking.write.error.tooMany";
  if (draft.effectiveAt) {
    const at = instantOf(draft.effectiveAt);
    if (!at || at.getTime() > now.getTime())
      errors.effectiveAt = "tracking.write.error.effectiveAt";
  }
  return errors;
}

export function buildRecallCommand(draft: RecallDraft): CreateInventoryRecallCommand {
  const at = instantOf(draft.effectiveAt);
  return {
    tenantProductRef: draft.productId,
    trackingIdentityIds: [...new Set(draft.identityIds)],
    reasonCode: draft.reason as SafetyReasonCodeInput,
    reference: draft.reference.trim(),
    ...noteOf(draft.note),
    ...(at ? { effectiveAt: at.toISOString() } : {}),
  };
}

// --- Expiry correction ----------------------------------------------------------------

export interface ExpiryDraft extends ReasonDraft {
  /** `YYYY-MM-DD`; ignored when `clear` is set. */
  date: string;
  /**
   * Clear the expiry (`null`): an explicit choice, never the result of an empty
   * field. The server refuses it when the tracking profile requires an expiry.
   */
  clear: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` naming a day that exists (no 2027-02-30), independent of the browser. */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function validateExpiry(draft: ExpiryDraft): WriteErrors {
  const errors = validateReason(draft);
  if (draft.clear) return errors;
  if (!draft.date) errors.date = "tracking.write.error.dateRequired";
  else if (!isCalendarDate(draft.date)) errors.date = "tracking.write.error.date";
  return errors;
}

export function buildExpiryCommand(draft: ExpiryDraft): CorrectExpiryCommand {
  return {
    expiryDate: draft.clear ? null : draft.date,
    reasonCode: draft.reason as SafetyReasonCodeInput,
    ...noteOf(draft.note),
  };
}

// --- Bind a Tracking Resolution (RT-451 S5) ----------------------------------------

export interface BindDraft extends ReasonDraft {
  /** The identity chosen for each unresolved line, by `saleLineId`. */
  identities: Readonly<Record<string, string>>;
}

/**
 * The bind always needs a note (unlike a hold), a reason from the fixed list
 * and one identity for every unresolved line: the command names each line
 * exactly once or the server answers 400 and writes nothing. Which identity is
 * legal (product, hold, expiry) is the server's call.
 */
export function validateBind(draft: BindDraft, lineIds: readonly string[]): WriteErrors {
  const errors: WriteErrors = {};
  if (!isReasonCode(draft.reason)) errors.reason = "tracking.write.error.reason";
  const note = draft.note.trim();
  if (!note) errors.note = "tracking.write.error.bindNote";
  else if (note.length > NOTE_MAX_LENGTH) errors.note = "tracking.write.error.noteLength";
  if (lineIds.some((id) => !draft.identities[id])) errors.lines = "tracking.write.error.bindLines";
  return errors;
}

export function buildBindCommand(
  draft: BindDraft,
  lineIds: readonly string[],
): BindResolutionCommand {
  return {
    reasonCode: draft.reason as SafetyReasonCodeInput,
    note: draft.note.trim(),
    lines: lineIds.map((saleLineId) => ({
      saleLineId,
      trackingIdentityId: draft.identities[saleLineId],
    })),
  };
}

// --- Idempotency -------------------------------------------------------------------

export interface KeyedCommand {
  fingerprint: string;
  key: string;
}

/**
 * The Idempotency-Key for a command: the held one while the command is
 * unchanged (a retry after no answer cannot record it twice), else a new v4
 * UUID (inside the contract's 16 to 128 characters).
 */
export function keyFor(held: KeyedCommand | null, command: unknown): KeyedCommand {
  const fingerprint = JSON.stringify(command);
  return held?.fingerprint === fingerprint ? held : { fingerprint, key: crypto.randomUUID() };
}

// --- Outcome ----------------------------------------------------------------------

interface BackendError {
  error?: { code?: string; message?: string; request_id?: string };
}

export type WriteOutcome =
  | { kind: "recorded" }
  /** No response at all: whether it was recorded is unknown. */
  | { kind: "failed" }
  | {
      kind: "rejected";
      status: number;
      message?: string;
      code?: string;
      requestId?: string;
      retryAfter?: number;
    };

/** Only a 200 / 201 with a body is a success; everything else is the server's refusal. */
export function classifyWrite(result: {
  status: number;
  data?: unknown;
  error?: unknown;
  retryAfter?: number;
}): WriteOutcome {
  if ((result.status === 200 || result.status === 201) && result.data) return { kind: "recorded" };
  const body = (result.error as BackendError | undefined)?.error;
  return {
    kind: "rejected",
    status: result.status,
    message: body?.message,
    code: body?.code,
    requestId: body?.request_id,
    retryAfter: result.retryAfter,
  };
}

/** A conflict on the key itself: the next attempt needs a fresh key. */
export function isKeyConflict(outcome: WriteOutcome): boolean {
  return outcome.kind === "rejected" && outcome.code === "idempotency_key_conflict";
}

const CODE_HINTS: Record<string, MessageKey> = {
  hold_already_active: "tracking.write.hint.holdActive",
  expiry_unchanged: "tracking.write.hint.expiryUnchanged",
  tracking_resolution_identity_mismatch: "tracking.write.hint.resolutionMismatch",
  tracking_resolution_identity_held: "tracking.write.hint.resolutionHeld",
  tracking_resolution_identity_expired: "tracking.write.hint.resolutionExpired",
  tracking_resolution_already_resolved: "tracking.write.hint.resolutionResolved",
};

/**
 * A line the console adds under a refusal (the server's own words stay as sent):
 * the known 409 codes, and the 404 every command answers until RT-453.
 */
export function refusalHint(
  outcome: WriteOutcome,
  notFound: MessageKey = "tracking.write.hint.notFound",
): MessageKey | undefined {
  if (outcome.kind !== "rejected") return undefined;
  if (outcome.code && Object.hasOwn(CODE_HINTS, outcome.code)) return CODE_HINTS[outcome.code];
  if (outcome.status === 404) return notFound;
  if (outcome.status === 403) return "tracking.write.hint.forbidden";
  return undefined;
}
