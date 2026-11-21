-- RT-388 — the till's local shift variance policy: the cached policy and the
-- policy frozen with each cash-up open (AD-CASH-001 F5, DR-6 / DR-7).
--
-- [GATED: migration] approval: RT-388 comment 18072 (the owner approved
-- starting RT-388, including this POS SQLite migration, in chat on 2026-11-21:
-- two additive tables, `cash_variance_policy_cache` and
-- `shift_cashup_open_policies`, and nothing else). No Backend-Core change, no
-- contract change, no repin.
--
-- ## Why
--
-- Backend-Core resolves one effective variance policy per store
-- (`GET /api/pos/v1/store/cash-variance-policy`, `none` or a `limit`). The till
-- must (a) keep the last policy it read, with no maximum age (DR-7), so a
-- terminal that is offline still applies the policy it last saw; and (b) freeze
-- the policy per cash session at the open (K-2), so a change applies from the
-- next open and a session already open keeps the value it opened with.
-- `shift_cashup_opens` is append-only and its facts are sent as stored bytes, so
-- the frozen policy gets its own append-only table instead of columns.
--
-- ## Shape
--
--   cash_variance_policy_cache   one row at most (`id = 1`): the last policy read
--                                for (tenant_id, branch_id), its ETag (null when
--                                the answer carried none) and the server clock
--                                of the read. A row of another
--                                tenant or branch is ignored by the code (a
--                                re-pair), and never consulted.
--   shift_cashup_open_policies   one row per shift opened after the upgrade: the
--                                policy frozen at that open (source, revision
--                                id, mode, limit amount as the exact-decimal
--                                string, currency). A shift opened before the
--                                upgrade has no row and is evaluated as legacy
--                                (no limit; no `frozenPolicy` was sent). Append-
--                                only, like the open it belongs to.
--
-- `policy_source` is `system`, `tenant` or `store` in the cache (the device
-- read never answers `fallback`) and also `fallback` in a frozen row (a
-- terminal that never fetched the policy freezes the fail-closed `limit 0`).
-- `policy_revision_id` is set exactly for source `tenant` or `store`.
--
-- No secret and no PII: ids, a mode, an amount and a currency.
--
-- ## §A2 migration safety
--
--   • Additive only: two new tables and two triggers, IF NOT EXISTS, shipped
--     empty. No existing table, column, index or trigger is touched; no
--     backfill. Every shift that already exists is unchanged.
--   • The CHECKs keep each row well-formed; the deeper validation (decimal
--     grammar against the currency, uuid shape) runs in main before a write.
--   • Runs in the runner's per-file transaction, after the RT-320
--     pre-migration snapshot of the live database.
--
-- ## Rollback (manual, not run by the app)
--
-- Downgrades are unsupported: a pre-0066 build refuses a database that lists
-- 0066 as applied (`SchemaAheadError`, RT-320). By hand:
--
--   DROP TRIGGER trg_shift_cashup_open_policies_no_update;
--   DROP TRIGGER trg_shift_cashup_open_policies_no_delete;
--   DROP TABLE shift_cashup_open_policies;
--   DROP TABLE cash_variance_policy_cache;
--
-- The cache is disposable (the next read fills it); dropping the frozen rows
-- turns the open shifts back into legacy shifts.

CREATE TABLE IF NOT EXISTS cash_variance_policy_cache (
  id                  INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  tenant_id           TEXT    NOT NULL CHECK (length(tenant_id) > 0),
  branch_id           TEXT    NOT NULL CHECK (length(branch_id) > 0),
  policy_source       TEXT    NOT NULL CHECK (policy_source IN ('system', 'tenant', 'store')),
  policy_revision_id  TEXT    CHECK (policy_revision_id IS NULL OR length(policy_revision_id) = 36),
  policy_mode         TEXT    NOT NULL CHECK (policy_mode IN ('none', 'limit')),
  limit_amount        TEXT    CHECK (
    limit_amount IS NULL OR (
      length(limit_amount) BETWEEN 1 AND 20
      AND limit_amount NOT GLOB '*[^0-9.]*'
      AND limit_amount NOT GLOB '.*'
      AND limit_amount NOT GLOB '*.'
      AND limit_amount NOT GLOB '*.*.*'
    )
  ),
  currency_code       TEXT    CHECK (
    currency_code IS NULL OR (length(currency_code) = 3 AND currency_code NOT GLOB '*[^A-Z]*')
  ),
  etag                TEXT    CHECK (etag IS NULL OR length(etag) > 0),
  server_time         TEXT    NOT NULL,
  fetched_at          TEXT    NOT NULL,
  CHECK ((policy_source IN ('tenant', 'store')) = (policy_revision_id IS NOT NULL)),
  CHECK (
    (policy_mode = 'limit' AND limit_amount IS NOT NULL AND currency_code IS NOT NULL)
    OR (policy_mode = 'none' AND limit_amount IS NULL AND currency_code IS NULL)
  ),
  CHECK (policy_source <> 'system' OR policy_mode = 'none')
);

CREATE TABLE IF NOT EXISTS shift_cashup_open_policies (
  shift_id            TEXT    NOT NULL PRIMARY KEY REFERENCES shift_cashup_opens (shift_id),
  policy_source       TEXT    NOT NULL CHECK (
    policy_source IN ('system', 'tenant', 'store', 'fallback')
  ),
  policy_revision_id  TEXT    CHECK (policy_revision_id IS NULL OR length(policy_revision_id) = 36),
  policy_mode         TEXT    NOT NULL CHECK (policy_mode IN ('none', 'limit')),
  limit_amount        TEXT    CHECK (
    limit_amount IS NULL OR (
      length(limit_amount) BETWEEN 1 AND 20
      AND limit_amount NOT GLOB '*[^0-9.]*'
      AND limit_amount NOT GLOB '.*'
      AND limit_amount NOT GLOB '*.'
      AND limit_amount NOT GLOB '*.*.*'
    )
  ),
  currency_code       TEXT    CHECK (
    currency_code IS NULL OR (length(currency_code) = 3 AND currency_code NOT GLOB '*[^A-Z]*')
  ),
  frozen_at           TEXT    NOT NULL,
  CHECK ((policy_source IN ('tenant', 'store')) = (policy_revision_id IS NOT NULL)),
  CHECK (
    (policy_mode = 'limit' AND limit_amount IS NOT NULL AND currency_code IS NOT NULL)
    OR (policy_mode = 'none' AND limit_amount IS NULL AND currency_code IS NULL)
  ),
  CHECK (policy_source <> 'system' OR policy_mode = 'none')
);

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_open_policies_no_update
BEFORE UPDATE ON shift_cashup_open_policies
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_open_policies is append-only: UPDATE is denied (RT-388)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_open_policies_no_delete
BEFORE DELETE ON shift_cashup_open_policies
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_open_policies is append-only: DELETE is denied (RT-388)');
END;
