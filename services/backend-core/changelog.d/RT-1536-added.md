### Added
- RT-1536 `[GATED: contract]`, owner delegation 2026-11-21 (spec 049 S5b, `catalog-import.yaml` 1.0.6-draft): the
  import preview (`consoleGetCatalogImportPreview`) runs the publish's own conflict detection. A batch the publish
  refuses with `409 import_not_publishable` because two rows state different values for a product field, or would give
  it a second SKU, now reports `publishable: false` and the new optional `conflictCount` and `conflicts` (product, row
  numbers, `field_disagreement` with the field, or `second_sku`; at most 100 conflicts, 50 rows each). Additive only: no
  field removed or renamed, the publish and its 409 body are unchanged, no migration.
