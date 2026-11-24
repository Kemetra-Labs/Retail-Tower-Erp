-- RT-1578 (RT-1511 slice S3; spec 013-inventory-awareness) — the local store-availability cache.
--
-- Authority: the owner-authored RT-1578 scope ("a local SQLite cache filled from posGetStoreAvailability",
-- per-store scope, purged on a store change or a re-pair, spec 013 FR-7) and the RT-1511 decision record
-- (Confluence page 91389953). Additive: two new tables, no existing table is touched. Ships EMPTY.
--
-- ## Shape
--
-- `availability_state` — one row at most (`id = 1`), the scope and freshness of what the cache holds:
--   scope_key     `<tenant_id>|<branch_id>|<paired_at>` the rows were read under. A row under another
--                 scope is ignored and purged, so a store change and a re-pair to the SAME store both
--                 drop the cache (FR-7). `paired_at` is what makes the re-pair visible.
--   oldest_as_of  the OLDEST per-page `asOf` of the last successful refresh: the cache freshness
--                 (the contract: "the till keeps the oldest asOf of a refresh as its freshness").
--   refreshed_at  the terminal clock at the commit (diagnostics only; the UI never reads it).
--
-- `availability_item` — one row per sellable product of the store:
--   product_id         the catalogue read-down's `product_id`.
--   band               'in_stock' | 'low' | 'out', exactly as the server computed it (never recomputed here).
--   available_to_sell  the exact-decimal STRING. Kept in the cache only; no screen shows it (owner decision
--                      2026-11-24). No money, currency or tender field exists in the contract.
--
-- A refresh replaces BOTH tables in one transaction, so the cache never holds a half-written snapshot.
-- No secrets and no PII: ids, a band, a decimal string and timestamps. NOT an audit anchor: no trigger.
--
-- ## Rollback
--
-- DROP TABLE availability_item; DROP TABLE availability_state; (an older build refuses a database that
-- holds 0072, RT-320, so a rollback ships with the build that drops them).

CREATE TABLE IF NOT EXISTS availability_state (
  id           INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  scope_key    TEXT NOT NULL,
  oldest_as_of TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability_item (
  product_id        TEXT NOT NULL PRIMARY KEY,
  band              TEXT NOT NULL CHECK (band IN ('in_stock', 'low', 'out')),
  available_to_sell TEXT NOT NULL
);
