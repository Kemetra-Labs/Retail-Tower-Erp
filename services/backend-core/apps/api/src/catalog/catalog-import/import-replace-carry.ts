/**
 * RT-1537 (spec 049 §8.1, contract `consoleReplaceCatalogImportFile`): what a re-upload carries of the previous mapping.
 *
 * Every entry of the previous mapping whose header text is unchanged is placed in the suggested mapping at the column's
 * NEW `columnNumber`. The header is the stored one (already trimmed, exact text); an empty header, or a header that
 * appears more than once in either file, is never carried (it cannot identify its column). When the batch had no
 * mapping yet, nothing is carried. The suggestion for the other columns is `suggestMapping`'s, which takes these
 * entries as already placed. Pure.
 */
import type { ColumnMapping } from "./import-mapping";

interface HeaderColumn {
  readonly columnNumber: number;
  readonly header: string;
}

function headerCounts(columns: readonly HeaderColumn[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of columns) counts.set(c.header, (counts.get(c.header) ?? 0) + 1);
  return counts;
}

/** The previous mapping's entries that survive into the new file, at the new column numbers, in column order. */
export function carryMapping(
  previous: readonly ColumnMapping[] | null,
  previousColumns: readonly HeaderColumn[],
  newColumns: readonly HeaderColumn[],
): ColumnMapping[] {
  if (previous === null) return [];
  const before = headerCounts(previousColumns);
  const after = headerCounts(newColumns);
  const targetOf = new Map(previous.map((m) => [m.columnNumber, m.target] as const));
  const newNumberOf = new Map(newColumns.map((c) => [c.header, c.columnNumber] as const));
  const carried: ColumnMapping[] = [];
  for (const column of previousColumns) {
    const target = targetOf.get(column.columnNumber);
    const columnNumber = newNumberOf.get(column.header);
    if (target === undefined || columnNumber === undefined) continue;
    if (column.header === "" || before.get(column.header) !== 1 || after.get(column.header) !== 1) continue;
    carried.push({ columnNumber, target });
  }
  return carried.sort((a, b) => a.columnNumber - b.columnNumber);
}
