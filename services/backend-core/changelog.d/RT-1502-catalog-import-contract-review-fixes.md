### Fixed
- RT-1502 `[GATED]`, owner authorization in the W1 lead session (2026-11-19): post-merge review follow-up to
  `catalog/catalog-import.yaml` (#717), now 1.0.1-draft, still contract-only. A re-upload sets `mapping` to `null`
  and offers the kept columns (exact header text) in `suggestedMapping`, so the merchant confirms the mapping again
  (decision 419); validate re-applies the mapping rules (`422 mapping_invalid`). The upload idempotency fingerprint
  adds the canonical query (`mode`, `sheet`, `delimiter`, `file_name`). The error report is read-only and never
  re-uploaded (the formula-guard `'` is named). The row-list cursor is bound to the validation generation, not to
  `version`, and the review decision → row status table is stated. Spec 049 marks OD-1..OD-17 accepted and lists
  the slice keys.
