### Added
- RT-1507 `[GATED: contract]` (spec 049 slice S5): the runtime of the last four served operations of
  `catalog/catalog-import.yaml`, which lose their `x-runtime-status: contract-only` markers (contract 1.0.5-draft, description
  text only: no operation or schema shape changes; the file replace, the error report and the template stay contract-only).
  `consoleResolveCatalogImportRow` (`PUT /api/v1/catalog/imports/{batchId}/rows/{rowNumber}/resolution`) records, changes or
  clears the review decision of one `needs_review` or `error` row (create new, update this product, exclude row): the row's new
  status and outcome (`identifiersNotAdded` filled), the batch's next version with its counts and `previewHash` recomputed,
  audited as `catalog.import.review`; in a `create` batch `update_product` is refused and an `ambiguous` row takes only
  `exclude`, a retired candidate is refused, and the chosen product's `updated_at` is captured for the publish re-check. A new
  validation keeps a decision while the row's candidate set and review reason are unchanged. `consoleGetCatalogImportPreview`
  (`GET .../preview`) answers the brands to create, the products to create and update, the identifiers to add, the products
  an update takes off the tills, the new products that will have no price and the rows excluded and unchanged, from the same
  plan the publish writes from. `consolePublishCatalogImport` (`POST .../publish`) publishes the batch in ONE transaction
  under a per-tenant lock: it requires the `previewHash` shown, re-checks the catalogue (`409 stale_validation`, the batch back
  to `draft`), writes the brands, products, identifiers, audit rows (each with `import_batch_id` and the row number) and the
  batch's `published` transition through the console catalog domain functions with conditional writes, so a concurrent edit or
  identifier claim is a `409`, never a 500; the same key and body, or a published batch's own hash, replays the stored result.
  `consoleCancelCatalogImport` (`POST .../cancel`) closes an open batch (audited as `catalog.import.cancel`; the expiry
  `catalog.import.expire` is the retention worker's, RT-1503).
- RT-1507 `console-catalog.domain.ts`: the product, identifier and brand writes of `console-catalog.write.service.ts` are now set-based
  domain functions the single-product writes call with one item and the import's publish with the whole batch; no change to any
  console catalog route, response, refusal or audit row. `offers` exports `rebuildOfferPackForCatalogChanges` (the catalog hook for
  many products at once) and `audit` exports `insertAuditRowsInTransaction`. No migration, no new dependency, no package or
  lockfile change.
