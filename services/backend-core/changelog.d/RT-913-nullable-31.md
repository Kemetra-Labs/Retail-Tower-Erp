### Changed
- RT-913 (contracts, no wire change): the 49 OpenAPI 3.0 `nullable: true` keywords left in
  13 Backend-Core contracts (audit, auth, catalog/unknown-items, context, memberships, outbox,
  pos-audit-events, pos-operators, pos-payments/vouchers, pos-shifts, pos-terminal-pairing,
  stores, tenants) now use the OpenAPI 3.1 form: `type: [T, "null"]` for a typed schema,
  `anyOf: [{$ref}, {type: "null"}]` for a `$ref` (`ContextResponse.active_tenant` /
  `active_store`), and `null` listed in the `resolution_action` enum of `UnknownItem` and
  `ReviewQueueItem`, which the API already returns as null while an item is pending. Each
  schema accepts the same instances as before under OpenAPI 3.0 `nullable` semantics.
  oasdiff 1.32.1 reports 29 false positives for this, acknowledged in
  `tools/oasdiff/breaking-ignore.txt`.
