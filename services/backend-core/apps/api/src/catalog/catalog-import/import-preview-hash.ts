/**
 * RT-1505 part B (spec 049 section 8.2, contract `PreviewHash`): `sha256:` and the hex SHA-256 over the canonical JSON
 * of the mode and the ordered row outcomes: status, review reason, the matched product and its `updated_at`, the
 * candidates, the field diffs, the identifier adds, the brand to create and the review decision (a slot that is
 * always `null` until the review slice, RT-1507, fills it). Opaque to clients. A validate of the same file
 * against the same catalogue gives the same hash.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../../common/hashing/canonical-json";
import type { RowResult } from "./import-row-evaluate";

export function previewHashOf(mode: string, results: readonly RowResult[]): string {
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
    // The review decision of the row: none until RT-1507 records them (it replaces this slot with the decision).
    null,
  ]);
  return `sha256:${createHash("sha256").update(canonicalJson({ mode, rows }), "utf8").digest("hex")}`;
}
