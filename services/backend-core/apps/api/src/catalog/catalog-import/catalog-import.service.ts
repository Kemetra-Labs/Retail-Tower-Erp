/**
 * CatalogImportService — RT-1505 (spec 049 slice S4): the upload and the batch
 * read (part A), and the mapping, validate and row list (part B) of
 * `catalog/catalog-import.yaml` 1.0.4-draft.
 *
 * Upload, in the contract's order (the guards, the key format, the query and
 * the 413 / SHA-256 / idempotent replay are the controller's chain; see
 * `import-upload-intake.guard.ts`):
 *   1. the open-batch rule: one open batch per tenant (`409 import_batch_open`,
 *      naming it);
 *   2. the parse of the file (`import-file-parser.ts`, 422 on any refusal);
 *   3. ONE transaction under the tenant's RLS context: the `draft` batch at
 *      version 1 with its columns, the staged rows, the
 *      `file_previously_published` warning (spec 049 §8.4) and the
 *      `catalog.import.upload` audit row. A refused call writes nothing and no
 *      audit row.
 *
 * The upload also stores the mapping suggestion (header synonyms and the
 * tenant's mapping profiles, `import-synonyms.ts`), so a read returns what the
 * merchant was shown.
 *
 * Map and validate (part B) lock the batch row (`FOR UPDATE`), then check in
 * the contract's order: the batch (404), closed (409), `expectedVersion`
 * (409), the operation's own rules (422); the change and its audit row are one
 * transaction. Cancel (RT-1507) is here too; the review decisions and the preview are `catalog-import.review.service.ts`, the publish `catalog-import.publish.service.ts`. The
 * original bytes are never stored (OD-6 A).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { insertAuditRowInTransaction } from "../../audit";
import { PG_POOL } from "../../database";
import { toBatchBody, type BatchRow, type CatalogImportBatchBody } from "./catalog-import.projections";
import {
  findBatch,
  findOpenBatchId,
  findPreviouslyPublished,
  insertBatch,
  insertRows,
  ONE_OPEN_BATCH_INDEX,
} from "./catalog-import.repository";
import {
  listStoredRows,
  listSuggestionProfiles,
  loadCatalogLookups,
  loadStagedRows,
  lockBatch,
  markBatchValidated,
  updateBatchMapping,
  upsertMappingProfile,
  writeRowResults,
} from "./catalog-import.validate-repository";
import { ImportBatchRefusedError } from "./import-batch-refusal";
import { fileFacts } from "./import-file-facts";
import type { ParsedImportFile } from "./import-file-parser";
import { parseImportFileOffThread } from "./import-parse.offthread";
import { collectLookupKeys } from "./import-lookups";
import { mappingProblem, profileEntries, type ColumnMapping, type ImportMode, type SetMappingBody } from "./import-mapping";
import { previewHashOf } from "./import-preview-hash";
import { carryDecisions, hashRowsOf } from "./import-review-carry";
import { countByStatus } from "./import-row-counts";
import { loadPreviousDecisions, markBatchCancelled } from "./catalog-import.review-repository";
import { evaluateRows } from "./import-row-evaluate";
import { parseRows } from "./import-row-parse";
import { decodeRowCursor, encodeRowCursor, toRowBody, ROW_PAGE_DEFAULT, type CatalogImportRowBody, type RowsQuery } from "./import-row-page";
import { suggestMapping } from "./import-synonyms";
import type { ImportUploadQuery } from "./import-upload.query";

/** The session's tenant and actor, and the request id for the audit row. */
export interface ImportWriteInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** The request id; the audit row keeps it only when it is a UUID. */
  readonly requestId: string | null;
}

/** The tenant already has an open batch (`409 import_batch_open`). */
export class ImportBatchOpenError extends Error {
  constructor(readonly openBatchId: string) {
    super("import batch open");
    this.name = "ImportBatchOpenError";
  }
}

/** The batch is absent or another tenant's: the one non-disclosing 404. */
export class ImportBatchNotFoundError extends Error {
  constructor() {
    super("import batch not found");
    this.name = "ImportBatchNotFoundError";
  }
}

/** The bytes of an upload, their SHA-256 and the validated query. */
export interface ImportUpload {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly query: ImportUploadQuery;
}

/** The batch audit actions (spec 049 section 8.7; `.expire` is the retention worker's). */
export type ImportBatchAction =
  | "catalog.import.upload"
  | "catalog.import.map"
  | "catalog.import.validate"
  | "catalog.import.review"
  | "catalog.import.publish"
  | "catalog.import.cancel";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOpenBatchViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return typeof e === "object" && e !== null && e.code === "23505" && e.constraint === ONE_OPEN_BATCH_INDEX;
}

