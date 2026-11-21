/**
 * RT-1537 (spec 049 S5c): the CSV text of the two downloads of the import, the template and the error report. Pure.
 *
 * - A UTF-8 byte order mark first, so a spreadsheet opens the Arabic text correctly.
 * - CRLF line ends and RFC 4180 quoting (a field with a comma, a quote or a line break is quoted, quotes doubled).
 * - CSV formula injection: a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a
 *   leading `'`, so a spreadsheet never evaluates it (contract `consoleGetCatalogImportErrorReport`). The guard comes
 *   first and the quoting second, so the `'` is inside the quotes.
 */

export const CSV_BOM = "﻿";

const FORMULA_TRIGGERS: ReadonlySet<string> = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** The cell with a leading `'` when a spreadsheet would read it as a formula. */
export function guardFormula(text: string): string {
  return text.length > 0 && FORMULA_TRIGGERS.has(text.charAt(0)) ? `'${text}` : text;
}

/** One CSV field: formula-guarded, then quoted when it holds a comma, a quote or a line break. */
export function csvField(text: string): string {
  const guarded = guardFormula(text);
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** One CSV record with its CRLF. */
export function csvLine(fields: readonly string[]): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}

/**
 * An RFC 6266 attachment disposition for a fixed plain-ASCII name (the names of these downloads are built from a
 * language code and a batch id, never from merchant text): `filename` and `filename*` carry the same name.
 */
export function attachmentDisposition(asciiName: string): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(asciiName)) throw new Error("attachment name must be plain ASCII");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${asciiName}`;
}
