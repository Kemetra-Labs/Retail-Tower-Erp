/**
 * RT-1505 part B (contract `consoleListCatalogImportRows`): the row list's query, its keyset cursor and the
 * `CatalogImportRow` body.
 *
 * The cursor is opaque, unsigned (the console convention, `common/cursor/opaque-cursor`), bound to this operation, the
 * tenant, the batch, the batch's validation generation and the `status` query parameter (absent is its own value, not
 * any row's status). It carries only the last row number, so a review decision (which bumps `version`, not the
 * generation) does not end a walk, and a validate does.
 */
import { z } from "zod";

import { decodeOpaque, encodeOpaque } from "../../common/cursor/opaque-cursor";
import { InvalidImportCursorError } from "./import-batch-refusal";
import type { RowIssue } from "./import-issues";
import { trimmedCellText } from "./import-row-parse";
import type { StoredRow } from "./catalog-import.validate-repository";

export const ROW_PAGE_DEFAULT = 50;
const ROW_PAGE_MAX = 200;

const ROW_STATUSES = ["ready_create", "ready_update", "unchanged", "needs_review", "error", "excluded"] as const;

/** An opaque token of at most 512 URL-safe characters. */
const OpaqueToken = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, "cursor must be an opaque continuation token");

/** A page size as a digit string (never `z.coerce`: a repeated key is an array and must not coerce), 1 to 200. */
const PageSize = z
  .string()
  .regex(/^\d{1,3}$/, "limit must be an integer")
  .transform((digits) => Number.parseInt(digits, 10))
  .refine((n) => n >= 1 && n <= ROW_PAGE_MAX, `limit must be 1 to ${ROW_PAGE_MAX}`);

/** Every key optional and a single string: an unknown or repeated key (an array) is a 400 `validation_error`. */
export const RowsQuerySchema = z
  .object({ status: z.enum(ROW_STATUSES).optional(), cursor: OpaqueToken.optional(), limit: PageSize.optional() })
  .strict();
export type RowsQuery = z.infer<typeof RowsQuerySchema>;

/** What a cursor is bound to. */
export interface RowCursorBinding {
  readonly tenantId: string;
  readonly batchId: string;
  readonly generation: number;
  readonly status: string | null;
}

const CursorPayload = z
  .object({ o: z.literal("catalog-import-rows"), t: z.string(), b: z.string(), g: z.number().int(), s: z.string().nullable(), r: z.number().int().min(1) })
  .strict();

export function encodeRowCursor(binding: RowCursorBinding, lastRow: number): string {
  return encodeOpaque({ o: "catalog-import-rows", t: binding.tenantId, b: binding.batchId, g: binding.generation, s: binding.status, r: lastRow });
}

/** The row number a cursor continues after; a token not issued for this binding is `InvalidImportCursorError`. */
export function decodeRowCursor(raw: string, binding: RowCursorBinding): number {
  const payload = decodeOpaque(raw, CursorPayload, () => new InvalidImportCursorError());
  if (payload.t !== binding.tenantId || payload.b !== binding.batchId || payload.g !== binding.generation || payload.s !== binding.status) {
    throw new InvalidImportCursorError();
  }
  return payload.r;
}

/** The contract's `CatalogImportRow`. */
export interface CatalogImportRowBody {
  readonly rowNumber: number;
  readonly status: string;
  readonly cells: Array<string | null>;
  readonly outcome: unknown;
  readonly issues: RowIssue[];
  readonly reviewReason: string | null;
  readonly resolution: { readonly action: string; readonly productId: string | null; readonly decidedAt: string } | null;
  readonly productId: string | null;
}

/** A stored row as the contract's row: the cells are shown after the trim (OD-10), `null` for a blank one. */
export function toRowBody(row: StoredRow): CatalogImportRowBody {
  // A row of a validated batch always has a status; its absence is a defect, not a state to show.
  if (row.status === null) throw new Error(`import row ${row.row_number} has no validation outcome`);
  const resolved = row.resolution !== null && row.resolved_at !== null;
  return {
    rowNumber: row.row_number,
    status: row.status,
    cells: row.cells.map((cell) => trimmedCellText(cell)),
    outcome: row.outcome,
    issues: row.issues,
    reviewReason: row.review_reason,
    resolution: resolved ? { action: row.resolution as string, productId: row.resolution_product_id, decidedAt: (row.resolved_at as Date).toISOString() } : null,
    productId: row.product_id,
  };
}
