/**
 * RT-1507: rows per status over any rows that have one (every row has exactly one, decision 419). Shared by validate
 * (its writes), the review decision (the stored rows) and the publish.
 */
import type { RowStatus } from "./import-row-evaluate";

export function countByStatus(rows: ReadonlyArray<{ readonly status: RowStatus }>): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { ready_create: 0, ready_update: 0, unchanged: 0, needs_review: 0, error: 0, excluded: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
