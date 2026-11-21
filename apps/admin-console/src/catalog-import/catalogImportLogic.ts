/**
 * RT-1509 (spec 049 S7): the pure rules of the import workspace. No client, no React.
 *
 * The Console decides nothing authoritatively: the step is read from the batch the server returned,
 * every count is the server's, and a refusal is shown by its machine `error.code` (the wire message
 * is fixed English and never primary copy, UX-12.33). The one thing derived here is the list of
 * review resolutions offered for a row (G4: the contract has no `allowedActions`); the server stays
 * authoritative and a `422 resolution_not_allowed` is handled.
 */
import type { MessageKey } from "@/i18n";
import type {
  CatalogImportBatch,
  CatalogImportPreview,
  CatalogImportRow,
  ImportConflict,
  ImportMode,
  ResolveAction,
  RowIssueCode,
  RowStatus,
  StatusCounts,
} from "@/lib/catalog-import-queries";

/** Roles the API lets use the import (spec 049 §8.6). Navigation gate only; the server decides. */
const IMPORT_ROLES = ["owner", "tenant_admin"] as const;

export function canImportCatalog(role: string | null | undefined): boolean {
  return (IMPORT_ROLES as readonly string[]).includes(role ?? "");
}

// --- Steps ---------------------------------------------------------------------

export type ImportStep =
  | "upload"
  | "map"
  | "validate"
  | "review"
  | "preview"
  | "publish"
  | "result";

export const STEP_ORDER: readonly ImportStep[] = [
  "upload",
  "map",
  "validate",
  "review",
  "preview",
  "publish",
  "result",
];

/** URL segments a batch can be opened at (`publish` is the modal over `preview`, not a page). */
export type RoutedStep = Exclude<ImportStep, "upload" | "publish">;

const ROUTED: readonly RoutedStep[] = ["map", "validate", "review", "preview", "result"];

function isRoutedStep(value: string | undefined): value is RoutedStep {
  return (ROUTED as readonly string[]).includes(value ?? "");
}

/** What the server state lets the merchant open: a step the batch is not at is never shown. */
function allowedSteps(batch: CatalogImportBatch): readonly RoutedStep[] {
  switch (batch.state) {
    case "draft":
      return batch.mapping === null ? ["map"] : ["map", "validate"];
    case "validated":
      return ["map", "validate", "review", "preview"];
    case "published":
      return ["result"];
    default:
      return [];
  }
}

/** Where a batch opens when the URL names no step (or a step its state does not allow). */
function defaultStep(batch: CatalogImportBatch): RoutedStep | null {
  switch (batch.state) {
    case "draft":
      return batch.mapping === null ? "map" : "validate";
    case "validated":
      return "validate";
    case "published":
      return "result";
    default:
      return null;
  }
}

export function resolveStep(
  batch: CatalogImportBatch,
  requested: string | undefined,
): RoutedStep | null {
  const allowed = allowedSteps(batch);
  return isRoutedStep(requested) && allowed.includes(requested) ? requested : defaultStep(batch);
}

/** A batch the server closed without publishing: nothing to continue. */
export function isClosedUnpublished(batch: CatalogImportBatch): boolean {
  return batch.state === "cancelled" || batch.state === "expired";
}

/** Rows still waiting for a decision or a fixed file (counted by the server). */
export function undecidedCount(counts: StatusCounts | null | undefined): number {
  return counts ? counts.needs_review + counts.error : 0;
}

/** Validate's primary: review when any row needs a decision, else the preview. */
export function stepAfterValidate(counts: StatusCounts | null | undefined): "review" | "preview" {
  return undecidedCount(counts) > 0 ? "review" : "preview";
}

/** A batch with nothing to write: no product to create or update, no identifier or brand to add (G11). */
export function isZeroEffect(preview: CatalogImportPreview): boolean {
  return (
    preview.productsToCreate === 0 &&
    preview.productsToUpdate === 0 &&
    preview.identifiersToAdd === 0 &&
    preview.brandsToCreate.length === 0
  );
}

// --- Row statuses --------------------------------------------------------------

