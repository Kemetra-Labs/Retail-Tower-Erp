/**
 * RT-1505 part B / RT-1507 (spec 049 section 8.2, contract `PreviewHash`): `sha256:` and the hex SHA-256 over the
 * canonical JSON of the mode and the ordered row outcomes: status, review reason, the matched product and its
 * `updated_at`, the candidates, the field diffs, the identifier adds and not-adds, the brand to create and the review
 * decision of the row (`[action, productId]`, or `null` for none). Opaque to clients. A validate of the same file
 * against the same catalogue gives the same hash; a review decision changes it (the row's status, outcome and decision
 * slot change).
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../../common/hashing/canonical-json";
import type { RowOutcome, RowStatus } from "./import-row-evaluate";

/** What the hash reads of a row: a validated row, or a stored one (its extra outcome keys are ignored). */
export interface HashableRow {
  readonly rowNumber: number;
  readonly status: RowStatus;
  readonly reviewReason: string | null;
  readonly outcome: Pick<RowOutcome, "match" | "matchedProduct" | "candidates" | "fieldChanges" | "identifierAdds" | "identifiersNotAdded" | "brandToCreate">;
  /** The matched product's `updated_at` as a UTC ISO instant with microseconds. */
  readonly matchedUpdatedAt: string | null;
  /** The recorded review decision, if any. */
  readonly decision?: { readonly action: string; readonly productId: string | null } | null;
}

export function previewHashOf(mode: string, results: readonly HashableRow[]): string {
  const rows = results.map((r) => [
    r.rowNumber,
    r.status,
    r.reviewReason,
    r.outcome.match,
    r.outcome.matchedProduct?.productId ?? null,
    r.matchedUpdatedAt,
    r.outcome.candidates.map((c) => c.productId),
    r.outcome.fieldChanges,
    r.outcome.identifierAdds,
    r.outcome.identifiersNotAdded,
    r.outcome.brandToCreate,
    r.decision === undefined || r.decision === null ? null : [r.decision.action, r.decision.productId],
  ]);
  return `sha256:${createHash("sha256").update(canonicalJson({ mode, rows }), "utf8").digest("hex")}`;
}
