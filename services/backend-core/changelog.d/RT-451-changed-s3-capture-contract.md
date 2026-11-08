### Changed
- RT-451 S3 contract `[GATED: contract]` (captain decision under owner
  delegation, RT-451 comment 16262 as revised by 16269, with 16275 (b);
  OD-T4 of comment 16215): `pos-sales/sales.yaml` 1.21.0-draft, wording
  only. The `captureSale` G7-9 classification applies only while tracked
  selling is on (the deployment gate AND the tenant switch). While either is
  off, a tracked product's line, with or without `tracking`, is an ordinary
  line, never `tracking_unresolved` and never a finding; a `tracking` it
  carries is stored as received (provenance) and stays in the hash. There is
  no 400 for tracking reasons. An ad-hoc line's `tracking` is provenance
  only, whatever the switch state. `safetyRevision` and `safetySyncedAt` are
  accepted whatever the switch state. No shape change.