export const STATUS_KEYS: Record<RowStatus, MessageKey> = {
  ready_create: "catalogImport.status.ready_create",
  ready_update: "catalogImport.status.ready_update",
  unchanged: "catalogImport.status.unchanged",
  needs_review: "catalogImport.status.needs_review",
  error: "catalogImport.status.error",
  excluded: "catalogImport.status.excluded",
};

export const STATUS_ORDER: readonly RowStatus[] = [
  "ready_create",
  "ready_update",
  "unchanged",
  "needs_review",
  "error",
  "excluded",
];

/** Pill tone of a status: words carry the meaning, the tone is a second cue. */
export function statusTone(status: RowStatus): "ok" | "warn" | "danger" | "mute" {
  if (status === "error") return "danger";
  if (status === "needs_review") return "warn";
  return status === "unchanged" || status === "excluded" ? "mute" : "ok";
}

// --- Row issues and server errors ----------------------------------------------

const ISSUE_CODES: readonly RowIssueCode[] = [
  "required_field_missing",
  "value_invalid",
  "identifier_numeric_cell",
  "identifier_formula_cell",
  "identifier_non_ascii_digits",
  "identifier_invisible_char",
  "formula_without_value",
  "duplicate_in_file",
  "category_not_found",
  "product_retired",
  "already_exists",
  "not_found",
  "ambiguous",
  "no_identifier",
  "sku_mismatch",
  "store_scoped_conflict",
  "possible_duplicate",
  "gtin_check_digit",
  "tax_category_unused",
  "store_scoped_same_product",
  "deactivates_product",
  "price_not_imported",
  "whitespace_trimmed",
  "formula_cached_value",
  "brand_created",
];

/** The catalog key of a row issue; an unknown code gets the fallback line (never the wire text). */
export function issueKey(code: string): MessageKey {
  return (
    ISSUE_CODES.includes(code as RowIssueCode)
      ? `catalogImport.issue.${code}`
      : "catalogImport.issue.unknown"
  ) as MessageKey;
}

const KNOWN_ERRORS = [
  "origin_rejected",
  "validation_error",
  "file_too_large",
  "file_type_unsupported",
  "encoding_not_utf8",
  "file_unreadable",
  "xlsx_limits_exceeded",
  "sheet_not_found",
  "header_missing",
  "no_data_rows",
  "too_many_rows",
  "file_too_many_rows",
  "too_many_columns",
  "cell_too_long",
  "idempotency_key_conflict",
  "import_batch_open",
  "version_conflict",
  "import_batch_closed",
  "import_batch_not_validated",
  "preview_changed",
  "import_not_publishable",
  "stale_validation",
  "mapping_invalid",
  "mapping_required",
  "resolution_not_allowed",
  "idempotency_in_progress",
  "rate_limited",
] as const;

/** Catalog key of a refusal by machine code, or the generic line for a status no code explains. */
export function errorKey(code: string | undefined, status: number): MessageKey {
  if (code && (KNOWN_ERRORS as readonly string[]).includes(code)) {
    return `catalogImport.error.${code}` as MessageKey;
  }
  if (status === 401) return "catalogImport.error.session";
  if (status === 404) return "catalogImport.error.notAvailable";
  return status >= 500 || status === 0
    ? "catalogImport.error.generic"
    : "catalogImport.error.unknown";
}

// --- Outcomes ------------------------------------------------------------------

export type ImportOutcome<T> =
  | { kind: "ok"; data: T; replayed: boolean }
  /** The server answered and refused: nothing changed (or the code says what did). */
  | {
      kind: "refused";
      status: number;
      code: string | undefined;
      requestId: string | undefined;
      openBatchId?: string;
    }
  /** No answer, a 5xx, or a 425: the state is unknown, so a resend carries the same key and body. */
  | { kind: "unclear"; status: number; requestId: string | undefined; retryAfterSec?: number };

interface Answer<T> {
  status: number;
  data?: T;
  error?: unknown;
  retryAfter?: string | null;
  replayed?: boolean;
}

interface Envelope {
  error?: { code?: string; request_id?: string; openBatchId?: string } | string;
  retryAfterSec?: number;
}

