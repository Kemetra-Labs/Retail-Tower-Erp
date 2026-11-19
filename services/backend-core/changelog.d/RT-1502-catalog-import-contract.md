### Added
- RT-1502 `[GATED]`, owner authorization on RT-1489 (OD-1..OD-17 accepted, comment 17790, 2026-11-19):
  the Console product import contract `catalog/catalog-import.yaml` 1.0.0-draft (spec 049 slice S1):
  raw-body CSV / XLSX upload with key + file SHA-256 idempotency, mapping, validation, keyset rows,
  review decisions, preview, one-transaction publish, cancel, template and error-report downloads.
  Interim batch with spec 042 state names (OD-14 A). No price write. Contract-only; the runtime ships
  in RT-1505 and the S5 slice.
