/**
 * RT-1505 part B (contract `catalog/catalog-import.yaml` 1.0.4-draft): the refusals of the batch operations the
 * service raises and the controller maps to the contract's 409 / 422 (the file refusals of the upload are
 * `ImportFileRejectedError`).
 */

export type ImportBatchRefusalCode =
  | "version_conflict"
  | "import_batch_closed"
  | "import_batch_not_validated"
  | "mapping_invalid"
  | "mapping_required"
  | "resolution_not_allowed"
  | "preview_changed"
  | "import_not_publishable"
  | "stale_validation";

const STATUS: Readonly<Record<ImportBatchRefusalCode, number>> = {
  version_conflict: 409,
  import_batch_closed: 409,
  import_batch_not_validated: 409,
  mapping_invalid: 422,
  mapping_required: 422,
  resolution_not_allowed: 422,
  preview_changed: 409,
  import_not_publishable: 409,
  stale_validation: 409,
};

export const IMPORT_BATCH_REFUSAL_MESSAGES: Readonly<Record<ImportBatchRefusalCode, string>> = {
  version_conflict: "The batch changed since it was read. Reload it and retry.",
  import_batch_closed: "The batch is published, cancelled or expired and can no longer change.",
  import_batch_not_validated: "The batch has no current validation outcomes. Validate it first.",
  mapping_invalid: "The column mapping is not complete or not allowed. Map every column once, each field once (barcode up to five times), and name and tax_category for create and upsert.",
  mapping_required: "The batch has no confirmed column mapping. Set the mapping first.",
  resolution_not_allowed: "That decision is not offered for this row. Choose another, or clear the row's decision.",
  preview_changed: "The preview changed since it was shown. Read the preview again and confirm it.",
  import_not_publishable: "The batch cannot be published: a row still needs review or has an error, or two rows would change the same product differently.",
  stale_validation: "The catalogue changed since the batch was validated. Nothing was published. Validate the batch again and review the new preview.",
};

/** A refusal the contract defines (a 409 or a 422); nothing was written. */
export class ImportBatchRefusedError extends Error {
  readonly status: number;

  constructor(readonly code: ImportBatchRefusalCode) {
    super(code);
    this.name = "ImportBatchRefusedError";
    this.status = STATUS[code];
  }
}

/** A row-list cursor this operation did not issue for this batch, generation and status filter (a 400 `validation_error`). */
export class InvalidImportCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this query");
    this.name = "InvalidImportCursorError";
  }
}
