### Changed
- RT-1503 `[GATED]`, owner authorization in the W1 lead session (2026-11-19; decisions in RT-1503 comments 17823 and
  17830): `catalog/catalog-import.yaml` is now 1.0.2-draft, description text only and still contract-only. It defines
  the upload fingerprint's canonical query (decoded values compared byte for byte, no Unicode normalisation, an absent
  parameter distinct from any value), the re-upload suggestion dedupe (carried entries take priority and their fields
  are not suggested again, `barcode` up to 5), the row-list cursor's binding to the `status` query filter, and what
  `mappingProfileId` holds after a re-upload. Spec 049 §9.1 records the OD-14 re-check (interim import tables kept:
  the `change_sets` table on `main` is pricing-only); §10 lists the S2 columns (`validation_generation`,
  `suggested_mapping`, `columns`, `csv_delimiter`, row and column counts, `publish_summary`, the row's
  `review_reason`), the mapping-profile columns, the one-open-batch and previous-publish indexes, and the retention and
  7-day expiry job that S2 owns; §13's stale checkboxes are corrected.
