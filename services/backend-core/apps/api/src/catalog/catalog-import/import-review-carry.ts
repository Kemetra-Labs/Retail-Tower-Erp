/**
 * RT-1507 (spec 049 section 8.1): what a new validation keeps of the review decisions. Validation evaluates every row
 * afresh; a decision recorded for a row stands again only while the row's candidate set and review reason are unchanged
 * (for an `error` row that was excluded: while its error codes are unchanged). Otherwise the row returns to the status
 * validation gave it. A decision that stands is applied again against the fresh outcome and the fresh catalogue facts, so
 * the decided outcome is never older than the validation. Pure.
 */
import type { PreviousDecision } from "./catalog-import.review-repository";
import type { HashableRow } from "./import-preview-hash";
import { applyDecision, decisionStillStands, type Decision, type StoredOutcome } from "./import-resolution";
import type { CatalogLookups } from "./import-lookups";
import type { ImportMode } from "./import-mapping";
import type { RowResult, RowStatus } from "./import-row-evaluate";
import type { ParsedRow } from "./import-row-parse";

/** The decision a row carries into the new validation, with who made it and when. */
interface CarriedDecision {
  readonly decision: Decision;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
}

/** One row as the new validation stores it. */
export interface RowWrite {
  readonly rowNumber: number;
  readonly status: RowStatus;
  readonly reviewReason: string | null;
  readonly outcome: StoredOutcome;
  readonly issues: RowResult["issues"];
  readonly matchedUpdatedAt: string | null;
  readonly carried: CarriedDecision | null;
}

const candidateIdsOf = (result: RowResult): string[] => result.outcome.candidates.map((c) => c.productId);
const errorCodesOf = (result: RowResult): string[] => result.issues.filter((i) => i.severity === "error").map((i) => i.code);

function plain(result: RowResult): RowWrite {
  return {
    rowNumber: result.rowNumber,
    status: result.status,
    reviewReason: result.reviewReason,
    outcome: result.outcome,
    issues: result.issues,
    matchedUpdatedAt: result.matchedUpdatedAt,
    carried: null,
  };
}

/** The row's write: its fresh result, with the earlier decision applied when it still stands. */
function writeOf(result: RowResult, parsed: ParsedRow, previous: PreviousDecision | undefined, mode: ImportMode, lookups: CatalogLookups): RowWrite {
  if (previous === undefined) return plain(result);
  const next = { status: result.status, reviewReason: result.reviewReason, candidateIds: candidateIdsOf(result), errorCodes: errorCodesOf(result) };
  if (!decisionStillStands(previous, next)) return plain(result);
  const base = { status: result.status, outcome: result.outcome, matchedUpdatedAt: result.matchedUpdatedAt };
  const applied = applyDecision({ mode, base, parsed, lookups }, previous.decision);
  if (applied === null) return plain(result);
  return {
    ...plain(result),
    status: applied.status,
    outcome: applied.outcome,
    matchedUpdatedAt: applied.matchedUpdatedAt,
    carried: { decision: previous.decision, resolvedBy: previous.resolvedBy, resolvedAt: previous.resolvedAt },
  };
}

/** Every row's write, in row order; `parsed` is parallel to `results`. */
export function carryDecisions(
  mode: ImportMode,
  results: readonly RowResult[],
  parsed: readonly ParsedRow[],
  lookups: CatalogLookups,
  previous: readonly PreviousDecision[],
): RowWrite[] {
  const byRow = new Map(previous.map((p) => [p.rowNumber, p]));
  return results.map((result, i) => writeOf(result, parsed[i] as ParsedRow, byRow.get(result.rowNumber), mode, lookups));
}

/** The writes as the preview hash reads them. */
export function hashRowsOf(writes: readonly RowWrite[]): HashableRow[] {
  return writes.map((w) => ({
    rowNumber: w.rowNumber,
    status: w.status,
    reviewReason: w.reviewReason,
    outcome: w.outcome,
    matchedUpdatedAt: w.matchedUpdatedAt,
    decision: w.carried === null ? null : w.carried.decision,
  }));
}

/** Rows per status over the writes (every row has exactly one). */
export function countWrites(writes: readonly RowWrite[]): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { ready_create: 0, ready_update: 0, unchanged: 0, needs_review: 0, error: 0, excluded: 0 };
  for (const w of writes) counts[w.status] += 1;
  return counts;
}
