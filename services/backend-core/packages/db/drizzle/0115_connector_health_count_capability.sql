-- 0115_connector_health_count_capability.sql
--
-- RT-1427 [GATED: migration] — the Connector heartbeat carries the evidence Count
-- activation (RT-1423) needs: which posting work-item kinds the deployed Connector
-- accepts, and whether its ERP user may post back-dated stock documents.
--
-- Additive and nullable: four columns on the existing `connector_health` read-model.
-- No new table, no policy change (the 0022 tenant policies and grants cover the new
-- columns). A NULL column means "no evidence reported", which readiness treats as
-- not ready (fail closed). Last-write-wins like the rest of the row: a beat that
-- omits a field stores NULL for it, so evidence never outlives the beat that
-- stopped reporting it.
--
--   accepted_work_item_kinds        self-reported kinds the Connector accepts
--   back_dated_role_status          verified | missing | unknown (self-report)
--   back_dated_role_checked_at      Connector clock of the check (provenance only)
--   back_dated_role_reported_at     DP2 SERVER clock when the status last arrived;
--                                   the only clock freshness is judged by (§X)
--
-- BUSINESS-class telemetry, no PII, no secret, no money (§XIV).

BEGIN;

ALTER TABLE connector_health
  ADD COLUMN IF NOT EXISTS accepted_work_item_kinds    TEXT[],
  ADD COLUMN IF NOT EXISTS back_dated_role_status      TEXT,
  ADD COLUMN IF NOT EXISTS back_dated_role_checked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS back_dated_role_reported_at TIMESTAMPTZ;

ALTER TABLE connector_health
  ADD CONSTRAINT connector_health_back_dated_role_status_valid
    CHECK (back_dated_role_status IS NULL
           OR back_dated_role_status IN ('verified', 'missing', 'unknown')),
  ADD CONSTRAINT connector_health_work_item_kinds_bounded
    CHECK (accepted_work_item_kinds IS NULL
           OR cardinality(accepted_work_item_kinds) <= 16),
  -- A status and its server stamp travel together.
  ADD CONSTRAINT connector_health_back_dated_role_pair
    CHECK ((back_dated_role_status IS NULL) = (back_dated_role_reported_at IS NULL));

COMMIT;
