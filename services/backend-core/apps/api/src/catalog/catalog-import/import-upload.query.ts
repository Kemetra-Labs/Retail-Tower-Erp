/**
 * RT-1505: the query of `consoleUploadCatalogImport` and the path of the batch
 * routes (contract `catalog/catalog-import.yaml` 1.0.2-draft). An unknown or
 * repeated key is a 400 `validation_error` (the ZodError is the global
 * filter's).
 */
import { z } from "zod";

import { charCount } from "./import-text";

/** A control character (U+0000 to U+001F, U+007F), `/` or `\`: what the contract's `file_name` pattern excludes. */
function hasControlOrSeparator(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code <= 0x1f || code === 0x7f || ch === "/" || ch === "\\") return true;
  }
  return false;
}

/** `file_name`: 1 to 255 characters, no control character, `/` or `\` (contract `FileNameQuery`, 0124 CHECK). */
const FileName = z.string().refine((s) => {
  const n = charCount(s);
  return n >= 1 && n <= 255 && !hasControlOrSeparator(s);
}, "file_name must be 1 to 255 characters with no control character, / or \\");

/** `sheet`: 1 to 31 characters (the Excel sheet-name limit, 0124 CHECK). */
const Sheet = z.string().refine((s) => {
  const n = charCount(s);
  return n >= 1 && n <= 31;
}, "sheet must be 1 to 31 characters");

export const UploadQuerySchema = z
  .object({
    mode: z.enum(["create", "update", "upsert"]),
    file_name: FileName.optional(),
    sheet: Sheet.optional(),
    delimiter: z.enum(["comma", "semicolon", "tab"]).optional(),
  })
  .strict();

export type ImportUploadQuery = z.infer<typeof UploadQuerySchema>;

/**
 * The canonical query of the upload fingerprint (spec 049 §8.4, §12.1): the
 * decoded values in the fixed order `mode`, `sheet`, `delimiter`, `file_name`,
 * `null` for an absent one, so an absent parameter can never serialise like
 * any value. No normalisation, no trimming, no case folding, no default.
 */
export function canonicalQuery(q: ImportUploadQuery): readonly [string, string | null, string | null, string | null] {
  return [q.mode, q.sheet ?? null, q.delimiter ?? null, q.file_name ?? null];
}

/** The batch id of a path: a UUID of any case (else 400 `validation_error`, before any read). */
export const BatchIdSchema = z.string().uuid();