@Injectable()
export class CatalogImportService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Uploads a file: a `draft` batch at version 1. Throws `ImportBatchOpenError` or `ImportFileRejectedError`; nothing is written then. */
  async upload(input: ImportWriteInput, file: ImportUpload): Promise<CatalogImportBatchBody> {
    const open = await inTenant(this.pool, input.tenantId, (client) => findOpenBatchId(client, input.tenantId));
    if (open !== null) throw new ImportBatchOpenError(open);
    const parsed = await parseImportFileOffThread(file.bytes, { sheet: file.query.sheet ?? null, delimiter: file.query.delimiter ?? null });
    try {
      return await inTenant(this.pool, input.tenantId, (client) => this.createBatch(client, input, file, parsed));
    } catch (err) {
      // A concurrent upload won the one-open-batch index between the check and the insert.
      if (!isOpenBatchViolation(err)) throw err;
      const winner = await inTenant(this.pool, input.tenantId, (client) => findOpenBatchId(client, input.tenantId));
      throw winner === null ? err : new ImportBatchOpenError(winner);
    }
  }

  /** One batch of the session's tenant. Throws `ImportBatchNotFoundError`. */
  async get(tenantId: string, batchId: string): Promise<CatalogImportBatchBody> {
    const row = await inTenant(this.pool, tenantId, (client) => findBatch(client, tenantId, batchId));
    if (row === null) throw new ImportBatchNotFoundError();
    return toBatchBody(row);
  }

  /** Sets the column mapping (spec 049 section 5): back to `draft` at the next version; optionally saves it as a profile. */
  async setMapping(input: ImportWriteInput, batchId: string, body: SetMappingBody): Promise<CatalogImportBatchBody> {
    return inTenant(this.pool, input.tenantId, async (client) => {
      const batch = await openCurrentBatch(client, input.tenantId, batchId, body.expectedVersion);
      const mapping: ColumnMapping[] = [...body.columns].sort((a, b) => a.columnNumber - b.columnNumber);
      if (mappingProblem(mapping, batch.column_count, batch.mode as ImportMode) !== null) throw new ImportBatchRefusedError("mapping_invalid");
      let profileId: string | null = null;
      if (body.saveProfileName !== undefined) {
        const entries = profileEntries(batch.columns, mapping);
        // A profile with no entry cannot identify any column: the request cannot be honoured (never dropped silently).
        if (Object.keys(entries).length === 0) throw new ImportBatchRefusedError("mapping_invalid");
        profileId = await upsertMappingProfile(client, {
          id: newId(),
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          name: body.saveProfileName,
          entries,
        });
      }
      const row = await updateBatchMapping(client, input.tenantId, batchId, mapping);
      const mapped = mapping.filter((m) => m.target !== "ignore").length;
      await writeBatchAudit(client, input, "catalog.import.map", row, {
        mapped_columns: mapped,
        ignored_columns: mapping.length - mapped,
        profile_saved: profileId !== null,
        profile_id: profileId,
      });
      return toBatchBody(row);
    });
  }

  /** Validates and matches every row (spec 049 sections 5 to 7): the batch becomes `validated`, version + 1, a new generation. */
  async validate(input: ImportWriteInput, batchId: string, expectedVersion: number): Promise<CatalogImportBatchBody> {
    return inTenant(this.pool, input.tenantId, async (client) => {
      const batch = await openCurrentBatch(client, input.tenantId, batchId, expectedVersion);
      if (batch.mapping === null) throw new ImportBatchRefusedError("mapping_required");
      const mapping = batch.mapping as ColumnMapping[];
      // Defence in depth: the stored mapping is checked again against the batch's current columns.
      if (mappingProblem(mapping, batch.column_count, batch.mode as ImportMode) !== null) throw new ImportBatchRefusedError("mapping_invalid");
      const parsed = parseRows(mapping, await loadStagedRows(client, input.tenantId, batchId));
      const lookups = await loadCatalogLookups(client, input.tenantId, collectLookupKeys(parsed), batch.mode !== "update");
      const results = evaluateRows(batch.mode as ImportMode, mapping, parsed, lookups);
      // Spec 049 section 8.1: a review decision stands again while its row's candidate set and reason are unchanged.
      const previous = await loadPreviousDecisions(client, input.tenantId, batchId);
      const writes = carryDecisions(batch.mode as ImportMode, results, parsed, lookups, previous);
      await writeRowResults(client, input.tenantId, batchId, writes);
      const row = await markBatchValidated(client, input.tenantId, batchId, countByStatus(writes), previewHashOf(batch.mode, hashRowsOf(writes)));
      await writeBatchAudit(client, input, "catalog.import.validate", row, issueCounts(results));
      return toBatchBody(row);
    });
  }

  /** Cancels an open batch (spec 049 section 8.1): closed, no expiry, no preview hash; nothing is written to the catalogue. */
  async cancel(input: ImportWriteInput, batchId: string, expectedVersion: number): Promise<CatalogImportBatchBody> {
    return inTenant(this.pool, input.tenantId, async (client) => {
      await openCurrentBatch(client, input.tenantId, batchId, expectedVersion, true);
      const row = await markBatchCancelled(client, input.tenantId, batchId);
      await writeBatchAudit(client, input, "catalog.import.cancel", row, {});
      return toBatchBody(row);
    });
  }

  /** One page of the rows of a validated or published batch (keyset by row number). */
  async listRows(tenantId: string, batchId: string, query: RowsQuery): Promise<{ batchId: string; version: number; items: CatalogImportRowBody[]; nextCursor: string | null }> {
    return inTenant(this.pool, tenantId, async (client) => {
      const batch = await readBatchWithOutcomes(client, tenantId, batchId);
      const binding = { tenantId, batchId, generation: batch.validation_generation, status: query.status ?? null };
      const after = query.cursor === undefined ? 0 : decodeRowCursor(query.cursor, binding);
      const limit = query.limit ?? ROW_PAGE_DEFAULT;
      const stored = await listStoredRows(client, tenantId, batchId, binding.status, after, limit);
      const page = stored.slice(0, limit);
      const last = page[page.length - 1];
      return {
        batchId,
        version: batch.version,
        items: page.map(toRowBody),
        nextCursor: stored.length > limit && last !== undefined ? encodeRowCursor(binding, last.row_number) : null,
      };
    });
  }

  private async createBatch(
    client: PoolClient,
    input: ImportWriteInput,
    file: ImportUpload,
    parsed: ParsedImportFile,
  ): Promise<CatalogImportBatchBody> {
    const warning = await findPreviouslyPublished(client, input.tenantId, file.sha256);
    const suggestion = suggestMapping(parsed.grid.columns, await listSuggestionProfiles(client, input.tenantId));
    const id = newId();
    const row = await insertBatch(client, {
      id,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      mode: file.query.mode,
      ...fileFacts(file, parsed),
      warnings: warning === null ? [] : [warning],
      suggestedMapping: suggestion.suggested,
      mappingProfileId: suggestion.profileId,
    });
    await insertRows(client, input.tenantId, id, parsed.grid.rows);
    await writeBatchAudit(client, input, "catalog.import.upload", row, {});
    return toBatchBody(row);
  }
}

