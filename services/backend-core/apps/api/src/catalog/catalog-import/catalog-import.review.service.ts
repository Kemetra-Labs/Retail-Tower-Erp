/**
 * CatalogImportReviewService — RT-1507 (spec 049 slice S5): the review decision of one row
 * (`consoleResolveCatalogImportRow`) and the impact preview (`consoleGetCatalogImportPreview`) of
 * `catalog/catalog-import.yaml`.
 *
 * A review decision runs under the batch row lock, in the contract's order of checks: 404 (batch, then row), closed,
 * `version_conflict`, `import_batch_not_validated`, then the decision's own rules (`422 resolution_not_allowed`;
 * `import-resolution.ts`). It changes one row, keeps the batch `validated`, bumps `version`, recomputes the counts and the
 * `previewHash` over every row, keeps the validation generation (a row-list walk in progress continues) and writes the
 * row's change and its `catalog.import.review` audit row in one transaction. Nothing is written to the catalogue.
 *
 * The preview is the same plan the publish writes from (`import-publish-plan.ts`), read from the stored rows, so its counts
 * are the published effect.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../database";
import {
  ImportBatchNotFoundError,
  inTenant,
  openCurrentBatch,
  readBatchWithOutcomes,
  writeBatchAudit,
  type ImportWriteInput,
} from "./catalog-import.service";
import { toBatchBody, type BatchRow } from "./catalog-import.projections";
import { loadDecisionRow, loadHashRows, markBatchReviewed, writeDecision, type DecisionRow, type DecisionWrite } from "./catalog-import.review-repository";
import { loadPlanRows } from "./catalog-import.publish-repository";
import { loadCatalogLookups, loadProducts, type StoredRow } from "./catalog-import.validate-repository";
import { ImportBatchRefusedError } from "./import-batch-refusal";
import { collectLookupKeys, type CatalogLookups } from "./import-lookups";
import type { ColumnMapping, ImportMode } from "./import-mapping";
import { previewHashOf } from "./import-preview-hash";
import { explicitValues } from "./import-explicit-values";
import { planPublish, previewOf } from "./import-publish-plan";
import { applyDecision, clearedState, type AppliedDecision, type Decision, type StoredRowState } from "./import-resolution";
import { toRowBody, type CatalogImportRowBody } from "./import-row-page";
import { parseRows } from "./import-row-parse";
import { countByStatus } from "./import-row-counts";
import type { ResolveBody } from "./import-resolve-body";

/** The contract's `CatalogImportRowResolved`. */
export interface RowResolvedBody {
  readonly row: CatalogImportRowBody;
  readonly version: number;
  readonly previewHash: string;
  readonly counts: ReturnType<typeof countByStatus>;
  readonly publishable: boolean;
}

/** The contract's `CatalogImportPreview`. */
export type PreviewBody = ReturnType<typeof previewOf> & {
  readonly batchId: string;
  readonly version: number;
  readonly previewHash: string;
  readonly mode: string;
  readonly publishable: boolean;
  readonly counts: BatchRow["counts"];
};

const stateOf = (row: DecisionRow): StoredRowState => ({
  status: row.status,
  reviewReason: row.review_reason,
  outcome: row.outcome,
  matchedUpdatedAt: row.matched_text,
  decision: row.resolution === null ? null : { action: row.resolution as Decision["action"], productId: row.resolution_product_id },
});

