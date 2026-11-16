### Added
- RT-1423 `[GATED: migration, contract]`, owner authorization 2026-11-16 (Inventory Gate 6 / RT-292, G6-6, G6-7):
  an approved Count Session is posted to ERP through the EXISTING posting feed. Migration 0116 lets
  `erpnext_posting_status` hold `inventory_count` chunks (no sale; the status `verified_noop`; session, chunk and
  frozen stamp columns; `UNIQUE (tenant, session, chunk)`), adds the frozen `count_posting_lines` and lets a
  count correction be `confirmed` with no document when ERP already held the target (`count_verified_noop`).
  Approval writes the chunks in the same transaction as the corrections: at most 100 lines each, the ABSOLUTE
  counted target (never the Retail variance), the frozen Cut + 1 microsecond and the key `count:<sessionId>[:<chunk>]`.
  The ack route accepts `verified_noop` and per-line `lines`; the ack changes integration state only, a chunk
  with a rejected line is never fully confirmed (the session needs attention), and the session reaches
  `confirmed` only when every chunk is posted or a verified no-op. `inventory.yaml` 1.17.0-draft adds
  `getCountSessionsSetting` / `setCountSessionsSetting` (owner / tenant_admin): default OFF, switching on fails
  closed (409 `count_sessions_readiness_unmet`, no override), switching off is refused while a session is open
  (409 `count_sessions_open`), and the legacy `recordStockCount` answers the typed 409 `count_sessions_active`
  once on. The back-dated ERP role has no evidence in Backend-Core, so activation stays refused until a
  Connector heartbeat capability exists. New grants fragment `count-posting.grants.ts` and deploy script
  `docs/operations/sql/count-posting-domain-grants.sql`.
