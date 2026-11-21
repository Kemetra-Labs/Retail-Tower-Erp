import type { MessageKey } from "@/i18n";
import type { Locale } from "@/i18n";
import type {
  AnswerBlock,
  AnswerRefusalCode,
  AnswerSource,
  Citation,
  GatewayUnavailableCode,
  ManagerSalesAnswer,
  ManagerSalesExplainRequest,
  TableCell,
  TemplateId,
} from "@/lib/ai-manager-sales-queries";
import { salesSummaryRangeProblem } from "@/lib/sales-summary-queries";
import { DEFAULT_CURRENCY, isCurrencyCode } from "@/sales-by-store/storeLogic";
/**
 * RT-1541: the view model of the Manager Sales Ask/Explain panel.
 *
 * Pure functions, no React. Two rules shape everything here:
 *
 *  - NO ARITHMETIC ON FIGURES. A figure is the string or integer the server returned (a pack figure
 *    copied as the sales read gave it, RT-1526 §2.4). This module never adds, subtracts, divides,
 *    converts or rounds one; it selects and indexes them. The only calendar arithmetic is the
 *    31-day range check, shared with the reads (`salesSummaryRangeProblem`).
 *  - SCOPE FROM CONTROLS ONLY (M-2). The request's stores, dates and currency come from the
 *    panel's controls; the question text only selects a template and is never parsed here.
 *
 * Untrusted text (a store name, a label, the question) is never interpreted: `plainName` only
 * strips bidirectional control characters (X-5). Nothing here logs a question or a figure.
 */
import { validateRange } from "@/sales-daily/dailyLogic";

export { DEFAULT_CURRENCY };

// --- The template catalogue (msx-templates/1) ----------------------------------

export interface TemplateChip {
  id: TemplateId;
  labelKey: MessageKey;
  /** The by-store templates need the ranking currency (RT-1526 §7). */
  compare?: "previous_period";
}

/** T-01..T-10 and T-12; T-11 is not used. Labels come from the catalogue, never from the server. */
export const TEMPLATE_CHIPS: readonly TemplateChip[] = [
  { id: "T-01", labelKey: "aiManagerSales.chip.T01" },
  { id: "T-02", labelKey: "aiManagerSales.chip.T02" },
  { id: "T-03", labelKey: "aiManagerSales.chip.T03" },
  { id: "T-04", labelKey: "aiManagerSales.chip.T04" },
  { id: "T-05", labelKey: "aiManagerSales.chip.T05" },
  { id: "T-06", labelKey: "aiManagerSales.chip.T06", compare: "previous_period" },
  { id: "T-07", labelKey: "aiManagerSales.chip.T07", compare: "previous_period" },
  { id: "T-08", labelKey: "aiManagerSales.chip.T08" },
  { id: "T-09", labelKey: "aiManagerSales.chip.T09" },
  { id: "T-10", labelKey: "aiManagerSales.chip.T10" },
  { id: "T-12", labelKey: "aiManagerSales.chip.T12" },
];

export const QUESTION_MAX = 500;

// --- Controls and the request --------------------------------------------------

export interface StoreOption {
  id: string;
  name?: string;
  timezone?: string | null;
}

export interface AskControls {
  /** `all`: every store of the caller's scope. Otherwise the picked store ids. */
  allStores: boolean;
  pickedStoreIds: readonly string[];
  from: string;
  to: string;
  currency: string;
  locale: Locale;
}

/** What the person asked: a chip, or a question. Never both (the box only selects a template). */
export type AskChoice =
  | { kind: "template"; templateId: TemplateId }
  | { kind: "question"; question: string };

export type ControlErrors = Partial<
  Record<"from" | "to" | "currency" | "stores" | "choice", MessageKey>
>;

