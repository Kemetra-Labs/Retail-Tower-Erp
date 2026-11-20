### Added
- RT-1503 `[GATED]`, owner authorization in the W1 lead session (2026-11-19, plan Track B PR-2): migration
  `0124_catalog_import` (spec 049 S2), the manual product import staging tables. `catalog_import_batches` holds one
  upload (spec 042 state names plus `expired`, `version`, `validation_generation`, file facts, header `columns`,
  `mapping` / `suggested_mapping` as the contract's ColumnMapping[], stored `warnings` and `publish_summary`,
  `expires_at`, `closed_at`, `rows_purged_at`), with one open batch per tenant (partial unique index), a
  previous-publish index and an expiry index; a batch is never deleted (trigger). `catalog_import_rows` holds the parsed
  rows (PK `(tenant_id, batch_id, row_number)`, composite FK to the batch), deletable for re-upload and the retention
  purge. `catalog_import_mapping_profiles` holds the saved mappings, unique per `(tenant_id, name)`; an upsert keeps the
  `id`. All FORCE RLS, with `docs/operations/sql/catalog-import-domain-grants.sql` (DELETE on the rows only). No runtime
  uses the tables until RT-1505 / RT-1507. Spec 049 §8.1, §10, §12 and §13 record the expiry rule, the cursor binding,
  the corrected RLS wording, the new columns and the open items for RT-1505 / RT-1507.
