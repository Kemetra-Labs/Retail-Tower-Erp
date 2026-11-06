### Added
- RT-919 `[GATED]`, owner approval Jira RT-919 comment 15730 (2026-11-06, no
  migration, no OpenAPI edit): the ERPNext bin-view snapshot report accepts the
  optional stock-view 1.4.0-draft `BinEntry.tracking` evidence (the Item's
  `hasBatchNo` / `hasSerialNo` / `hasExpiryDate` flags and, for a batch Item,
  up to 200 Batches with book quantity, expiry date and disabled flag). Both
  shapes are accepted: a batch Item with Batches, and an untracked Item with
  three false flags. A malformed `tracking` is a 400 `validation_error`. The
  evidence is stored as reported on the entry in
  `erpnext_reconciliation_run.summary.bin_view_report`; an entry without it is
  stored exactly as before, and the replay/conflict check now includes it. It
  creates no Tracking Identity, moves no position and posts nothing (RT-453).
  The Connector may start sending it (RT-918) once this is deployed.
