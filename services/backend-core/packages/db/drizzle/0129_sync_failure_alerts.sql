-- 0129_sync_failure_alerts.sql
--
-- RT-1034 (RT-1033 D2, Automation V1 PoC) — `[GATED: migration]`.
-- Owner authority: Jira RT-1034 comment 18022 (2026-11-21): ONE migration for
-- alert state and delivery tables, RLS ENABLE + FORCE. Applying it to a lab or
-- live database is NOT authorized by this file.
--
-- Creates TWO tables for the sync-failure email alert:
--
--   sync_failure_alert_windows     one row per alert window of a condition at a
--                                  store. The condition is one of the existing
--                                  failure states the alert only READS
--                                  ('posting_permanently_rejected' =
--                                  erpnext_posting_status.status,
--                                  'sale_failed_needs_repair' =
--                                  sales.sync_status). A window opens when the
--                                  sweep first sees the condition and closes
--                                  (cleared_at) when the sweep sees it gone, so
--                                  the condition RE-ARMS only after it clears.
--   sync_failure_alert_deliveries  one row per (window, recipient), claimed
--                                  BEFORE the provider call. Its unique key
--                                  (window_id, recipient_user_id) is the dedup
--                                  key: with the window's (tenant, store,
--                                  condition, window_seq) it makes one
--                                  notification per recipient per window.
--
-- Dedup keys:
--   UNIQUE (tenant_id, store_id, condition_key, window_seq)   one row per window
--   UNIQUE (tenant_id, store_id, condition_key) WHERE cleared_at IS NULL
--                                                             at most ONE open window
--   UNIQUE (window_id, recipient_user_id)                     one delivery claim
--
-- RLS: ENABLE + FORCE, the 0036 CASE-GUC form. SELECT, INSERT and UPDATE are
-- limited to the caller's tenant; no DELETE policy (history is kept).
-- The alert never writes posting, reconciliation or sale tables: it holds
-- SELECT-only access to them (see the grants script).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS operational state: ids, an enum condition key, counts, an
-- error CLASS name (never an error message), and timestamps. NO email address
-- (the recipient is a user id), NO message body, NO payload, NO secret.
-- Retained for the life of the tenant.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0129_sync_failure_alerts.down.sql drops both tables. Losing them
-- only means an open condition alerts once more after the next deploy.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/sync-failure-alerts-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the worker that needs it starts.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS sync_failure_alert_windows (
  id                UUID         PRIMARY KEY,
  tenant_id         UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id          UUID         NOT NULL,
  condition_key     TEXT         NOT NULL,
  window_seq        INTEGER      NOT NULL,
  failure_count     INTEGER      NOT NULL,
  opened_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  cleared_at        TIMESTAMPTZ,
  CONSTRAINT fk_sync_failure_alert_windows_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_failure_alert_windows_condition_valid
    CHECK (condition_key IN ('posting_permanently_rejected', 'sale_failed_needs_repair')),
  CONSTRAINT sync_failure_alert_windows_seq_positive CHECK (window_seq >= 1),
  CONSTRAINT sync_failure_alert_windows_count_positive CHECK (failure_count >= 1),
  CONSTRAINT sync_failure_alert_windows_tenant_id_uk UNIQUE (tenant_id, id),
  CONSTRAINT sync_failure_alert_windows_dedup_uk
    UNIQUE (tenant_id, store_id, condition_key, window_seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS sync_failure_alert_windows_one_open_uidx
  ON sync_failure_alert_windows (tenant_id, store_id, condition_key)
  WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS sync_failure_alert_deliveries (
  id                 UUID         PRIMARY KEY,
  tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  window_id          UUID         NOT NULL,
  recipient_user_id  UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status             TEXT         NOT NULL,
  attempts           INTEGER      NOT NULL DEFAULT 0,
  last_error_class   TEXT,
  claimed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  delivered_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_sync_failure_alert_deliveries_window_tenant
    FOREIGN KEY (tenant_id, window_id)
    REFERENCES sync_failure_alert_windows(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_failure_alert_deliveries_status_valid
    CHECK (status IN ('claimed', 'delivered', 'failed')),
  CONSTRAINT sync_failure_alert_deliveries_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT sync_failure_alert_deliveries_delivered_at_when_delivered
    CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT sync_failure_alert_deliveries_dedup_uk UNIQUE (window_id, recipient_user_id)
);

ALTER TABLE sync_failure_alert_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_failure_alert_windows FORCE  ROW LEVEL SECURITY;
ALTER TABLE sync_failure_alert_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_failure_alert_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY sync_failure_alert_windows_tenant_select ON sync_failure_alert_windows
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY sync_failure_alert_windows_tenant_insert ON sync_failure_alert_windows
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY sync_failure_alert_windows_tenant_update ON sync_failure_alert_windows
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY sync_failure_alert_deliveries_tenant_select ON sync_failure_alert_deliveries
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY sync_failure_alert_deliveries_tenant_insert ON sync_failure_alert_deliveries
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY sync_failure_alert_deliveries_tenant_update ON sync_failure_alert_deliveries
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