function parseSeconds(
  value: string | null | undefined,
  body: Envelope | undefined,
): number | undefined {
  const fromHeader = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isNaN(fromHeader) && fromHeader > 0) return fromHeader;
  return typeof body?.retryAfterSec === "number" ? body.retryAfterSec : undefined;
}

/**
 * Sorts one answer. `resend`: a publish or an upload answered 429 did not say whether it ran, so it
 * is resent as it was (same key, same body); a read or an ordinary write shows the shell's 429 banner.
 */
export function classifyImport<T>(
  res: Answer<T>,
  options: { success?: readonly number[]; resend?: boolean } = {},
): ImportOutcome<T> {
  const success = options.success ?? [200, 201];
  const body = res.error as Envelope | undefined;
  const inner = typeof body?.error === "object" ? body.error : undefined;
  const requestId = inner?.request_id;
  if (success.includes(res.status) && res.data !== undefined) {
    return { kind: "ok", data: res.data, replayed: res.replayed === true };
  }
  const retryAfterSec = parseSeconds(res.retryAfter, body);
  if (res.status === 0 || res.status >= 500 || res.status === 425) {
    return { kind: "unclear", status: res.status, requestId, retryAfterSec };
  }
  if (res.status === 429 && options.resend) {
    return { kind: "unclear", status: res.status, requestId, retryAfterSec };
  }
  const code = typeof body?.error === "string" ? body.error : inner?.code;
  return { kind: "refused", status: res.status, code, requestId, openBatchId: inner?.openBatchId };
}

// --- Review: which decisions a row offers (G4) ----------------------------------

/**
 * The resolutions a row offers, from the documented rules (spec 049 §7.3, §12.3, §12.4): `error`
 * rows take `exclude` only; `create_new` is never offered in an `update` batch, nor when an
 * identifier on the row is active on another product (`match` is not `no_match`); `update_product`
 * needs candidates and is never offered in a `create` batch; `clear` shows only with a decision.
 * The server decides again: `422 resolution_not_allowed` reloads the row.
 */
export function offeredResolutions(mode: ImportMode, row: CatalogImportRow): ResolveAction[] {
  const offered: ResolveAction[] = [];
  const reviewable = row.status === "needs_review" || row.status === "error";
  const decided = row.resolution !== null;
  if (row.reviewReason !== null || row.status === "needs_review") {
    if (mode !== "update" && row.outcome.match === "no_match") offered.push("create_new");
    if (mode !== "create" && row.outcome.candidates.length > 0) offered.push("update_product");
  }
  if (reviewable || decided) offered.push("exclude");
  if (decided) offered.push("clear");
  return offered;
}

/** True when «إنشاء منتج جديد» is missing only because an identifier belongs to another product. */
export function createBlockedByIdentifier(mode: ImportMode, row: CatalogImportRow): boolean {
  return mode !== "update" && row.reviewReason !== null && row.outcome.match !== "no_match";
}

// --- RT-1536: conflicts the server names in the preview --------------------------------------------

/**
 * The conflicts the SERVER names in the preview (contract 1.0.6-draft: `conflicts[]`, the first 100,
 * with `conflictCount` for the whole), or `null` when the preview carries none. Never derived from
 * rows or counts: the Console infers no conflicts (Jira RT-1509 comment 18014). It is the one place
 * the preview's conflict fields are read, so `ConflictList` and the publish gate share it.
 */
export function previewConflicts(preview: CatalogImportPreview): readonly ImportConflict[] | null {
  return preview.conflicts && preview.conflicts.length > 0 ? preview.conflicts : null;
}

/** How many conflicts the batch has: the server's count, which can exceed the bounded list. */
export function conflictTotal(preview: CatalogImportPreview): number {
  return preview.conflictCount ?? preview.conflicts?.length ?? 0;
}

/** Publish is offered only for a preview the server calls publishable, with no named conflict. */
export function canPublish(preview: CatalogImportPreview): boolean {
  return preview.publishable && previewConflicts(preview) === null && conflictTotal(preview) === 0;
}