/** The contract's own rules, checked before anything is sent (the server checks them again). */
export function validateAsk(
  controls: AskControls,
  choice: AskChoice | null,
  available: readonly StoreOption[],
): ControlErrors {
  const errors: ControlErrors = { ...validateRange({ from: controls.from, to: controls.to }) };
  if (!isCurrencyCode(controls.currency)) errors.currency = "aiManagerSales.error.currency";
  if (!controls.allStores && controls.pickedStoreIds.length === 0) {
    errors.stores = "aiManagerSales.error.noStore";
  }
  if (controls.allStores && available.length === 0) errors.stores = "aiManagerSales.error.noStore";
  if (choice === null) errors.choice = "aiManagerSales.error.noChoice";
  if (choice?.kind === "question") {
    const length = choice.question.trim().length;
    if (length === 0) errors.choice = "aiManagerSales.error.noChoice";
    if (length > QUESTION_MAX) errors.choice = "aiManagerSales.error.questionTooLong";
  }
  return errors;
}

/**
 * The request body. Stores: a picked list is sent as is; "all" is the empty list ONLY for a
 * tenant-wide caller, and an explicit list of every accessible store for a `specific`-scope
 * caller (X-3). The tenant is never sent (it comes from the session). Currency is always sent
 * from the control; `compare` is set only by the two comparison templates.
 */
export function buildExplainRequest(
  controls: AskControls,
  choice: AskChoice,
  tenantWide: boolean,
  available: readonly StoreOption[],
): ManagerSalesExplainRequest {
  const storeIds = controls.allStores
    ? tenantWide
      ? []
      : available.map((s) => s.id)
    : [...controls.pickedStoreIds];
  const base: ManagerSalesExplainRequest = {
    storeIds,
    from: controls.from,
    to: controls.to,
    currency: controls.currency,
    locale: controls.locale,
  };
  if (choice.kind === "question") return { ...base, question: choice.question.trim() };
  const chip = TEMPLATE_CHIPS.find((c) => c.id === choice.templateId);
  return chip?.compare
    ? { ...base, templateId: choice.templateId, compare: chip.compare }
    : { ...base, templateId: choice.templateId };
}

// --- Outcomes -----------------------------------------------------------------

const REFUSAL_CODES: readonly AnswerRefusalCode[] = [
  "finance_source_absent",
  "forecast_not_supported",
  "write_action_not_supported",
  "unsupported_question",
];

export const UNAVAILABLE_CODES: readonly GatewayUnavailableCode[] = [
  "feature_disabled_system",
  "tenant_inactive",
  "not_entitled",
  "trial_expired",
  "grace_read_only",
  "feature_disabled_tenant",
  "entitlement_unavailable",
  "quota_exhausted",
  "spend_cap_reached",
  "free_credit_exhausted",
  "evidence_unavailable",
];

/** Exactly one state per request. A state carries codes and data, never server prose. */
export type ExplainOutcome =
  | { kind: "answer"; answer: ManagerSalesAnswer }
  | { kind: "refusal"; code: AnswerRefusalCode }
  | { kind: "unavailable"; code: GatewayUnavailableCode }
  /** 400: U-11 (the period, or a scope over 500 stores) or a request the server did not accept. */
  | { kind: "clarify"; reason: "range" | "scope-too-large" | "invalid"; requestId?: string }
  /** 404: non-disclosing; a role, a platform admin and a store outside scope look the same. */
  | { kind: "denied" }
  | { kind: "session" }
  | { kind: "rate-limited" }
  | { kind: "error"; requestId?: string };

