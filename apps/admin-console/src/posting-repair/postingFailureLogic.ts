/**
 * RT-1072 (RT-977 §7, §10 slice 2) pure helpers for the sale detail's ERPNext
 * posting-failure banner and its repair. No React, no fetch.
 *
 * Every line the banner shows traces to a contract field:
 *   - What: `erpPosting.sale` / `erpPosting.reversal` = `failed`;
 *   - cause: `erpPostingFailure.<side>.rejectionCategory` (an open set, D6: an
 *     unknown or null value gets the generic line);
 *   - Safety: the detail read itself, and `repairPosting` never mutating the sale;
 *   - Action: `disclosure` and `repair` (the handle), never the client role;
 *   - Evidence: `deadLetteredAt`, and `reason` only under `full`.
 *
 * Disclosure is the server's (D2): under `category_only` the reason, the
 * RT-332 document and the repair handle are never shown, even if sent.
 * A `reconciliation_required` dead-letter is never offered a repair (RT-332).
 *
 * RT-399: helpers return catalog message keys, never copy.
 */
import type { MessageKey } from "@/i18n";
import type { PostingRepairResult, RecordedRepair } from "@/lib/erp-posting-repair-queries";
import type { SaleDetail } from "@/lib/sale-queries";

export type PostingSide = "sale" | "reversal";
export type PostingFailure = NonNullable<SaleDetail["erpPostingFailure"]>;
export type PostingFailureDetail = NonNullable<PostingFailure["sale"]>;
export type Disclosure = PostingFailure["disclosure"];

const SIDES: readonly PostingSide[] = ["sale", "reversal"];

const WHAT_KEYS: Record<PostingSide, MessageKey> = {
  sale: "sales.erpFailure.sale",
  reversal: "sales.erpFailure.reversal",
};

const FIELD_KEYS: Record<PostingSide, MessageKey> = {
  sale: "sales.erp.sale",
  reversal: "sales.erp.reversal",
};

export const RECONCILIATION_REQUIRED = "reconciliation_required";

/** The categories whose map `repairPosting` re-checks (RT-977 §7): "fix the mapping first". */
const MAPPING_CATEGORIES: readonly string[] = ["unmapped_item", "unmapped_store"];

const CAUSE_KEYS: Record<string, MessageKey> = {
  unmapped_item: "postingRepair.cause.unmappedItem",
  unmapped_store: "postingRepair.cause.unmappedStore",
  unmapped_account: "postingRepair.cause.unmappedAccount",
  validation: "postingRepair.cause.validation",
  closed_period: "postingRepair.cause.closedPeriod",
  retry_budget_exhausted: "postingRepair.cause.retryBudgetExhausted",
  reconciliation_required: "postingRepair.cause.reconciliationRequired",
};

const GENERIC_CAUSE: MessageKey = "postingRepair.cause.other";

interface SideBase {
  side: PostingSide;
  whatKey: MessageKey;
  /** The ERP section's field label, for the RT-974 state evidence line. */
  fieldKey: MessageKey;
}

export type SideView =
  /** The field is absent (an older server): the RT-974 state-only banner, unchanged. */
  | (SideBase & { kind: "state-only" })
  /** `erpPosting` says failed but the probe found no dead-letter: changed, refresh. */
  | (SideBase & { kind: "changed" })
  | (SideBase & {
      kind: "detail";
      disclosure: Disclosure;
      causeKey: MessageKey;
      /** `{doctype} {name}` of the RT-332 document; only under `full`. */
      document: { doctype: string; name: string } | null;
      deadLetteredAt: string;
      /** The stored ERPNext message; only under `full`. Plain text. */
      reason: string | null;
      /** The repair handle; null when no repair is offered. */
      workItemRef: string | null;
      /** "Fix the mapping first, then send again." */
      mappingHint: boolean;
    });

function causeKey(category: string | null, document: unknown): MessageKey {
  if (category === RECONCILIATION_REQUIRED) {
    return document
      ? "postingRepair.cause.reconciliationRequiredWithDocument"
      : "postingRepair.cause.reconciliationRequired";
  }
  return category !== null && Object.hasOwn(CAUSE_KEYS, category)
    ? CAUSE_KEYS[category]
    : GENERIC_CAUSE;
}

/**
 * The repair is offered only when the server sent a handle under `full`, and
 * never for `reconciliation_required` (RT-332), whatever the handle says.
 */
export function repairHandleOf(
  disclosure: Disclosure,
  failure: PostingFailureDetail,
): string | null {
  if (disclosure !== "full") return null;
  if (failure.rejectionCategory === RECONCILIATION_REQUIRED) return null;
  return failure.repair?.workItemRef ?? null;
}

function detailView(
  base: SideBase,
  disclosure: Disclosure,
  failure: PostingFailureDetail,
): SideView {
  const full = disclosure === "full";
  const category = failure.rejectionCategory;
  const document = full ? failure.reconciliationDocumentRef : null;
  const workItemRef = repairHandleOf(disclosure, failure);
  return {
    ...base,
    kind: "detail",
    disclosure,
    causeKey: causeKey(category, document),
    document,
    deadLetteredAt: failure.deadLetteredAt,
    reason: full ? failure.reason : null,
    workItemRef,
    mappingHint: workItemRef !== null && MAPPING_CATEGORIES.includes(category ?? ""),
  };
}

