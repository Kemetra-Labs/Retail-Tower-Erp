/**
 * Zod schemas for `erpnext-connector/stock-import.yaml` 1.0.0-draft (RT-1286;
 * runtime RT-1288).
 *
 *   - `StockImportPullQuerySchema`: `stockImportPullRequests` query (`since`,
 *     `limit` 1..500, default 100). Scope never comes from the query (§XII).
 *   - `StockImportReportSchema`: the `stockImportReportRows` body. `.strict()`
 *     everywhere (an unknown key, a body-supplied `tenant_id`, `storeId` or
 *     warehouse is a 400). Quantities are exact-decimal strings, never floats.
 *
 * The rules that need the pulled request (`rows` ≤ its `maxRows`) live in the
 * service; the rules that need only the body (a duplicate (`ledgerEntryRef`,
 * `entryIndex`) pair, `readThrough` = the last row's position, an empty page is
 * exhausted, a refusal carries nothing) are checked here, all as 400
 * `validation_error` with nothing recorded.
 */
import { z } from "zod";

/** Rows a report may carry at most (the contract's `maxRows` ceiling). */
const STOCK_IMPORT_MAX_ROWS = 100;

/** The contract's `actualQty` pattern (exact decimal, 6 dp at most). */
const ACTUAL_QTY_PATTERN = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;
/** The contract's `postingTime` pattern (24-hour, optional fraction). */
const POSTING_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?$/;

/** The pull query is the bin-view feed's (`since`, `limit` 1..500), shape for shape. */
export {
  PullRequestsQuerySchema as StockImportPullQuerySchema,
  type PullRequestsQuery as StockImportPullQuery,
} from "../../erpnext-bin-view/dto/pull-requests-query.dto";

/** RFC 3339 date-time WITH an offset (`creation` and `readAt`). */
const DateTimeSchema = z.string().max(64).datetime({ offset: true });

const text = (max: number) => z.string().min(1).max(max);

/** `erp_stock_import_rows.entry_index` is an INTEGER: a larger index is a 400, not a 500. */
const MAX_ENTRY_INDEX = 2_147_483_647;

const ItemRefSchema = z.object({ doctype: z.literal("Item"), name: text(140) }).strict();
const BatchRefSchema = z.object({ doctype: z.literal("Batch"), name: text(140) }).strict();

const ReadThroughSchema = z
  .object({
    creation: DateTimeSchema,
    ledgerEntryRef: text(140),
    entryIndex: z.number().int().min(0).max(MAX_ENTRY_INDEX),
  })
  .strict();

const RowSchema = z
  .object({
    ledgerEntryRef: text(140),
    entryIndex: z.number().int().min(0).max(MAX_ENTRY_INDEX),
    voucherType: text(140),
    voucherNo: text(140),
    voucherDetailNo: text(140).nullable(),
    purpose: text(140).nullable(),
    isReturn: z.boolean(),
    returnAgainst: text(140).nullable(),
    postingDate: z.string().date(),
    postingTime: z.string().regex(POSTING_TIME_PATTERN),
    creation: DateTimeSchema,
    isCancelled: z.boolean(),
    actualQty: z.string().regex(ACTUAL_QTY_PATTERN),
    stockUom: text(140),
    erpnextItemRef: ItemRefSchema,
    erpnextBatchRef: BatchRefSchema.nullable(),
    hasRetailProvenance: z.boolean(),
    correctionRef: text(140).nullable(),
  })
  .strict();
export type StockImportRowInput = z.infer<typeof RowSchema>;

const RefusalSchema = z.object({ reason: z.literal("unknown_warehouse") }).strict();

export const StockImportReportSchema = z
  .object({
    rows: z.array(RowSchema).max(STOCK_IMPORT_MAX_ROWS),
    readThrough: ReadThroughSchema.nullable(),
    exhausted: z.boolean(),
    readAt: DateTimeSchema,
    refusal: RefusalSchema.nullable().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const refused = body.refusal !== undefined && body.refusal !== null;
    if (refused) {
      if (body.rows.length > 0 || body.readThrough !== null || body.exhausted) {
        issue("a refusal carries no rows, a null readThrough and exhausted false");
      }
      return;
    }
    if (body.rows.length === 0) {
      if (body.readThrough !== null) issue("readThrough must be null when rows is empty");
      if (!body.exhausted) issue("a report with no rows and no refusal must be exhausted");
      return;
    }
    const seen = new Set<string>();
    for (const row of body.rows) {
      const key = `${row.ledgerEntryRef}\u0000${row.entryIndex}`;
      if (seen.has(key)) issue("a (ledgerEntryRef, entryIndex) pair appears more than once");
      seen.add(key);
    }
    const last = body.rows[body.rows.length - 1]!;
    const rt = body.readThrough;
    if (
      rt === null ||
      rt.creation !== last.creation ||
      rt.ledgerEntryRef !== last.ledgerEntryRef ||
      rt.entryIndex !== last.entryIndex
    ) {
      issue("readThrough must be the last row's (creation, ledgerEntryRef, entryIndex)");
    }
  });
export type StockImportReport = z.infer<typeof StockImportReportSchema>;
