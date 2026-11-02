### Changed
- RT-913 (contracts, no wire change): the 49 OpenAPI 3.0 `nullable: true` keywords left in
  13 Backend-Core contracts (audit, auth, catalog/unknown-items, context, memberships, outbox,
  pos-audit-events, pos-operators, pos-payments/vouchers, pos-shifts, pos-terminal-pairing,
  stores, tenants) now use the OpenAPI 3.1 form: `type: [T, "null"]` for a typed schema,
  `anyOf: [{$ref}, {type: "null"}]` for a `$ref` (`ContextResponse.active_tenant` /
  `active_store`), and `null` listed in the `resolution_action` enum of `UnknownItem` and
  `ReviewQueueItem`. Every other schema accepts exactly the same instances as before.
  The enum `null` is the one intended instance-set widening: under a strict OpenAPI 3.0
  reading (`enum` still applies) these two required fields rejected `null`, although the API
  already returns `null` while an item is pending (the latent defect recorded on RT-53); the
  contract now matches the wire. oasdiff 1.32.1 reports 29 false positives for the change,
  acknowledged in `tools/oasdiff/breaking-ignore.txt`. The Admin-Console is repinned in the
  same PR; its generated client gains `| null` on `active_tenant` and `active_store` only.
