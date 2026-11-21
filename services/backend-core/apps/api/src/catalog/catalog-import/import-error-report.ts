/**
 * RT-1537 (spec 049 S5c, contract `consoleGetCatalogImportErrorReport`): the error report of a validated batch, a CSV
 * with a BOM and one line per `error` or `needs_review` row in `rowNumber` order: `row_number`, `status`, `issues`, then
 * the row's cells under the file's own headers (the cells as the row list shows them: after the trim, empty for a blank
 * one). Pure; the CSV rules (BOM, CRLF, quoting, the formula guard) are `import-csv.ts`.
 *
 * The `issues` cell lists every issue of the row as `code: message` (`code [field]: message` when the issue names a
 * field), separated by ` | `. The messages never repeat a cell value (`import-issues.ts`).
 */
import type { ImportColumnBody } from "./catalog-import.projections";
import { attachmentDisposition, CSV_BOM, csvLine } from "./import-csv";
import type { RowIssue } from "./import-issues";
import { trimmedCellText } from "./import-row-parse";
import type { StagedCell } from "./staged-cell";

/** The stored facts of one row of the report. */
export interface ReportRow {
  readonly rowNumber: number;
  readonly status: string;
  readonly issues: readonly RowIssue[];
  readonly cells: readonly StagedCell[];
}

/** The issues of a row as one cell of the report. */
export function formatIssues(issues: readonly RowIssue[]): string {
  return issues.map((i) => `${i.code}${i.field === null ? "" : ` [${i.field}]`}: ${i.message}`).join(" | ");
}

/** The report: a BOM, the header line (the fixed columns, then the file's headers), then one line per row. */
export function buildErrorReportCsv(columns: readonly ImportColumnBody[], rows: readonly ReportRow[]): string {
  const parts: string[] = [CSV_BOM, csvLine(["row_number", "status", "issues", ...columns.map((c) => c.header)])];
  for (const row of rows) {
    const cells = columns.map((_c, i) => trimmedCellText(row.cells[i] ?? null) ?? "");
    parts.push(csvLine([String(row.rowNumber), row.status, formatIssues(row.issues), ...cells]));
  }
  return parts.join("");
}

/** The attachment header of the report of one batch (the name holds the batch id, never merchant text). */
export function errorReportDisposition(batchId: string): string {
  return attachmentDisposition(`import-errors-${batchId.toLowerCase()}.csv`);
}