@Injectable()
export class CatalogImportReviewService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Records, changes or clears the review decision of one row. */
  async resolveRow(input: ImportWriteInput, batchId: string, rowNumber: number, body: ResolveBody): Promise<RowResolvedBody> {
    return inTenant(this.pool, input.tenantId, async (client) => {
      const batch = await openCurrentBatch(client, input.tenantId, batchId, body.expectedVersion);
      if (batch.state !== "validated") throw new ImportBatchRefusedError("import_batch_not_validated");
      const row = await loadDecisionRow(client, input.tenantId, batchId, rowNumber);
      if (row === null) throw new ImportBatchNotFoundError();
      const write = await this.decide(client, input.tenantId, batch, row, body);
      const stored = await writeDecision(client, input.tenantId, batchId, rowNumber, write, input.actorUserId);
      const updated = await this.recompute(client, input.tenantId, batch);
      await writeBatchAudit(client, input, "catalog.import.review", updated, {
        row_number: rowNumber,
        action: body.action,
        product_id: body.action === "update_product" ? body.productId : null,
        status: write.status,
      });
      return resolved(stored, updated);
    });
  }

  /** The impact of the batch's rows: what publish would do, for exactly the stored `previewHash`. */
  async preview(tenantId: string, batchId: string): Promise<PreviewBody> {
    return inTenant(this.pool, tenantId, async (client) => {
      // Share-locked: the rows below are read as of this batch row (every row writer locks the batch first).
      const batch = await readBatchWithOutcomes(client, tenantId, batchId, true);
      // The publish's own plan, with the cells of the rows that share a product read the same way, so the conflicts named here are
      // the ones the publish refuses (RT-1536).
      const rows = await loadPlanRows(client, tenantId, batchId, false);
      const plan = planPublish(rows, await explicitValues(client, tenantId, batch, rows));
      const body = toBatchBody(batch);
      return {
        batchId,
        version: batch.version,
        previewHash: batch.preview_hash as string,
        mode: batch.mode,
        publishable: body.publishable && plan.conflicts.length === 0,
        counts: batch.counts,
        ...previewOf(plan),
      };
    });
  }

  /** The state the decision gives the row, or `422 resolution_not_allowed`. */
  private async decide(client: PoolClient, tenantId: string, batch: BatchRow, row: DecisionRow, body: ResolveBody): Promise<DecisionWrite> {
    const state = stateOf(row);
    if (body.action === "clear") {
      if (state.decision === null) throw new ImportBatchRefusedError("resolution_not_allowed");
      return { ...clearedState(state), decision: null };
    }
    const decision: Decision = { action: body.action, productId: body.action === "update_product" ? body.productId : null };
    const applied = await this.applyTo(client, tenantId, batch, row, state, decision);
    if (applied === null) throw new ImportBatchRefusedError("resolution_not_allowed");
    return { ...applied, decision };
  }

  private async applyTo(client: PoolClient, tenantId: string, batch: BatchRow, row: DecisionRow, state: StoredRowState, decision: Decision): Promise<AppliedDecision | null> {
    const base = clearedState(state);
    const parsed = parseRows(batch.mapping as ColumnMapping[], [{ rowNumber: row.row_number, cells: row.cells }])[0];
    if (parsed === undefined) return null;
    const lookups = await rowLookups(client, tenantId, parsed, decision.productId);
    return applyDecision({ mode: batch.mode as ImportMode, base, parsed, lookups }, decision);
  }

  /** Counts and hash over every row after the decision; the batch's next version. */
  private async recompute(client: PoolClient, tenantId: string, batch: BatchRow): Promise<BatchRow> {
    const rows = await loadHashRows(client, tenantId, batch.id);
    return markBatchReviewed(client, tenantId, batch.id, countByStatus(rows), previewHashOf(batch.mode, rows));
  }
}

/** The catalogue facts of one row's keys, with the chosen product's facts added (it may not hold any of the row's identifiers). */
async function rowLookups(client: PoolClient, tenantId: string, parsed: ReturnType<typeof parseRows>[number], productId: string | null): Promise<CatalogLookups> {
  const lookups = await loadCatalogLookups(client, tenantId, collectLookupKeys([parsed]), false);
  if (productId === null || lookups.products.has(productId)) return lookups;
  const extra = await loadProducts(client, tenantId, [productId]);
  return { ...lookups, products: new Map([...lookups.products, ...extra]) };
}

function resolved(stored: StoredRow, batch: BatchRow): RowResolvedBody {
  const body = toBatchBody(batch);
  return {
    row: toRowBody(stored),
    version: batch.version,
    previewHash: batch.preview_hash as string,
    counts: body.counts as ReturnType<typeof countByStatus>,
    publishable: body.publishable,
  };
}
