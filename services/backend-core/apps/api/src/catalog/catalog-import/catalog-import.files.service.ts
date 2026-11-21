/**
 * CatalogImportFilesService — RT-1537 (spec 049 S5c): the file replace and the error report of
 * `catalog/catalog-import.yaml` 1.0.7-draft.
 *
 * Replace (`consoleReplaceCatalogImportFile`), in the contract's order: the batch (404), closed (409), `expected_version`
 * (409) on a short locked read, then the parse of the new file (422: the SAME off-thread parse as the upload, never a
 * second path, `import-parse.offthread.ts`), then ONE transaction that locks the batch again (the checks repeat: it may
 * have moved during the parse), deletes the staged rows, inserts the new ones, returns the batch to `draft` at the next
 * version with the carried mapping suggested, and writes the `catalog.import.upload` audit row. The lock is never held
 * through the parse. A refused call writes nothing. A retry after success is `409 version_conflict`: that is the
 * idempotence the contract gives (by `expected_version`).
 *
 * Error report (`consoleGetCatalogImportErrorReport`): the batch must have current outcomes (the row list's rule), and is
 * read under a share lock so the report is of one version.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { PG_POOL } from "../../database";
import { toBatchBody, type CatalogImportBatchBody } from "./catalog-import.projections";
import { findPreviouslyPublished, insertRows } from "./catalog-import.repository";
import { listSuggestionProfiles } from "./catalog-import.validate-repository";
import { deleteBatchRows, listReportRows, replaceBatchFile } from "./catalog-import.files-repository";
import { inTenant, openCurrentBatch, readBatchWithOutcomes, writeBatchAudit, type ImportWriteInput } from "./catalog-import.service";
import { fileFacts } from "./import-file-facts";
import { buildErrorReportCsv, errorReportDisposition } from "./import-error-report";
import { parseImportFileOffThread } from "./import-parse.offthread";
import { carryMapping } from "./import-replace-carry";
import { suggestMapping } from "./import-synonyms";
import type { ReplaceQuery } from "./import-upload.query";
import type { ColumnMapping } from "./import-mapping";

/** The file of a replace as the intake guard read it. */
export interface ImportReplace {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly query: ReplaceQuery;
}

/** The report: its CSV text and the attachment header. */
export interface ErrorReport {
  readonly csv: string;
  readonly disposition: string;
}

@Injectable()
export class CatalogImportFilesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Replaces the file of an open batch. Throws `ImportBatchNotFoundError`, `ImportBatchRefusedError` or `ImportFileRejectedError`. */
  async replaceFile(input: ImportWriteInput, batchId: string, file: ImportReplace): Promise<CatalogImportBatchBody> {
    const expected = file.query.expected_version;
    // The cheap refusals first, on a short lock that is released before the parse.
    await inTenant(this.pool, input.tenantId, (client) => openCurrentBatch(client, input.tenantId, batchId, expected));
    const parsed = await parseImportFileOffThread(file.bytes, { sheet: file.query.sheet ?? null, delimiter: file.query.delimiter ?? null });
    return inTenant(this.pool, input.tenantId, async (client) => {
      const batch = await openCurrentBatch(client, input.tenantId, batchId, expected);
      const warning = await findPreviouslyPublished(client, input.tenantId, file.sha256);
      const carried = carryMapping(batch.mapping as ColumnMapping[] | null, batch.columns, parsed.grid.columns);
      const suggestion = suggestMapping(parsed.grid.columns, await listSuggestionProfiles(client, input.tenantId), carried);
      await deleteBatchRows(client, input.tenantId, batchId);
      await insertRows(client, input.tenantId, batchId, parsed.grid.rows);
      const row = await replaceBatchFile(client, {
        tenantId: input.tenantId,
        batchId,
        ...fileFacts(file, parsed),
        warnings: warning === null ? [] : [warning],
        suggestedMapping: suggestion.suggested,
        mappingProfileId: suggestion.profileId,
      });
      await writeBatchAudit(client, input, "catalog.import.upload", row, { replaced_file: true, carried_columns: carried.length });
      return toBatchBody(row);
    });
  }

  /** The error report of a validated or published batch. Throws `ImportBatchNotFoundError` or `ImportBatchRefusedError` (`import_batch_not_validated`). */
  async errorReport(tenantId: string, batchId: string): Promise<ErrorReport> {
    return inTenant(this.pool, tenantId, async (client) => {
      const batch = await readBatchWithOutcomes(client, tenantId, batchId, true);
      const rows = await listReportRows(client, tenantId, batchId);
      return { csv: buildErrorReportCsv(batch.columns, rows), disposition: errorReportDisposition(batchId) };
    });
  }
}
