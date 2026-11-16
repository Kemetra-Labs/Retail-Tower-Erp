### Added
- RT-1422 `[GATED: contract pin]`, owner authorization 2026-11-16 (Inventory Gate 6): `erpnext-connector/posting-feed.yaml`
  1.15.0-draft adopts the `inventory_count` work-item kind. `PostingWorkItem.kind` gains the value, `sale` becomes
  conditional (required for `sale_post` and `reversal`, forbidden for `inventory_count`), an optional `count` carries
  `CountPosting`, and the ack gains the outcome `verified_noop` and optional per-line `lines`, both for `inventory_count`
  only. Backend-Core does not emit the kind (RT-1423); the Connector accepts it first. Acknowledged oasdiff findings:
  `breaking-ignore.txt` lines tagged `consumer:connector`.
