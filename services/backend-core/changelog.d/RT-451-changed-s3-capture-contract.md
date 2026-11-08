### Changed
- RT-451 S3 contract `[GATED: contract]` (captain decision under owner
  delegation, RT-451 comment 16262; OD-T4 of comment 16215):
  `pos-sales/sales.yaml` 1.21.0-draft, wording only. The `captureSale` G7-9
  classification applies only while tracked selling is on (the deployment
  gate AND the tenant switch). While either is off, a tracked product's line
  without `tracking` is an ordinary line, never `tracking_unresolved`, and a
  line carrying `tracking` is the existing 400 `validation_error`, decided
  after the replay branch. `safetyRevision` and `safetySyncedAt` are accepted
  whatever the switch state. No shape change.
