import type { catalogImport as ar } from "../ar/catalogImport";
import type { MessagesOf } from "../types";

/** English copy of the product import workspace (RT-1509). Mirrors the Arabic keys; Arabic is authoritative. */
export const catalogImport: MessagesOf<typeof ar> = {
  // --- Entry and page ----------------------------------------------------------
  "catalogImport.nav.link": "Import products",
  "catalogImport.title": "Import products",
  "catalogImport.crumb": "Catalog › Import products",
  "catalogImport.cancel.action": "Cancel import",
  "catalogImport.cancel.actionRestart": "Cancel this import and start a new one",
  "catalogImport.back": "Back to upload",
  "catalogImport.loading": "Loading the import…",
  "catalogImport.reload": "Reload",
  "catalogImport.loadFailed.title": "Could not load the import",
  "catalogImport.loadFailed.body": "Nothing changed.",
  "catalogImport.closed.title": "This import is closed",
  "catalogImport.closed.body": "It was published, cancelled or expired. Start a new one.",

  // --- Stepper -----------------------------------------------------------------
  "catalogImport.stepper.label": "Import steps",
  "catalogImport.stepper.announce": "Step {n} of 7: {name}",
  "catalogImport.step.upload": "Upload",
  "catalogImport.step.map": "Map columns",
  "catalogImport.step.validate": "Validate",
  "catalogImport.step.review": "Review",
  "catalogImport.step.preview": "Preview",
  "catalogImport.step.publish": "Publish",
  "catalogImport.step.result": "Result",
  "catalogImport.stepFact.done": "Done",
  "catalogImport.stepFact.current": "Current step",
  "catalogImport.stepFact.notStarted": "Not started",
  "catalogImport.stepFact.notStartedM": "Not started",
  "catalogImport.stepFact.needsValidation": "Validate again",
  "catalogImport.stepFact.rows": "Rows: {count}",
  "catalogImport.stepFact.columns": "Columns: {count}",
  "catalogImport.stepFact.undecided": "Rows without a decision: {count}",

  // --- Step 1: Upload ------------------------------------------------------------
  "catalogImport.upload.intro":
    "Upload a CSV or XLSX to add or update products in one batch. The catalog does not change until you confirm publishing.",
  "catalogImport.upload.mode.legend": "Import mode",
  "catalogImport.upload.mode.required": "(required)",
  "catalogImport.upload.mode.upsert": "Create and update",
  "catalogImport.upload.mode.upsertHint": "Creates what is missing and updates what exists.",
  "catalogImport.upload.mode.create": "Create only",
  "catalogImport.upload.mode.createHint":
    "Creates new products. A row matching an existing product is an error.",
  "catalogImport.upload.mode.update": "Update only",
  "catalogImport.upload.mode.updateHint":
    "Updates existing products. A row matching no product is an error.",
  "catalogImport.upload.file.legend": "File",
  "catalogImport.upload.file.choose": "Choose a file",
  "catalogImport.upload.file.chooseAnother": "Choose another file",
  "catalogImport.upload.file.none": "No file chosen",
  "catalogImport.upload.file.size": "{size} KB",
  "catalogImport.upload.file.requirements":
    "CSV (UTF-8) or XLSX · up to 5 MB · up to 5,000 rows and 50 columns · first sheet only.",
  "catalogImport.upload.template.link": "Download the template",
  "catalogImport.upload.template.ar": "Arabic headers",
  "catalogImport.upload.template.en": "English headers",
  "catalogImport.upload.template.failed": "Could not download the template. Try again.",
  "catalogImport.upload.advanced": "Advanced options",
  "catalogImport.upload.sheet.label": "Sheet name (optional)",
  "catalogImport.upload.sheet.placeholder": "First sheet",
  "catalogImport.upload.sheet.hint":
    "Leave empty to read the first sheet. The name must match the file exactly.",
  "catalogImport.upload.delimiter.label": "Delimiter (CSV only)",
  "catalogImport.upload.delimiter.auto": "Auto-detect",
  "catalogImport.upload.delimiter.comma": "Comma",
  "catalogImport.upload.delimiter.semicolon": "Semicolon",
  "catalogImport.upload.delimiter.tab": "Tab",
  "catalogImport.upload.delimiter.xlsxHint": "Not available for XLSX files.",
  "catalogImport.upload.submit": "Upload file",
  "catalogImport.upload.submitting": "Uploading…",
  "catalogImport.upload.blocked.both": "Choose an import mode and a file first.",
  "catalogImport.upload.blocked.mode": "Choose an import mode.",
  "catalogImport.upload.blocked.file": "Choose a file.",
  "catalogImport.upload.busy.title": "Uploading and reading the file…",
  "catalogImport.upload.busy.body": "This can take a few seconds. Do not close the page.",
  "catalogImport.upload.unclear.title": "No answer from the server",
  "catalogImport.upload.unclear.body":
    "We do not know whether the file arrived. Resend the same file; no duplicate batch will be created.",
  "catalogImport.upload.unclear.resend": "Resend",
  "catalogImport.upload.unchanged": "No import was created.",

  // --- Open batch (409 import_batch_open) ------------------------------------------
  "catalogImport.open.title": "You have an open import",
  "catalogImport.open.body":
    "You cannot upload a new file until the open import is finished or cancelled.",
  "catalogImport.open.file": "File",
  "catalogImport.open.state": "Status",
  "catalogImport.open.updated": "Last changed",
  "catalogImport.open.expires": "Expires",
  "catalogImport.open.resume": "Resume import",
  "catalogImport.open.loadFailed": "Could not load the open import's details.",
  "catalogImport.state.draft": "Draft",
  "catalogImport.state.validated": "Validated",
  "catalogImport.state.published": "Published",
  "catalogImport.state.cancelled": "Cancelled",
  "catalogImport.state.expired": "Expired",

  // --- Cancel dialog --------------------------------------------------------------
  "catalogImport.cancelDialog.title": "Cancel the open import?",
  "catalogImport.cancelDialog.body":
    "The mapping and recorded decisions are discarded; the catalog does not change.",
  "catalogImport.cancelDialog.keep": "Keep import",
  "catalogImport.cancelDialog.confirm": "Cancel import",
  "catalogImport.cancelDialog.busy": "Cancelling…",

  // --- Step 2: Map -------------------------------------------------------------------
  "catalogImport.map.intro":
    "The suggestion comes from the headers and the saved profile. Review it, then confirm.",
  "catalogImport.map.sheetRead": "Sheet read (XLSX): {sheet}",
  "catalogImport.map.delimiterRead": "Detected delimiter (CSV): {delimiter}",
  "catalogImport.map.caption": "Columns ({count})",
  "catalogImport.map.col.file": "File column",
  "catalogImport.map.col.samples": "Examples from the first rows",
  "catalogImport.map.col.target": "Maps to",
  "catalogImport.map.col.note": "Note",
  "catalogImport.map.header.empty": "(no header)",
  "catalogImport.map.select": "Map column {header}",
  "catalogImport.map.note.suggested": "Suggested",
  "catalogImport.map.note.ignored": "Will be ignored",
  "catalogImport.map.note.notImported": "Not imported",
  "catalogImport.map.note.confirmed": "Confirmed",
  "catalogImport.map.previouslyPublished.title": "A matching file was published before",
  "catalogImport.map.previouslyPublished.body":
    "A file with identical content was published on {date}. You can continue.",
  "catalogImport.map.ignored.title": "Columns that will be ignored: {count}",
  "catalogImport.map.ignored.body":
    "{names}. Review them first; nothing will be imported from them.",
  "catalogImport.map.priceNotice":
    "The price is not written. New products are created without a price and do not appear on any till until priced.",
  "catalogImport.map.save.label": "Save this mapping for next time",
  "catalogImport.map.save.name": "Profile name",
  "catalogImport.map.submit": "Validate",
  "catalogImport.map.submitting": "Saving the mapping…",
  "catalogImport.map.duplicate":
    "The field “{field}” is mapped to more than one column. Choose one (only Barcode accepts up to 5).",
  "catalogImport.map.requiredMissing":
    "“Name” and “Tax category” must be mapped in Create-only and Create-and-update.",
  "catalogImport.map.blocked": "Review the marked columns before validating.",
  "catalogImport.map.refused.title": "The mapping is incomplete or conflicting",
  "catalogImport.map.replace.title": "Replace the file",
  "catalogImport.map.replace.action": "Replace file",
  "catalogImport.map.replace.busy": "Replacing the file…",
  "catalogImport.map.replace.hint":
    "Upload your fixed file, not the error report. The mapping and review decisions are cleared.",
  "catalogImport.map.replaced.title": "File replaced, mapping reset",
  "catalogImport.map.replaced.body":
    "Columns that kept their headers are suggested. Confirm the mapping again before validating. Earlier review decisions were removed.",

  // --- Field labels (mapping targets and issues) --------------------------------
  "catalogImport.field.sku": "SKU",
  "catalogImport.field.barcode": "Barcode",
  "catalogImport.field.plu": "PLU",
  "catalogImport.field.name": "Name",
  "catalogImport.field.description": "Description",
  "catalogImport.field.category": "Category",
  "catalogImport.field.brand": "Brand",
  "catalogImport.field.tax_category": "Tax category",
  "catalogImport.field.is_active": "Active",
  "catalogImport.field.price": "Price",
  "catalogImport.field.currency": "Currency",
  "catalogImport.target.barcode": "Barcode (up to 5 columns)",
  "catalogImport.target.name": "Name (required)",
  "catalogImport.target.tax_category": "Tax category (required)",
  "catalogImport.target.price": "Price — not imported yet",
  "catalogImport.target.currency": "Currency — not imported yet",
  "catalogImport.target.ignore": "Will be ignored",

  // --- Step 3: Validate -------------------------------------------------------------
  "catalogImport.validate.rows": "Rows: {count}",
  "catalogImport.validate.band": "Filter rows by status",
  "catalogImport.validate.all": "All rows",
  "catalogImport.validate.filterActive": "Filter active: {status}",
  "catalogImport.validate.showAll": "Show all rows",
  "catalogImport.validate.caption": "Rows with status “{status}” ({count})",
  "catalogImport.validate.captionAll": "All rows ({count})",
  "catalogImport.validate.col.row": "Row",
  "catalogImport.validate.col.status": "Status",
  "catalogImport.validate.col.product": "Product in file",
  "catalogImport.validate.col.issues": "Issues",
  "catalogImport.validate.noIssues": "No issues.",
  "catalogImport.validate.errorReport": "Error report (CSV)",
  "catalogImport.validate.errorReportHint":
    "Read-only: fix your source file and upload that; do not upload the report.",
  "catalogImport.validate.errorReportFailed": "Could not download the error report. Try again.",
  "catalogImport.validate.loadMore": "Load more",
  "catalogImport.validate.loadMoreFailed.title": "Could not load more rows",
  "catalogImport.validate.loadMoreFailed.body": "The rows shown above stay as they are.",
  "catalogImport.validate.loading": "Loading rows…",
  "catalogImport.validate.busy.title": "Validating {count} rows…",
  "catalogImport.validate.busy.body":
    "This can take up to ten seconds. The catalog will not change.",
  "catalogImport.validate.busy.button": "Validating…",
  "catalogImport.validate.empty": "No rows with this status.",
  "catalogImport.validate.rowsFailed.title": "Could not load the validation result",
  "catalogImport.validate.rowsFailed.body": "The import did not change.",
  "catalogImport.validate.needed.title": "Validation needed",
  "catalogImport.validate.needed.body":
    "The mapping is saved. Validate the rows before continuing.",
  "catalogImport.validate.again": "Validate again",
  "catalogImport.validate.stale.title": "The catalog changed since the last check",
  "catalogImport.validate.stale.body":
    "Nothing was published. The import is back at Validate, mapping kept. Validate again and review the preview. Your decisions are kept while their rows are unchanged.",
  "catalogImport.validate.toReview": "Continue to review",
  "catalogImport.validate.toPreview": "Continue to preview",
  "catalogImport.validate.nextReason":
    "{errors} rows have errors and {review} need a decision. Errors are fixed in the file or excluded in review.",
  "catalogImport.status.ready_create": "Ready to create",
  "catalogImport.status.ready_update": "Ready to update",
  "catalogImport.status.unchanged": "Unchanged",
  "catalogImport.status.needs_review": "Needs review",
  "catalogImport.status.error": "Error",
  "catalogImport.status.excluded": "Excluded",
  "catalogImport.severity.error": "Error",
  "catalogImport.severity.review": "Needs a decision",
  "catalogImport.severity.warning": "Warning",
  "catalogImport.severity.notice": "Notice",

  // --- Step 4: Review ----------------------------------------------------------------
  "catalogImport.review.title": "Review rows · {count} rows without a decision",
  "catalogImport.review.breakdown": "Need review: {review} · With errors: {errors}",
  "catalogImport.review.caption": "Rows that need a decision",
  "catalogImport.review.col.row": "Row",
  "catalogImport.review.col.reason": "Reason",
  "catalogImport.review.col.decision": "Decision",
  "catalogImport.review.col.action": "Action",
  "catalogImport.review.open": "Open details",
  "catalogImport.review.openRow": "Open details of row {row}",
  "catalogImport.review.apply": "Apply decision",
  "catalogImport.review.applying": "Recording the decision…",
  "catalogImport.review.remove": "Remove the decision",
  "catalogImport.review.removing": "Removing the decision…",
  "catalogImport.review.empty": "No rows need a decision.",
  "catalogImport.review.emptyHint": "You can continue to the preview.",
  "catalogImport.review.loading": "Loading rows…",
  "catalogImport.review.drawerTitle": "Row {row} · {reason}",
  "catalogImport.review.inFile": "In the file: {name}",
  "catalogImport.review.decisions": "Decision",
  "catalogImport.review.createNew": "Create a new product",
  "catalogImport.review.updateProduct": "Update this product",
  "catalogImport.review.exclude": "Exclude this row",
  "catalogImport.review.excludeHint": "This row is not imported.",
  "catalogImport.review.createNotOffered":
    "“Create a new product” is not offered: one of the row's identifiers belongs to another product and is never moved.",
  "catalogImport.review.errorHint": "Errors are fixed in the source file, or the row is excluded.",
  "catalogImport.review.pickOne": "Choose a decision.",
  "catalogImport.review.reason.ambiguous": "Ambiguous match",
  "catalogImport.review.reason.no_identifier": "No identifier",
  "catalogImport.review.reason.sku_mismatch": "SKU mismatch",
  "catalogImport.review.reason.store_scoped_conflict": "Store-identifier conflict",
  "catalogImport.review.reason.possible_duplicate": "Possible duplicate",
  "catalogImport.review.reason.error": "Error",
  "catalogImport.review.decided.none": "No decision",
  "catalogImport.review.decided.create": "Will be created",
  "catalogImport.review.decided.update": "“{name}” will be updated",
  "catalogImport.review.decided.exclude": "Excluded",
  "catalogImport.review.recorded": "Decision recorded for row {row}: {outcome}",
  "catalogImport.review.cleared": "Decision removed for row {row}.",
  "catalogImport.review.notAdded": "This identifier will not be added: {ids} ({reason}).",
  "catalogImport.review.notAdded.sku": "the product has another SKU and a second is not added",
  "catalogImport.review.notAdded.store": "used by another product at a store",
  "catalogImport.review.notAdded.other": "not added",
  "catalogImport.review.undecided": "Rows without a decision: {count}",
  "catalogImport.review.toPreview": "Continue to preview",
  "catalogImport.review.loadMore": "Load more",
  "catalogImport.review.loadMoreFailed":
    "Could not load more rows. The rows shown above stay as they are.",
  "catalogImport.review.rowsFailed": "Could not load the rows. The import did not change.",
  "catalogImport.review.versionConflict.title": "This import changed since you opened it",
  "catalogImport.review.versionConflict.body":
    "Maybe in another tab. It was reloaded; review it and try again.",
  "catalogImport.review.notAllowed.title": "This decision is not available for this row",
  "catalogImport.review.notAllowed.body": "The row's options were reloaded.",

  // --- Step 5: Preview ---------------------------------------------------------------
  "catalogImport.preview.title": "What will happen when you publish",
  "catalogImport.preview.loading": "Loading the preview…",
  "catalogImport.preview.failed.title": "Could not load the preview",
  "catalogImport.preview.failed.body": "The catalog did not change.",
  "catalogImport.preview.count.create": "Products to create",
  "catalogImport.preview.count.update": "Products to update",
  "catalogImport.preview.count.identifiers": "Identifiers to add",
  "catalogImport.preview.count.brands": "Brands to create",
  "catalogImport.preview.count.unchanged": "Unchanged rows",
  "catalogImport.preview.count.excluded": "Excluded rows",
  "catalogImport.preview.deactivations": "Products taken off the tills: {count}",
  "catalogImport.preview.deactivationsBody": "They will not appear on any till after publishing.",
  "catalogImport.preview.deactivationRow": "Row {row}",
  "catalogImport.preview.unpriced": "New products without a price: {count}",
  "catalogImport.preview.unpricedBody":
    "None appears on a till until priced. The price in the file was not imported (in {rows} rows).",
  "catalogImport.preview.brands": "Brands to be created",
  "catalogImport.preview.changes": "Show changes",
  "catalogImport.preview.snapshot":
    "The preview was computed at {time}. It is a snapshot, not a reservation: the catalog may change before publishing, and then you validate again.",
  "catalogImport.preview.publish": "Publish import",
  "catalogImport.preview.nothing": "Nothing will change",
  "catalogImport.preview.nothingHint": "Every row is unchanged or excluded.",
  "catalogImport.preview.blockedConflict": "Publishing is unavailable: there are conflicting rows.",
  "catalogImport.preview.blockedUndecided":
    "Publishing is unavailable: rows still have no decision.",
  "catalogImport.preview.blockedNotPublishable":
    "Publishing is unavailable: the server will not accept this import now.",
  "catalogImport.preview.changed.title": "The preview changed since you saw it",
  "catalogImport.preview.changed.body":
    "Nothing was published. This is the new preview; review it, then publish if you want.",
  "catalogImport.preview.notPublishable.title": "This import cannot be published",
  "catalogImport.preview.notPublishable.body":
    "Some rows still lack a decision or have errors, or rows conflict. Nothing was published.",
  "catalogImport.preview.conflict.title": "This import cannot be published",
  "catalogImport.preview.conflict.body":
    "Rows change the same product in different ways. Nothing was published and the server will not accept it while these rows stay as they are.",
  "catalogImport.preview.conflict.caption": "Conflicting rows · products: {count}",
  "catalogImport.preview.conflict.product": "Product",
  "catalogImport.preview.conflict.rows": "Rows",
  "catalogImport.preview.conflict.reason": "Reason",
  "catalogImport.preview.conflict.field": "Two different values for “{field}”",
  "catalogImport.preview.conflict.secondSku": "The product would get a second SKU",
  "catalogImport.preview.conflict.fix":
    "Fix your source file so each product has one row, then upload it again.",
  "catalogImport.changes.title": "Field changes",
  "catalogImport.changes.empty": "No field changes in the update rows.",
  "catalogImport.changes.row": "Row {row} · {name}",
  "catalogImport.changes.before": "Before",
  "catalogImport.changes.after": "After",
  "catalogImport.changes.none": "(empty)",
  "catalogImport.changes.field.name": "Name",
  "catalogImport.changes.field.description": "Description",
  "catalogImport.changes.field.category": "Category",
  "catalogImport.changes.field.brand": "Brand",
  "catalogImport.changes.field.tax_category": "Tax category",
  "catalogImport.changes.field.is_active": "Active",
  "catalogImport.changes.loadFailed": "Could not load the changes. The catalog did not change.",

  // --- Step 6: Publish ----------------------------------------------------------------
  "catalogImport.publish.title": "Publish the import?",
  "catalogImport.publish.body":
    "The import is published to the catalog in one batch: all of it applies or none of it.",
  "catalogImport.publish.count.create": "New products (no price)",
  "catalogImport.publish.count.update": "Products to update",
  "catalogImport.publish.count.identifiers": "Identifiers to add",
  "catalogImport.publish.count.brands": "Brands to create",
  "catalogImport.publish.count.deactivated": "Products taken off the tills",
  "catalogImport.publish.consequence":
    "There is no undo for a publish here. Deactivated products are taken off every till.",
  "catalogImport.publish.cancel": "Cancel",
  "catalogImport.publish.confirm": "Confirm publish",
  "catalogImport.publish.busy": "Publishing…",
  "catalogImport.publish.inFlight":
    "Publishing… wait for the server's confirmation. Do not close the page.",
  "catalogImport.publish.unclear.title": "Publishing not confirmed",
  "catalogImport.publish.unclear.heading": "We do not know whether it was published",
  "catalogImport.publish.unclear.body":
    "No answer from the server; the catalog may have changed. Do not upload a new file or cancel the import until you are sure.",
  "catalogImport.publish.unclear.resend": "Resend",
  "catalogImport.publish.unclear.refresh": "Refresh status",
  "catalogImport.publish.unclear.close": "Close",
  "catalogImport.publish.unclear.refreshing": "Refreshing the status…",
  "catalogImport.publish.unclear.notPublished": "The import is not published yet. You can resend.",
  "catalogImport.publish.persistent.title": "Publish status unconfirmed",
  "catalogImport.publish.persistent.body":
    "We do not know whether the import was published. Make sure before any other action.",
  "catalogImport.publish.persistent.reason": "Unavailable until the status is confirmed.",
  "catalogImport.publish.wait": {
    one: "The server is still processing the previous request. Wait {count} second, then resend.",
    other:
      "The server is still processing the previous request. Wait {count} seconds, then resend.",
  },

  // --- Step 7: Result -------------------------------------------------------------------
  "catalogImport.result.title": "The import was published",
  "catalogImport.result.confirmed": "The server confirmed it at {time}.",
  "catalogImport.result.replay.title": "This import was already published",
  "catalogImport.result.replay.body": "This is its stored result; nothing new was published.",
  "catalogImport.result.count.created": "Products created",
  "catalogImport.result.count.updated": "Products updated",
  "catalogImport.result.count.identifiers": "Identifiers added",
  "catalogImport.result.count.brands": "Brands created",
  "catalogImport.result.count.deactivated": "Products taken off the tills",
  "catalogImport.result.count.unchanged": "Unchanged rows",
  "catalogImport.result.count.excluded": "Excluded rows",
  "catalogImport.result.unpriced": "New products without a price: {count}",
  "catalogImport.result.unpricedBody": "They do not appear on the till until priced.",
  "catalogImport.result.audit": "Audit reference (batch id)",
  "catalogImport.result.copy": "Copy reference",
  "catalogImport.result.copied": "Reference copied",
  "catalogImport.result.copyFailed": "Could not copy. Select the reference and copy it by hand.",
  "catalogImport.result.viewProducts": "View products",
  "catalogImport.result.another": "Import another file",
  "catalogImport.result.loadFailed.title": "Could not load the import result",
  "catalogImport.result.loadFailed.body": "The publish itself is unaffected.",

  // --- Errors by machine code (never the wire text) -------------------------------------
  "catalogImport.error.session": "Your session ended. Sign in again.",
  "catalogImport.error.notAvailable": "This import is no longer available to you.",
  "catalogImport.error.generic": "The request could not be completed. Try again.",
  "catalogImport.error.unknown":
    "An unexpected error occurred. We could not confirm the request's state.",
  "catalogImport.error.origin_rejected":
    "The request could not be made from this page. Reload and try again. Nothing changed.",
  "catalogImport.error.validation_error":
    "The request was not accepted. Reload the page. Nothing changed.",
  "catalogImport.error.file_too_large":
    "The file is over 5 MB. Split it and upload the parts one after the other.",
  "catalogImport.error.file_type_unsupported":
    "This file type is not supported. Save it as XLSX or CSV (UTF-8) and upload it.",
  "catalogImport.error.encoding_not_utf8":
    "The file is not UTF-8. Save it as “CSV UTF-8” or upload XLSX.",
  "catalogImport.error.file_unreadable":
    "The file could not be read and may be damaged. Re-save it in your spreadsheet app and upload it.",
  "catalogImport.error.xlsx_limits_exceeded":
    "The sheet exceeds the allowed limits. Delete empty rows and columns and upload it again.",
  "catalogImport.error.sheet_not_found":
    "The file has no sheet with that name. Leave the field empty to read the first sheet.",
  "catalogImport.error.header_missing":
    "There is no header row. Put the column titles in the first row.",
  "catalogImport.error.no_data_rows": "There are no data rows after the header row.",
  "catalogImport.error.too_many_rows":
    "The file has more than 5,000 rows. Split it into several files.",
  "catalogImport.error.file_too_many_rows":
    "The file has more rows than a spreadsheet allows. Delete empty rows and upload again.",
  "catalogImport.error.too_many_columns":
    "The file has more than 50 columns. Remove the ones you do not need and upload again.",
  "catalogImport.error.cell_too_long":
    "A cell is longer than 2,000 characters. Shorten it and upload the file.",
  "catalogImport.error.idempotency_key_conflict":
    "The request could not be completed. Reload and upload the file again.",
  "catalogImport.error.import_batch_open": "You have an open import.",
  "catalogImport.error.version_conflict":
    "This import changed since you opened it (maybe in another tab). It was reloaded; review it and try again.",
  "catalogImport.error.import_batch_closed":
    "This import is closed: it was published, cancelled or expired. Start a new one.",
  "catalogImport.error.import_batch_not_validated":
    "This import has no current validation results. Go back to Validate.",
  "catalogImport.error.preview_changed":
    "The preview changed since you saw it. Nothing was published. Review the new preview.",
  "catalogImport.error.import_not_publishable":
    "The import cannot be published: some rows still lack a decision or have errors, or rows conflict. Nothing was published.",
  "catalogImport.error.stale_validation":
    "The catalog changed since validation. Nothing was published. The import is back at Validate; validate again and review the preview.",
  "catalogImport.error.mapping_invalid":
    "The mapping is incomplete or conflicting; review the marked columns.",
  "catalogImport.error.mapping_required": "The mapping is not confirmed yet; confirm it first.",
  "catalogImport.error.resolution_not_allowed":
    "This decision is not available for this row. The row's options were reloaded.",
  "catalogImport.error.idempotency_in_progress":
    "The server is still processing the previous request. Wait, then resend.",
  "catalogImport.error.rate_limited": "Too many requests. Wait and try again.",

  // --- Row issues by code (fixed per code; cell values come from the row, never from here) ----
  "catalogImport.time.browser": "{time} (browser time zone)",
  "catalogImport.issue.cellValue": "Value: {value}",
  "catalogImport.issue.unknown": "An unexpected problem in this row.",
  "catalogImport.issue.required_field_missing":
    "A required field is empty: {field}. Enter a value in the file.",
  "catalogImport.issue.value_invalid": "{field}: invalid value. Correct it in the file.",
  "catalogImport.issue.identifier_numeric_cell":
    "{field}: the cell is numeric, so it loses zeros and long digits. Format the column as Text and upload again.",
  "catalogImport.issue.identifier_formula_cell":
    "{field}: the cell comes from a formula. Replace it with plain text.",
  "catalogImport.issue.identifier_non_ascii_digits":
    "{field}: contains Arabic-Indic digits. Write Latin digits 0-9, as a scanner reads them.",
  "catalogImport.issue.identifier_invisible_char":
    "{field}: contains a hidden character (non-breaking space or direction mark). Delete it and retype the value.",
  "catalogImport.issue.formula_without_value":
    "{field}: a formula with no saved result. Open the file, save it and upload again.",
  "catalogImport.issue.duplicate_in_file":
    "The identifier is repeated in row {row}. Keep one row per identifier.",
  "catalogImport.issue.category_not_found":
    "The category is not among the organisation's categories. Write its name exactly; imports cannot create categories.",
  "catalogImport.issue.product_retired":
    "Matches a product withdrawn from the catalog ({name}). Import does not reactivate products.",
  "catalogImport.issue.already_exists":
    "A product with this identifier exists ({name}). Use Update only or Create and update.",
  "catalogImport.issue.not_found":
    "No product has this identifier. Use Create only or Create and update.",
  "catalogImport.issue.ambiguous":
    "The row's identifiers belong to more than one product. Choose the intended product or exclude the row.",
  "catalogImport.issue.no_identifier":
    "The row has no identifier, so it cannot be scanned or matched later. Create it as is, or exclude it.",
  "catalogImport.issue.sku_mismatch":
    "Matches “{name}” but the row's SKU differs from its current SKU. A second SKU will not be added.",
  "catalogImport.issue.store_scoped_conflict":
    "The row's identifier is used by another product at a store. It will not be added.",
  "catalogImport.issue.possible_duplicate":
    "The name matches an existing product ({name}) with no identifier match. Decide: new product, or update the existing one.",
  "catalogImport.issue.gtin_check_digit":
    "The barcode's check digit is wrong. It may contain a typo.",
  "catalogImport.issue.tax_category_unused":
    "This tax category has never been used in your organisation. Check the spelling.",
  "catalogImport.issue.store_scoped_same_product":
    "The identifier is also registered for this product at a store.",
  "catalogImport.issue.deactivates_product": "This row takes the product off every till.",
  "catalogImport.issue.price_not_imported": "The price in this row is not imported yet.",
  "catalogImport.issue.whitespace_trimmed": "Extra spaces were removed from the cell.",
  "catalogImport.issue.formula_cached_value": "The saved result of a formula was used.",
  "catalogImport.issue.brand_created": "A new brand will be created: “{name}”.",
};
