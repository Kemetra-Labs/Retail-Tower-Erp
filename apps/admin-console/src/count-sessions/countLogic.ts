/**
 * RT-1425 pure helpers for the Count Session screens (RT-1419 contract). No
 * React, no fetch.
 *
 * Truth rules: the server decides every rule (state moves, the approver
 * separation, who may self-approve, which lines can post). The console only
 * hides what the contract already refuses, shows each typed refusal by its
 * machine code, and never invents a field the contract does not serve: ERP
 * status is the session `state` (`posting`, `confirmed`, `needs_attention`),
 * nothing per chunk and nothing from ERPNext.
 *
 * RT-399: helpers return catalog message keys, never copy.
 */
import type { MessageKey } from "@/i18n";
import type {
  CountObservationInput,
  CountSession,
  CountSessionState,
  CountVarianceFlag,
  CountVarianceLine,
  InventoryStatus,
} from "@/lib/count-session-queries";
import { errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";

function keyOf(map: Record<string, MessageKey>, code: string, fallback: MessageKey): MessageKey {
  return Object.hasOwn(map, code) ? map[code] : fallback;
}

// --- States, flags, refusals ------------------------------------------------

const STATE_KEYS: Record<CountSessionState, MessageKey> = {
  open: "counts.state.open",
  cut_taken: "counts.state.cut_taken",
  submitted: "counts.state.submitted",
  approved: "counts.state.approved",
  posting: "counts.state.posting",
  confirmed: "counts.state.confirmed",
  needs_attention: "counts.state.needs_attention",
  closed: "counts.state.closed",
  cancelled: "counts.state.cancelled",
};

export function countStateKey(state: string): MessageKey {
  return keyOf(STATE_KEYS, state, "counts.value.unknown");
}

/** Badge tone per state: only a state that needs a person is loud (UX-10.29). */
export function countStateTone(state: string): string {
  if (state === "needs_attention") return "badge--danger";
  if (state === "posting" || state === "submitted") return "badge--warning";
  if (state === "confirmed" || state === "approved") return "badge--success";
  return "";
}

/** The states after approval, whose status is the ERP result (server-set only). */
const ERP_STATES: readonly CountSessionState[] = ["posting", "confirmed", "needs_attention"];

export function isErpState(state: string): boolean {
  return (ERP_STATES as readonly string[]).includes(state);
}

/** Blind capture is only possible in these two states. */
export function canCapture(state: string): boolean {
  return state === "open" || state === "cut_taken";
}

/** Before approval a session can still be cancelled (409 from the server otherwise). */
export function canCancel(state: string): boolean {
  return state === "open" || state === "cut_taken" || state === "submitted";
}

/** Variance lines exist from `submitted` on; before that the server answers 409. */
export function hasReview(state: string): boolean {
  return state !== "open" && state !== "cut_taken" && state !== "cancelled";
}

const FLAG_KEYS: Record<CountVarianceFlag, MessageKey> = {
  divergence: "counts.flag.divergence",
  stale_snapshot: "counts.flag.stale_snapshot",
  pending: "counts.flag.pending",
  unmapped: "counts.flag.unmapped",
  uom_mismatch: "counts.flag.uom_mismatch",
};

export function flagKey(flag: string): MessageKey {
  return keyOf(FLAG_KEYS, flag, "counts.value.unknown");
}

const REFUSAL_KEYS: Record<string, MessageKey> = {
  count_up_without_valuation_history: "counts.refusal.count_up_without_valuation_history",
  count_line_unmapped: "counts.refusal.count_line_unmapped",
  count_line_uom_mismatch: "counts.refusal.count_line_uom_mismatch",
};

export function refusalKey(code: string): MessageKey {
  return keyOf(REFUSAL_KEYS, code, "counts.value.unknown");
}

export function assessmentKey(code: string): MessageKey {
  return code === "understated" ? "counts.late.understated" : "counts.late.overstated";
}

// --- Approval ---------------------------------------------------------------

/** True when the session was approved under the audited small-merchant exception. */
export function isSelfApproved(session: Pick<CountSession, "approval">): boolean {
  return session.approval?.selfApproved === true;
}

/** The viewer took part in the count (a counter or the submitter): advisory only. */
export function tookPart(
  session: Pick<CountSession, "counterIds" | "submittedBy">,
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  return session.submittedBy === userId || session.counterIds.includes(userId);
}

/** A line that needs the reviewer's explicit acknowledgement before approval. */
export function needsAcknowledgement(line: CountVarianceLine): boolean {
  return line.acknowledgementRequired && line.refusal === null;
}

/** A line that cannot post: the rest of the session proceeds without it. */
export function isRefusedLine(line: CountVarianceLine): boolean {
  return line.refusal !== null;
}

/** product id -> the `lineVersion` the reviewer acknowledged. */
export type Acknowledged = Readonly<Record<string, string>>;

/** An acknowledgement counts only for the exact line version it was given for. */
export function isAcknowledged(line: CountVarianceLine, acked: Acknowledged): boolean {
  return acked[line.productId] === line.lineVersion;
}

export function pendingAcknowledgements(
  lines: readonly CountVarianceLine[],
  acked: Acknowledged,
): CountVarianceLine[] {
  return lines.filter((l) => needsAcknowledgement(l) && !isAcknowledged(l, acked));
}

/** Approve is possible once every page is loaded and every flagged line is acknowledged. */
export function canApprove(
  lines: readonly CountVarianceLine[],
  complete: boolean,
  acked: Acknowledged,
): boolean {
  return complete && lines.length > 0 && pendingAcknowledgements(lines, acked).length === 0;
}

/** The strict approve command: one acknowledgement per flagged line, with its version. */
export function buildApproveCommand(lines: readonly CountVarianceLine[], acked: Acknowledged) {
  return {
    acknowledgements: lines
      .filter((l) => needsAcknowledgement(l) && isAcknowledged(l, acked))
      .map((l) => ({ productId: l.productId, lineVersion: l.lineVersion })),
  };
}

// --- Capture validation -------------------------------------------------------

/** Contract `NonNegativeDecimalQuantity`: unsigned, <= 15 integer and <= 4 fraction digits. */
const QUANTITY = /^[0-9]{1,15}(\.[0-9]{1,4})?$/;
const UNIT_MAX = 32;
export const REASON_MAX = 500;

/** The inventory statuses a counter can count in; holds belong to the tracking workflow. */
export const COUNT_STATUSES = [
  "sellable",
  "return_inspection",
  "damaged",
  "expired",
] as const satisfies readonly InventoryStatus[];

export interface ObservationDraft {
  productId: string;
  locationId: string;
  inventoryStatus: string;
  /** Exactly as typed; never parsed as a number. */
  quantity: string;
  unit: string;
}

export type ObservationErrors = Partial<
  Record<"product" | "location" | "quantity" | "unit", MessageKey>
>;

export function validateObservation(draft: ObservationDraft): ObservationErrors {
  const errors: ObservationErrors = {};
  if (!draft.productId) errors.product = "counts.capture.error.product";
  if (!draft.locationId) errors.location = "counts.capture.error.location";
  if (!QUANTITY.test(draft.quantity.trim())) errors.quantity = "counts.capture.error.quantity";
  const unit = draft.unit.trim();
  if (!unit || unit.length > UNIT_MAX) errors.unit = "counts.capture.error.unit";
  return errors;
}

/** The strict observation: store, tenant and actor are server-side and never sent. */
export function buildObservation(draft: ObservationDraft): CountObservationInput {
  return {
    productId: draft.productId,
    locationId: draft.locationId,
    inventoryStatus: draft.inventoryStatus as InventoryStatus,
    countedQuantity: draft.quantity.trim(),
    stockingUnit: draft.unit.trim(),
  };
}

// --- Write outcome ------------------------------------------------------------

const CONFLICT_KEYS: Record<string, MessageKey> = {
  count_session_not_in_state: "counts.error.notInState",
  count_tracked_product_refused: "counts.error.trackedRefused",
  count_scope_in_use: "counts.error.scopeInUse",
  count_cut_barrier_not_met: "counts.error.cutBlocked",
  count_approver_conflict: "counts.error.approverConflict",
  count_flagged_line_not_acknowledged: "counts.error.notAcknowledged",
  count_line_version_stale: "counts.error.lineStale",
  idempotency_key_conflict: "counts.error.keyConflict",
};

export type CountOutcome<D = unknown> =
  | { kind: "ok"; data: D | undefined }
  /** The request got no response: whether it was applied is unknown. */
  | { kind: "failed" }
  | {
      kind: "rejected";
      status: number;
      /** The catalog message for the status or typed 409 code. */
      messageKey: MessageKey;
      /** The server's machine code, shown beside the message. */
      code?: string;
      requestId?: string;
      retryAfter?: number;
    };

const STATUS_KEYS: Record<number, MessageKey> = {
  400: "counts.error.validation",
  401: "counts.error.session",
  403: "counts.error.forbidden",
  404: "counts.error.notFound",
  429: "counts.error.rateLimited",
};

export function classifyCountResult<D>(result: {
  status: number;
  data?: D;
  error?: unknown;
  retryAfter?: number;
}): CountOutcome<D> {
  if (result.status === 200 || result.status === 201) return { kind: "ok", data: result.data };
  const code = errorCodeOf(result.error);
  const messageKey =
    result.status === 409 && code
      ? keyOf(CONFLICT_KEYS, code, "counts.error.conflict")
      : (STATUS_KEYS[result.status] ?? "counts.error.generic");
  return {
    kind: "rejected",
    status: result.status,
    messageKey,
    code,
    requestId: errorRequestIdOf(result.error),
    retryAfter: result.retryAfter,
  };
}

/** A line the approval refused as changed since review: the lines must be re-read. */
export function isStaleLine(outcome: CountOutcome): boolean {
  return outcome.kind === "rejected" && outcome.code === "count_line_version_stale";
}

/**
 * The attempt reached a terminal answer, so the next one is a new action with a new
 * key. A lost answer, a 429 and a 5xx keep the key so the retry replays the same write.
 */
export function settlesAttempt(outcome: CountOutcome): boolean {
  if (outcome.kind === "ok") return true;
  if (outcome.kind === "failed") return false;
  return outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429;
}
