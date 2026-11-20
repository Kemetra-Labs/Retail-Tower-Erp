/**
 * RT-1507 (spec 049 sections 7.3, 8.1, 8.2): the SQL of the review decisions, the preview and the batch's cancel, on the
 * caller's client under its tenant context (FORCE RLS) with an explicit `tenant_id` predicate on every statement. Raw
 * parameterized SQL; nothing here opens a transaction. Only the import's own tables are written.
 */
import type { PoolClient } from "pg";

import { BATCH_TTL_DAYS } from "./catalog-import.limits";
import { BATCH_COLUMNS, type BatchRow } from "./catalog-import.projections";
import type { StoredRow } from "./catalog-import.validate-repository";
import type { HashableRow } from "./import-preview-hash";
import type { Decision, StoredOutcome } from "./import-resolution";
import type { RowStatus } from "./import-row-evaluate";
import type { StagedCell } from "./staged-cell";

/** The UTC ISO instant with microseconds validate stored (and the preview hash reads) for a `timestamptz` column. */
const ISO_MICROS = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoOf = (column: string): string => ISO_MICROS.replace("%s", column);

/** A row as a review decision reads it. */
export interface DecisionRow {
  readonly row_number: number;
  readonly cells: StagedCell[];
  readonly status: RowStatus;
  readonly review_reason: string | null;
  readonly outcome: StoredOutcome;
  readonly matched_text: string | null;
  readonly resolution: string | null;
  readonly resolution_product_id: string | null;
}

/** One row of the batch, or null (a number with no row is the non-disclosing 404). */
export async function loadDecisionRow(client: PoolClient, tenantId: string, batchId: string, rowNumber: number): Promise<DecisionRow | null> {
  const r = await client.query<DecisionRow>(
    `SELECT row_number, cells, status, review_reason, outcome, ${isoOf("matched_updated_at")} AS matched_text, resolution, resolution_product_id::text AS resolution_product_id
       FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2 AND row_number = $3 AND status IS NOT NULL`,
    [tenantId, batchId, rowNumber],
  );
  return r.rows[0] ?? null;
}

/** The state a decision (or a clear) gives one row. */
export interface DecisionWrite {
  readonly status: RowStatus;
  readonly outcome: StoredOutcome;
  readonly matchedUpdatedAt: string | null;
  readonly decision: Decision | null;
}

/** Writes the row's decision (null clears it) with its actor and time, and returns the stored row for the answer. */
export async function writeDecision(client: PoolClient, tenantId: string, batchId: string, rowNumber: number, write: DecisionWrite, actorUserId: string): Promise<StoredRow> {
  const decided = write.decision !== null;
  const r = await client.query<StoredRow>(
    `UPDATE catalog_import_rows
        SET status = $4, outcome = $5::jsonb, matched_updated_at = $6::timestamptz,
            resolution = $7, resolution_product_id = $8::uuid,
            resolved_by = CASE WHEN $9::boolean THEN $10::uuid END, resolved_at = CASE WHEN $9::boolean THEN now() END
      WHERE tenant_id = $1 AND batch_id = $2 AND row_number = $3
      RETURNING row_number, cells, status, outcome, issues, review_reason, resolution, resolution_product_id, resolved_at, product_id`,
    [
      tenantId,
      batchId,
      rowNumber,
      write.status,
      JSON.stringify(write.outcome),
      write.matchedUpdatedAt,
      write.decision?.action ?? null,
      write.decision?.productId ?? null,
      decided,
      actorUserId,
    ],
  );
  return r.rows[0] as StoredRow;
}

interface HashRowRecord {
  readonly row_number: number;
  readonly status: RowStatus;
  readonly review_reason: string | null;
  readonly outcome: HashableRow["outcome"];
  readonly matched_text: string | null;
  readonly resolution: string | null;
  readonly resolution_product_id: string | null;
}

/** Every row of the batch as the preview hash reads it (the outcome without its internal snapshot), in row order. */
export async function loadHashRows(client: PoolClient, tenantId: string, batchId: string): Promise<HashableRow[]> {
  const r = await client.query<HashRowRecord>(
    `SELECT row_number, status, review_reason, outcome - '_validated' AS outcome, ${isoOf("matched_updated_at")} AS matched_text, resolution, resolution_product_id::text AS resolution_product_id
       FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2 ORDER BY row_number`,
    [tenantId, batchId],
  );
  return r.rows.map((row) => ({
    rowNumber: row.row_number,
    status: row.status,
    reviewReason: row.review_reason,
    outcome: row.outcome,
    matchedUpdatedAt: row.matched_text,
    decision: row.resolution === null ? null : { action: row.resolution, productId: row.resolution_product_id },
  }));
}

/** After a review decision: the next version (the validation generation stays), the counts and the hash; the expiry moves. */
export async function markBatchReviewed(client: PoolClient, tenantId: string, batchId: string, counts: Readonly<Record<string, number>>, previewHash: string): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    `UPDATE catalog_import_batches
        SET version = version + 1, counts = $3::jsonb, preview_hash = $4, expires_at = now() + make_interval(days => $5)
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${BATCH_COLUMNS}`,
    [tenantId, batchId, JSON.stringify(counts), previewHash, BATCH_TTL_DAYS],
  );
  return r.rows[0] as BatchRow;
}

/** Cancels an open batch: closed now, no expiry, no preview hash (the counts of its last validation stay), the next version. */
export async function markBatchCancelled(client: PoolClient, tenantId: string, batchId: string): Promise<BatchRow> {
  const r = await client.query<BatchRow>(
    `UPDATE catalog_import_batches
        SET state = 'cancelled', version = version + 1, closed_at = now(), expires_at = NULL, preview_hash = NULL
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${BATCH_COLUMNS}`,
    [tenantId, batchId],
  );
  return r.rows[0] as BatchRow;
}

/** A recorded decision, with what it was recorded against (the validated candidates and error codes). */
export interface PreviousDecision {
  readonly rowNumber: number;
  readonly decision: Decision;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
  readonly reviewReason: string | null;
  readonly candidateIds: string[];
  readonly errorCodes: string[];
}

interface PreviousRecord {
  readonly row_number: number;
  readonly resolution: string;
  readonly resolution_product_id: string | null;
  readonly resolved_by: string;
  readonly resolved_text: string;
  readonly review_reason: string | null;
  readonly candidate_ids: string[];
  readonly error_codes: string[];
}

/** The decisions of the batch's rows before a new validation (spec 049 section 8.1 keeps those that still stand). */
export async function loadPreviousDecisions(client: PoolClient, tenantId: string, batchId: string): Promise<PreviousDecision[]> {
  const r = await client.query<PreviousRecord>(
    `SELECT row_number, resolution, resolution_product_id::text AS resolution_product_id, resolved_by::text AS resolved_by,
            ${isoOf("resolved_at")} AS resolved_text, review_reason,
            COALESCE(ARRAY(SELECT c->>'productId' FROM jsonb_array_elements(COALESCE(outcome->'_validated'->'candidates', outcome->'candidates', '[]'::jsonb)) c), '{}') AS candidate_ids,
            COALESCE(ARRAY(SELECT i->>'code' FROM jsonb_array_elements(issues) i WHERE i->>'severity' = 'error'), '{}') AS error_codes
       FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2 AND resolution IS NOT NULL`,
    [tenantId, batchId],
  );
  return r.rows.map((row) => ({
    rowNumber: row.row_number,
    decision: { action: row.resolution as Decision["action"], productId: row.resolution_product_id },
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_text,
    reviewReason: row.review_reason,
    candidateIds: row.candidate_ids,
    errorCodes: row.error_codes,
  }));
}
