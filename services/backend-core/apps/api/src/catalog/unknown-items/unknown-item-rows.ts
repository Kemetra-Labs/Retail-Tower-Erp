/**
 * Shared `unknown_items` row plumbing (RT-1225 / RT-148 H-2).
 *
 * One home for the raw row shape, the column list, the row -> DTO mapper and
 * the two statements that `UnknownItemsService.captureItem` and
 * `ReconciliationService.reopenUnknownItem` both issue: the pending-duplicate
 * SELECT (FR-032 / 005 FR-032) and the fresh `pending` INSERT (FR-001 /
 * 005 FR-005). Behaviour-preserving extraction: the SQL, the parameter order
 * and the RLS context the callers set are unchanged. Callers still own the
 * store GUC and the "insert produced no row" guard error.
 */
import type { PoolClient } from "pg";

import type {
  CapturedUnknownItemRow,
  UnknownItemRow,
} from "./unknown-items.service";

/** Raw snake_case unknown_items row (SELECT / FOR UPDATE / INSERT RETURNING). */
export interface UnknownItemDbRow {
  id: string;
  tenant_id: string;
  store_id: string;
  identifier_type: string;
  value: string;
  source_system: string | null;
  resolution_status: "pending" | "resolved" | "dismissed";
  resolution_action: "linked" | "created" | "dismissed" | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_product_id: string | null;
  encountered_at: Date;
  sale_context: Record<string, unknown> | null;
}

/**
 * Row shape of a statement that can only yield `pending` rows (the dedup
 * SELECT filters on it; a fresh INSERT writes it). Mirrors 003's
 * `unknown_items_resolved_fields_consistent` CHK: all `resolved_*` are NULL.
 */
export interface PendingUnknownItemDbRow extends UnknownItemDbRow {
  resolution_status: "pending";
  resolution_action: null;
  resolved_at: null;
  resolved_by: null;
  resolved_product_id: null;
}

/** Column list matching {@link UnknownItemDbRow} for SELECT / RETURNING clauses. */
export const UNKNOWN_ITEM_COLUMNS = `id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context`;

/**
 * Adapter — raw snake_case row to the camelCase DTO. A row known to be
 * `pending` maps to the narrowed {@link CapturedUnknownItemRow}.
 */
export function toUnknownItemDto(
  row: PendingUnknownItemDbRow,
): CapturedUnknownItemRow;
export function toUnknownItemDto(row: UnknownItemDbRow): UnknownItemRow;
export function toUnknownItemDto(row: UnknownItemDbRow): UnknownItemRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    identifierType: row.identifier_type,
    identifierValue: row.value,
    sourceSystem: row.source_system,
    resolutionStatus: row.resolution_status,
    resolutionAction: row.resolution_action,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedProductId: row.resolved_product_id,
    encounteredAt: row.encountered_at,
    saleContext: row.sale_context,
  };
}

/** The logical identity of an unknown item within one (tenant, store). */
export interface UnknownItemTuple {
  readonly tenantId: string;
  readonly storeId: string;
  readonly identifierType: string;
  readonly identifierValue: string;
  readonly sourceSystem: string | null;
}

/**
 * Natural-dedup SELECT (T518, FR-032): the oldest `pending` row for the same
 * `(tenant, store, identifier_type, value, source_system)` tuple, or
 * `undefined`.
 *
 * Uses the partial index `idx_unknown_items_lookup_value` (tenant_id,
 * identifier_type, value) WHERE resolution_status = 'pending'; the predicate
 * is written literally so the planner can match it. `store_id` bounds dedup
 * to the submitting store (FR-030a). `source_system IS NOT DISTINCT FROM`
 * matches both the NULL (barcode / sku / plu / supplier_code) and NOT NULL
 * (external_pos_id) branches of 003's `unknown_items_source_system_required`
 * CHK. `dismissed` / `resolved` rows are excluded by the predicate, so a
 * resubmit after dismissal still mints a fresh row (FR-005).
 *
 * The caller must already have set `app.current_store` (the `store_read` RLS
 * policy needs it to see rows).
 */
export async function findPendingDuplicate(
  client: PoolClient,
  tuple: UnknownItemTuple,
): Promise<PendingUnknownItemDbRow | undefined> {
  const result = await client.query<PendingUnknownItemDbRow>(
    `SELECT ${UNKNOWN_ITEM_COLUMNS}
       FROM unknown_items
      WHERE tenant_id       = $1
        AND store_id        = $2
        AND identifier_type = $3
        AND value           = $4
        AND source_system IS NOT DISTINCT FROM $5
        AND resolution_status = 'pending'
      ORDER BY encountered_at ASC
      LIMIT 1`,
    [
      tuple.tenantId,
      tuple.storeId,
      tuple.identifierType,
      tuple.identifierValue,
      tuple.sourceSystem,
    ],
  );
  return result.rows[0];
}

/** Inputs of {@link insertPendingUnknownItem}: the tuple plus row metadata. */
export interface PendingUnknownItemInsert extends UnknownItemTuple {
  readonly id: string;
  readonly saleContext: Record<string, unknown> | null;
  readonly correlationId: string;
}

/**
 * INSERT a fresh `pending` row and return it, or `undefined` when RLS
 * returned zero rows (the principal's tenant/store context did not satisfy
 * `unknown_items_insert`). The caller turns `undefined` into its own guard
 * error — that is a guard failure, not a domain outcome.
 */
export async function insertPendingUnknownItem(
  client: PoolClient,
  row: PendingUnknownItemInsert,
): Promise<PendingUnknownItemDbRow | undefined> {
  const result = await client.query<PendingUnknownItemDbRow>(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, sale_context,
        correlation_id)
     VALUES
       ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
     RETURNING ${UNKNOWN_ITEM_COLUMNS}`,
    [
      row.id,
      row.tenantId,
      row.storeId,
      row.identifierType,
      row.identifierValue,
      row.sourceSystem,
      row.saleContext,
      row.correlationId,
    ],
  );
  return result.rows[0];
}
