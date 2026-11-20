/**
 * RT-1505 part B (spec 049 section 5, contract `consoleSetCatalogImportMapping`): the column mapping of a batch.
 *
 * Pure: the canonical fields, the completeness rules the set-mapping call and the validate call share (defence in
 * depth: validate re-applies them to the stored mapping), the request body schema, and the profile entries a mapping
 * saves.
 */
import { z } from "zod";

import { codePointLength, isWellFormedText } from "../../common/text-validation";
import { MAX_COLUMNS } from "./catalog-import.limits";

export const CANONICAL_FIELDS = [
  "sku",
  "barcode",
  "plu",
  "name",
  "description",
  "category",
  "brand",
  "tax_category",
  "is_active",
  "price",
  "currency",
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** A canonical field, or `ignore` (the column is confirmed as not imported). */
export type MappingTarget = CanonicalField | "ignore";
export type ImportMode = "create" | "update" | "upsert";

export interface ColumnMapping {
  readonly columnNumber: number;
  readonly target: MappingTarget;
}

/** `barcode` may be mapped from up to this many columns (spec 049 section 5); every other field at most once. */
export const MAX_BARCODE_COLUMNS = 5;

const TARGET = z.enum([...CANONICAL_FIELDS, "ignore"]);

/** The largest `version` the column holds (an INTEGER): a bigger `expectedVersion` can never match. */
const VERSION_MAX = 2_147_483_647;

const ExpectedVersionSchema = z.number().int().min(1).max(VERSION_MAX);

/** `saveProfileName`: 1 to 100 characters, one of them not whitespace, no NUL (contract and the 0124 CHECK). */
const ProfileName = z
  .string()
  .refine((name) => codePointLength(name) >= 1 && codePointLength(name) <= 100, "must be 1 to 100 characters")
  .refine((name) => name.trim().length > 0 && !name.includes("\u0000"), "must have a non-whitespace character and no NUL")
  .refine(isWellFormedText, "must be well-formed text (no lone surrogate)");

export const SetMappingBodySchema = z
  .object({
    expectedVersion: ExpectedVersionSchema,
    columns: z
      .array(z.object({ columnNumber: z.number().int().min(1).max(MAX_COLUMNS), target: TARGET }).strict())
      .min(1)
      .max(MAX_COLUMNS),
    saveProfileName: ProfileName.optional(),
  })
  .strict();
export type SetMappingBody = z.infer<typeof SetMappingBodySchema>;

export const ValidateBodySchema = z.object({ expectedVersion: ExpectedVersionSchema }).strict();
export type ValidateBody = z.infer<typeof ValidateBodySchema>;

/** Why a mapping is not complete, or null: every column exactly once, a field at most once (`barcode` 5), the create fields. */
export function mappingProblem(mapping: readonly ColumnMapping[], columnCount: number, mode: ImportMode): string | null {
  if (mapping.length !== columnCount) return "every column of the batch must appear exactly once";
  const seen = new Set<number>();
  const fields = new Map<string, number>();
  for (const entry of mapping) {
    if (entry.columnNumber < 1 || entry.columnNumber > columnCount) return "a column number the batch does not have";
    if (seen.has(entry.columnNumber)) return "a column is listed twice";
    seen.add(entry.columnNumber);
    if (entry.target !== "ignore") fields.set(entry.target, (fields.get(entry.target) ?? 0) + 1);
  }
  for (const [field, n] of fields) {
    if (field === "barcode" ? n > MAX_BARCODE_COLUMNS : n > 1) return `${field} is mapped more than allowed`;
  }
  if (mode !== "update" && !(fields.has("name") && fields.has("tax_category"))) return "create and upsert need name and tax_category mapped";
  return null;
}

/**
 * The entries a saved profile keeps: the header's exact trimmed text to its target. An empty or a repeated header
 * is never saved (it cannot identify its column; a JSON object cannot hold it twice).
 */
export function profileEntries(
  columns: readonly { readonly columnNumber: number; readonly header: string }[],
  mapping: readonly ColumnMapping[],
): Record<string, MappingTarget> {
  const counts = new Map<string, number>();
  for (const column of columns) counts.set(column.header, (counts.get(column.header) ?? 0) + 1);
  const targets = new Map(mapping.map((m) => [m.columnNumber, m.target] as const));
  const entries: Record<string, MappingTarget> = Object.create(null) as Record<string, MappingTarget>;
  for (const column of columns) {
    const target = targets.get(column.columnNumber);
    if (column.header === "" || counts.get(column.header) !== 1 || target === undefined) continue;
    entries[column.header] = target;
  }
  return entries;
}