/**
 * One view per failed posting, the sale's first. `erpPostingFailure` is
 * `required` in the generated type, but a server before RT-977 omits it, so
 * `undefined` is guarded explicitly (RT-977 §7).
 */
export function failureViews(detail: SaleDetail): SideView[] {
  const failure: PostingFailure | null | undefined = detail.erpPostingFailure;
  return SIDES.filter((side) => detail.erpPosting[side] === "failed").map((side) => {
    const base: SideBase = { side, whatKey: WHAT_KEYS[side], fieldKey: FIELD_KEYS[side] };
    if (failure === undefined) return { ...base, kind: "state-only" };
    const sideFailure = failure?.[side];
    if (!failure || !sideFailure) return { ...base, kind: "changed" };
    return detailView(base, failure.disclosure, sideFailure);
  });
}

// --- Repair outcome --------------------------------------------------------------

export type PostingRepairOutcomeKind =
  | "eligible-again"
  | "still-failing"
  | "already-posted"
  | "already-sent"
  | "not-found"
  | "key-conflict"
  | "origin-rejected"
  | "forbidden"
  | "session"
  | "rejected"
  | "rate-limited"
  | "in-progress"
  | "unconfirmed";

export interface PostingRepairOutcome {
  kind: PostingRepairOutcomeKind;
  messageKey: MessageKey;
  variant: "success" | "info" | "warning" | "danger";
  /** `resolvedDocumentRef` of an already-posted row. */
  documentRef?: string;
  requestId?: string;
  retryAfter?: number;
}

interface ErrorEnvelope {
  error?: { code?: string; request_id?: string };
}

const envelope = (error: unknown) => (error as ErrorEnvelope | undefined)?.error;

type Refusal = Pick<PostingRepairOutcome, "kind" | "messageKey" | "variant">;

const REFUSALS: Record<string, Refusal> = {
  "400": { kind: "rejected", messageKey: "postingRepair.outcome.rejected", variant: "danger" },
  "401": { kind: "session", messageKey: "postingRepair.outcome.session", variant: "danger" },
  "403": { kind: "forbidden", messageKey: "postingRepair.outcome.forbidden", variant: "danger" },
  "403:origin_rejected": {
    kind: "origin-rejected",
    messageKey: "postingRepair.outcome.originRejected",
    variant: "danger",
  },
  "404": { kind: "not-found", messageKey: "postingRepair.outcome.notFound", variant: "danger" },
  "409": {
    kind: "key-conflict",
    messageKey: "postingRepair.outcome.keyConflict",
    variant: "warning",
  },
  "425": {
    kind: "in-progress",
    messageKey: "postingRepair.outcome.unconfirmed",
    variant: "warning",
  },
};

/** Anything unlisted (a 5xx, no response) may have been applied: never "failed". */
const UNCONFIRMED: Refusal = {
  kind: "unconfirmed",
  messageKey: "postingRepair.outcome.unconfirmed",
  variant: "warning",
};

/**
 * The server's recorded outcome, keyed on `RecordedRepair.outcome` (and
 * `resolvedDocumentRef`), never on 200 vs 201: a replay returns the original
 * status (RT-977 §5).
 */
function recordedOutcome(repair: RecordedRepair): PostingRepairOutcome | null {
  switch (repair.outcome) {
    case "eligible_again":
      return {
        kind: "eligible-again",
        messageKey: "postingRepair.outcome.eligibleAgain",
        variant: "success",
      };
    case "still_failing":
      return {
        kind: "still-failing",
        messageKey: "postingRepair.outcome.stillFailing",
        variant: "warning",
      };
    case "no_op_echo":
      return repair.resolvedDocumentRef
        ? {
            kind: "already-posted",
            messageKey: "postingRepair.outcome.alreadyPosted",
            variant: "info",
            documentRef: repair.resolvedDocumentRef,
          }
        : {
            kind: "already-sent",
            messageKey: "postingRepair.outcome.alreadySent",
            variant: "info",
          };
    default:
      return null;
  }
}

/** Maps the server's answer to what the operator sees. Nothing here retries. */
export function classifyPostingRepair(result: PostingRepairResult): PostingRepairOutcome {
  if ((result.status === 200 || result.status === 201) && result.data) {
    const recorded = recordedOutcome(result.data);
    if (recorded) return recorded;
    return UNCONFIRMED;
  }
  const { code, request_id: requestId } = envelope(result.error) ?? {};
  if (result.status === 429) {
    return {
      kind: "rate-limited",
      messageKey: "postingRepair.outcome.rateLimited",
      variant: "warning",
      requestId,
      retryAfter: result.retryAfter,
    };
  }
  const refusal =
    REFUSALS[`${result.status}:${code}`] ?? REFUSALS[String(result.status)] ?? UNCONFIRMED;
  return { ...refusal, requestId, retryAfter: result.retryAfter };
}

/**
 * Whether the next send may reuse the same Idempotency-Key: only to retry the
 * same confirmation after a transport failure, a 5xx, a 429 or a 425, so a
 * replay returns the stored outcome instead of asking twice. Any answered
 * outcome ends the key; a new confirmation mints a new one (RT-977 §5).
 */
export function keepsPostingKey(outcome: PostingRepairOutcome): boolean {
  return (
    outcome.kind === "unconfirmed" ||
    outcome.kind === "rate-limited" ||
    outcome.kind === "in-progress"
  );
}

/** A v4 UUID: satisfies the Idempotency-Key format. No new dependency. */
export function newPostingKey(): string {
  return crypto.randomUUID();
}