interface RawResult {
  status: number;
  data?: unknown;
  error?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorOf(error: unknown): { code?: string; requestId?: string } {
  const inner = isObject(error) ? error.error : undefined;
  if (!isObject(inner)) return {};
  return {
    code: typeof inner.code === "string" ? inner.code : undefined,
    requestId: typeof inner.request_id === "string" ? inner.request_id : undefined,
  };
}

const ANSWER_ARRAYS = [
  "sources",
  "blocks",
  "citations",
  "notices",
  "declined",
  "gaps",
] as const satisfies readonly (keyof ManagerSalesAnswer)[];

function isAnswer(body: Record<string, unknown>): body is Record<string, unknown> & {
  kind: "answer";
} {
  return (
    isObject(body.scope) &&
    isObject(body.period) &&
    ANSWER_ARRAYS.every((key) => Array.isArray(body[key]))
  );
}

function outcomeOf200(body: unknown): ExplainOutcome {
  if (!isObject(body)) return { kind: "error" };
  if (body.kind === "answer" && isAnswer(body)) {
    return { kind: "answer", answer: body as unknown as ManagerSalesAnswer };
  }
  if (body.kind === "refusal" && REFUSAL_CODES.includes(body.code as AnswerRefusalCode)) {
    return { kind: "refusal", code: body.code as AnswerRefusalCode };
  }
  if (body.kind === "unavailable") {
    const code = body.code as GatewayUnavailableCode;
    if (UNAVAILABLE_CODES.includes(code)) return { kind: "unavailable", code };
  }
  // A body that is not the contract's shape is a load failure, never a crash or a guessed answer.
  return { kind: "error" };
}

function outcomeOf400(
  sent: ManagerSalesExplainRequest,
  error: { code?: string; requestId?: string },
): ExplainOutcome {
  if (error.code === "scope_too_large") {
    return { kind: "clarify", reason: "scope-too-large", requestId: error.requestId };
  }
  // A 400 carries no field detail: a range problem is told apart by the request that was sent.
  const problem = salesSummaryRangeProblem(sent);
  return { kind: "clarify", reason: problem ? "range" : "invalid", requestId: error.requestId };
}

/** Maps a response to the panel's one state. Exactly the statuses the contract documents. */
export function classifyExplain(
  result: RawResult,
  sent: ManagerSalesExplainRequest,
): ExplainOutcome {
  const error = errorOf(result.error);
  switch (result.status) {
    case 200:
      return outcomeOf200(result.data);
    case 400:
      return outcomeOf400(sent, error);
    case 401:
      return { kind: "session" };
    case 404:
      return { kind: "denied" };
    case 429:
      return { kind: "rate-limited" };
    default:
      // 403 origin_rejected, 409, 425, 5xx and anything undocumented: a retryable failure.
      return { kind: "error", requestId: error.requestId };
  }
}

// --- Answer helpers (no arithmetic) --------------------------------------------

const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/** Untrusted text shown as text: only the bidirectional control characters are removed (X-5). */
export function plainName(value: string): string {
  return value.replace(BIDI_CONTROLS, "");
}

/**
 * The earlier of the sources' own `asOf` values, shown as "as of" (two are never merged, §3.1).
 * Compares instants only; undefined when there is no source.
 */
export function earliestAsOf(sources: readonly AnswerSource[]): string | undefined {
  let best: AnswerSource | undefined;
  for (const source of sources) {
    if (!best || Date.parse(source.asOf) < Date.parse(best.asOf)) best = source;
  }
  return best?.asOf;
}

/** 1-based citation number by ref, in the server's order. */
export function citationNumbers(citations: readonly Citation[]): Map<string, number> {
  const numbers = new Map<string, number>();
  citations.forEach((c, i) => {
    if (!numbers.has(c.ref)) numbers.set(c.ref, i + 1);
  });
  return numbers;
}

/** The cell a ref names, from the answer's tables: how a statement slot finds its figure. */
export function figuresByRef(blocks: readonly AnswerBlock[]): Map<string, TableCell> {
  const figures = new Map<string, TableCell>();
  for (const block of blocks) {
    if (block.type !== "table") continue;
    for (const row of block.rows) for (const cell of row) figures.set(cell.ref, cell);
  }
  return figures;
}

const RATIO = /^-?\d+\.\d{4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CellKind = "money" | "count" | "ratio" | "date" | "text";

/** How a cell is shown. Always the value as received: formatted for locale, never recomputed. */
export function cellKind(cell: TableCell): CellKind {
  if (typeof cell.value === "number") return "count";
  if (cell.currency) return "money";
  if (RATIO.test(cell.value)) return "ratio";
  return ISO_DATE.test(cell.value) ? "date" : "text";
}

const ANSWER_NOTICE_ORDER = [
  "received_only",
  "day_in_progress",
  "day_not_begun",
  "multi_currency",
  "scope_relative_ratio",
  "parameters_from_controls_only",
] as const;

/** Notices in a fixed reading order (the server's set is unordered). */
export function orderedNotices(notices: ManagerSalesAnswer["notices"]) {
  return ANSWER_NOTICE_ORDER.filter((n) => notices.includes(n));
}

// --- Copy maps -----------------------------------------------------------------

/**
 * Column and slot message keys the server sends (`TableBlock.columns`, `StatementBlock.slots`) map
 * to catalogue copy here. The contract does not enumerate them (reported on RT-1541 for P-06 to
 * align), so a key not listed is shown as machine text, never hidden and never invented as copy.
 */
export const COLUMN_COPY: Readonly<Record<string, MessageKey>> = {
  store: "aiManagerSales.col.store",
  date: "aiManagerSales.col.date",
  received_sales: "aiManagerSales.col.receivedSales",
  count: "aiManagerSales.col.count",
  share: "aiManagerSales.col.share",
  rank: "aiManagerSales.col.rank",
  average_sale: "aiManagerSales.col.averageSale",
  best_day: "aiManagerSales.col.bestDay",
  baseline_total: "aiManagerSales.col.baselineTotal",
  delta_ratio: "aiManagerSales.col.deltaRatio",
  voids: "aiManagerSales.col.voids",
  returns: "aiManagerSales.col.returns",
  legacy_refunds: "aiManagerSales.col.legacyRefunds",
  total: "aiManagerSales.col.total",
};

export const NOTICE_COPY = {
  received_only: "aiManagerSales.notice.receivedOnly",
  day_in_progress: "aiManagerSales.notice.dayInProgress",
  day_not_begun: "aiManagerSales.notice.dayNotBegun",
  multi_currency: "aiManagerSales.notice.multiCurrency",
  scope_relative_ratio: "aiManagerSales.notice.scopeRelativeRatio",
  parameters_from_controls_only: "aiManagerSales.notice.controlsOnly",
} as const satisfies Record<ManagerSalesAnswer["notices"][number], MessageKey>;

export const REFUSAL_COPY = {
  finance_source_absent: "aiManagerSales.refusal.finance",
  forecast_not_supported: "aiManagerSales.refusal.forecast",
  write_action_not_supported: "aiManagerSales.refusal.write",
  unsupported_question: "aiManagerSales.refusal.unsupported",
} as const satisfies Record<AnswerRefusalCode, MessageKey>;

export const GAP_COPY = {
  "G-1": "aiManagerSales.gap.g1",
  "G-2": "aiManagerSales.gap.g2",
  "G-3": "aiManagerSales.gap.g3",
  "G-4": "aiManagerSales.gap.g4",
  "G-5": "aiManagerSales.gap.g5",
  "G-6": "aiManagerSales.gap.g6",
  "G-7": "aiManagerSales.gap.g7",
} as const satisfies Record<ManagerSalesAnswer["gaps"][number], MessageKey>;

export const OPERATION_COPY = {
  consoleGetSalesSummary: "aiManagerSales.source.salesSummary",
  consoleGetSalesByStore: "aiManagerSales.source.salesByStore",
} as const satisfies Record<AnswerSource["operationId"], MessageKey>;

/**
 * The copy of an `unavailable` code (U-7, U-8, U-10). D-6: a tenant never sees plan, spend or
 * credit detail, so the spend and credit codes read as the plain "not available". The owner is
 * the only role told that the opt-out or the question limit is the cause (U-8 owner rows).
 */
export type UnavailableView =
  | { tone: "info"; messageKey: MessageKey }
  | { tone: "error"; messageKey: MessageKey; retry: true };

export function unavailableView(code: GatewayUnavailableCode, role: string): UnavailableView {
  const owner = role === "owner";
  switch (code) {
    case "feature_disabled_system":
      return { tone: "info", messageKey: "aiManagerSales.unavailable.system" };
    case "feature_disabled_tenant":
      return {
        tone: "info",
        messageKey: owner
          ? "aiManagerSales.unavailable.optOutOwner"
          : "aiManagerSales.unavailable.generic",
      };
    case "quota_exhausted":
      return {
        tone: "info",
        messageKey: owner
          ? "aiManagerSales.unavailable.quotaOwner"
          : "aiManagerSales.unavailable.generic",
      };
    case "evidence_unavailable":
    case "entitlement_unavailable":
      return { tone: "error", messageKey: "aiManagerSales.error.generic", retry: true };
    default:
      return {
        tone: "info",
        messageKey: owner
          ? "aiManagerSales.unavailable.genericOwner"
          : "aiManagerSales.unavailable.generic",
      };
  }
}
