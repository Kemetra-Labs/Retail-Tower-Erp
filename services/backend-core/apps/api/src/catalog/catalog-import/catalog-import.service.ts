/**
 * CatalogImportService — RT-1505 (spec 049 slice S4, part A): the upload and
 * the batch read of `catalog/catalog-import.yaml` 1.0.3-draft.
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
 * Not in this slice (part B and S5): the mapping suggestion (a new batch stores
 * an empty `suggestedMapping` and no profile), validation, review, preview and
 * publish. The original bytes are never stored (OD-6 A).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { insertAuditRowInTransaction } from "../../audit";
import { PG_POOL } from "../../database";
import { toBatchBody, type CatalogImportBatchBody } from "./catalog-import.projections";
import {
  findBatch,
  findOpenBatchId,
  findPreviouslyPublished,
  insertBatch,
  insertRows,
  ONE_OPEN_BATCH_INDEX,
} from "./catalog-import.repository";
import { parseImportFile, type ParsedImportFile } from "./import-file-parser";
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
    const parsed = await parseImportFile(file.bytes, { sheet: file.query.sheet ?? null, delimiter: file.query.delimiter ?? null });
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

  private async createBatch(
    client: PoolClient,
    input: ImportWriteInput,
    file: ImportUpload,
    parsed: ParsedImportFile,
  ): Promise<CatalogImportBatchBody> {
    const warning = await findPreviouslyPublished(client, input.tenantId, file.sha256);
    const id = newId();
    const row = await insertBatch(client, {
      id,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      mode: file.query.mode,
      fileName: file.query.file_name ?? null,
      fileSize: file.bytes.length,
      fileSha256: file.sha256,
      fileKind: parsed.kind,
      sheetName: parsed.sheetName,
      csvDelimiter: parsed.csvDelimiter,
      dataRowCount: parsed.grid.rows.length,
      columns: parsed.grid.columns,
      parserVersion: parsed.parserVersion,
      warnings: warning === null ? [] : [warning],
    });
    await insertRows(client, input.tenantId, id, parsed.grid.rows);
    // Ids, codes and counts only (FR-AUDIT-3, §XIV): never a cell, a header or the file name.
    await insertAuditRowInTransaction(client, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      storeId: null,
      action: "catalog.import.upload",
      targetType: "catalog_import_batch",
      targetId: id,
      requestId: input.requestId !== null && UUID_RE.test(input.requestId) ? input.requestId : null,
      metadata: {
        batch_id: id,
        version: 1,
        mode: file.query.mode,
        file_kind: parsed.kind,
        file_sha256: file.sha256,
        data_row_count: parsed.grid.rows.length,
        column_count: parsed.grid.columns.length,
        counts: null,
      },
    });
    return toBatchBody(row);
  }
}

/** One transaction under the tenant's RLS context (never a platform-admin bypass: the session's tenant only). */
function inTenant<T>(pool: Pool, tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const context = { isPlatformAdmin: false, tenantId };
  return runWithTenantContext(pool, context, work);
}