/**
 * The batch when it has current outcomes to show (`validated` or `published`, rows not purged): 404 when absent, `409
 * import_batch_not_validated` otherwise (a reader never gets an empty page for a batch without outcomes).
 */
export async function readBatchWithOutcomes(client: PoolClient, tenantId: string, batchId: string, forShare = false): Promise<BatchRow> {
  const batch = await findBatch(client, tenantId, batchId, forShare);
  if (batch === null) throw new ImportBatchNotFoundError();
  if ((batch.state !== "validated" && batch.state !== "published") || batch.rows_purged_at !== null) {
    throw new ImportBatchRefusedError("import_batch_not_validated");
  }
  return batch;
}

/**
 * The batch, locked, when it is open and at `expectedVersion`: 404 when absent (or another tenant's), `import_batch_closed`
 * when it is not `draft` or `validated`, or is past its expiry (the expiry job has not closed it yet: a change must not
 * move a lapsed batch's expiry forward, spec 049 section 8.1), `version_conflict` when the version moved. The contract's
 * order of checks. `allowLapsed`: a cancel may close a lapsed batch the expiry job has not reached yet (it frees the tenant's
 * one open batch).
 */
export async function openCurrentBatch(client: PoolClient, tenantId: string, batchId: string, expectedVersion: number, allowLapsed = false): Promise<BatchRow> {
  const batch = await lockBatch(client, tenantId, batchId);
  if (batch === null) throw new ImportBatchNotFoundError();
  if ((batch.state !== "draft" && batch.state !== "validated") || (batch.past_expiry && !allowLapsed)) throw new ImportBatchRefusedError("import_batch_closed");
  if (batch.version !== expectedVersion) throw new ImportBatchRefusedError("version_conflict");
  return batch;
}

/** The count of each issue code of a validation, for the audit row (counts only, never a value). */
function issueCounts(results: ReturnType<typeof evaluateRows>): Record<string, unknown> {
  const issues: Record<string, number> = {};
  for (const r of results) for (const i of r.issues) issues[i.code] = (issues[i.code] ?? 0) + 1;
  return { issue_counts: issues };
}

/**
 * One batch audit row in the caller's transaction: ids, codes and counts only (FR-AUDIT-3, section XIV), never a cell, a
 * header, a profile name or the file name. `row` is the batch after the change (its version and counts).
 */
export async function writeBatchAudit(
  client: PoolClient,
  input: ImportWriteInput,
  action: ImportBatchAction,
  row: BatchRow,
  extra: Record<string, unknown>,
): Promise<void> {
  await insertAuditRowInTransaction(client, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    storeId: null,
    action,
    targetType: "catalog_import_batch",
    targetId: row.id,
    requestId: input.requestId !== null && UUID_RE.test(input.requestId) ? input.requestId : null,
    metadata: {
      batch_id: row.id,
      version: row.version,
      mode: row.mode,
      file_kind: row.file_kind,
      file_sha256: row.file_sha256,
      data_row_count: row.data_row_count,
      column_count: row.column_count,
      counts: row.counts,
      ...extra,
    },
  });
}

/** One transaction under the tenant's RLS context (never a platform-admin bypass: the session's tenant only). */
export function inTenant<T>(pool: Pool, tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const context = { isPlatformAdmin: false, tenantId };
  return runWithTenantContext(pool, context, work);
}
