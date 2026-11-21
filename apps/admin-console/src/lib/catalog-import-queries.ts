/**
 * RT-1509 (spec 049 S7) data layer: typed wrappers over the generated `apiClient` for the product
 * import contract (`catalog/catalog-import.yaml`, pinned by RT-1506). Same `{ status, data?, error? }`
 * shape as `src/lib/force-action-queries.ts`; cookie transport is on the generated client.
 *
 * The Console decides nothing here: every status, count, verdict and refusal is Backend-Core's.
 * The upload and the publish take an `Idempotency-Key`; the file goes up as raw bytes
 * (`src/lib/raw-upload.ts`).
 */
import { apiClient } from "@/generated/client";
import type { CatalogImportSchema } from "@/generated/schema";
import { RAW_UPLOAD, rawResult } from "./raw-upload";

type Schemas = CatalogImportSchema.components["schemas"];

export type CatalogImportBatch = Schemas["CatalogImportBatch"];
export type CatalogImportRow = Schemas["CatalogImportRow"];
export type CatalogImportPreview = Schemas["CatalogImportPreview"];
export type ColumnMapping = Schemas["ColumnMapping"];
export type ImportMode = Schemas["ImportMode"];
export type RowStatus = Schemas["RowStatus"];
export type StatusCounts = Schemas["StatusCounts"];
export type RowIssue = Schemas["RowIssue"];
export type RowIssueCode = Schemas["RowIssueCode"];
export type CanonicalField = Schemas["CanonicalField"];
export type MappingTarget = Schemas["MappingTarget"];
export type ProductRef = Schemas["ProductRef"];
export type ImportIdentifier = Schemas["ImportIdentifier"];
export type PublishSummary = Schemas["PublishSummary"];
export type CsvDelimiter = Schemas["CsvDelimiter"];
export type ResolveAction = Schemas["ResolveCatalogImportRowRequest"]["action"];

/** What the file field decides: sent as query values, and part of the upload's idempotency fingerprint. */
export interface UploadQuery {
  mode: ImportMode;
  fileName?: string;
  sheet?: string;
  delimiter?: CsvDelimiter;
}

function uploadQuery(q: UploadQuery) {
  return { mode: q.mode, file_name: q.fileName, sheet: q.sheet, delimiter: q.delimiter };
}

/** POST /api/v1/catalog/imports: parse the file and open a `draft` batch (201; a replay is 201 too). */
export async function consoleUploadCatalogImport(
  file: Blob,
  query: UploadQuery,
  idempotencyKey: string,
) {
  return rawResult(
    await apiClient.POST("/api/v1/catalog/imports", {
      params: { header: { "Idempotency-Key": idempotencyKey }, query: uploadQuery(query) },
      body: file,
      ...RAW_UPLOAD,
    }),
  );
}

/** GET /api/v1/catalog/imports/{batchId}: the batch in any state. */
export async function consoleGetCatalogImport(batchId: string) {
  return rawResult(
    await apiClient.GET("/api/v1/catalog/imports/{batchId}", {
      params: { path: { batchId } },
    }),
  );
}

/** PUT .../file: replace the file of an open batch (the fixed source file). */
export async function consoleReplaceCatalogImportFile(
  batchId: string,
  file: Blob,
  query: Omit<UploadQuery, "mode">,
  expectedVersion: number,
) {
  return rawResult(
    await apiClient.PUT("/api/v1/catalog/imports/{batchId}/file", {
      params: {
        path: { batchId },
        query: {
          expected_version: expectedVersion,
          file_name: query.fileName,
          sheet: query.sheet,
          delimiter: query.delimiter,
        },
      },
      body: file,
      ...RAW_UPLOAD,
    }),
  );
}

/** PUT .../mapping: confirm the mapping (every column exactly once). */
export async function consoleSetCatalogImportMapping(
  batchId: string,
  expectedVersion: number,
  columns: ColumnMapping[],
  saveProfileName?: string,
) {
  return rawResult(
    await apiClient.PUT("/api/v1/catalog/imports/{batchId}/mapping", {
      params: { path: { batchId } },
      body: { expectedVersion, columns, saveProfileName },
    }),
  );
}

/** POST .../validate: apply the mapping and rules to every row (synchronous). */
export async function consoleValidateCatalogImport(batchId: string, expectedVersion: number) {
  return rawResult(
    await apiClient.POST("/api/v1/catalog/imports/{batchId}/validate", {
      params: { path: { batchId } },
      body: { expectedVersion },
    }),
  );
}

/** GET .../rows: keyset page of rows, optionally of one status. */
export async function consoleListCatalogImportRows(
  batchId: string,
  query: { status?: RowStatus; cursor?: string; limit?: number },
) {
  return rawResult(
    await apiClient.GET("/api/v1/catalog/imports/{batchId}/rows", {
      params: { path: { batchId }, query },
    }),
  );
}

/** PUT .../rows/{rowNumber}/resolution: one review decision. */
export async function consoleResolveCatalogImportRow(
  batchId: string,
  rowNumber: number,
  body: { expectedVersion: number; action: ResolveAction; productId?: string },
) {
  return rawResult(
    await apiClient.PUT("/api/v1/catalog/imports/{batchId}/rows/{rowNumber}/resolution", {
      params: { path: { batchId, rowNumber } },
      body,
    }),
  );
}

/** GET .../preview: what publish would do, for exactly `previewHash`. */
export async function consoleGetCatalogImportPreview(batchId: string) {
  return rawResult(
    await apiClient.GET("/api/v1/catalog/imports/{batchId}/preview", {
      params: { path: { batchId } },
    }),
  );
}

/** POST .../publish: one transaction. `Idempotency-Key` is required; a resend uses the same key and body. */
export async function consolePublishCatalogImport(
  batchId: string,
  body: { expectedVersion: number; previewHash: string },
  idempotencyKey: string,
) {
  return rawResult(
    await apiClient.POST("/api/v1/catalog/imports/{batchId}/publish", {
      params: { path: { batchId }, header: { "Idempotency-Key": idempotencyKey } },
      body,
    }),
  );
}

/** POST .../cancel: close an open batch. */
export async function consoleCancelCatalogImport(batchId: string, expectedVersion: number) {
  return rawResult(
    await apiClient.POST("/api/v1/catalog/imports/{batchId}/cancel", {
      params: { path: { batchId } },
      body: { expectedVersion },
    }),
  );
}

/** GET .../error-report: the read-only CSV of error and review rows. */
export async function consoleGetCatalogImportErrorReport(batchId: string) {
  const r = await apiClient.GET("/api/v1/catalog/imports/{batchId}/error-report", {
    params: { path: { batchId } },
    parseAs: "blob",
  });
  return { ...rawResult(r), disposition: r.response.headers.get("content-disposition") };
}

/** GET /api/v1/catalog/import-template: the header line in Arabic or English. */
export async function consoleGetCatalogImportTemplate(headers: "ar" | "en") {
  const r = await apiClient.GET("/api/v1/catalog/import-template", {
    params: { query: { headers } },
    parseAs: "blob",
  });
  return { ...rawResult(r), disposition: r.response.headers.get("content-disposition") };
}
