-- 0090_device_health_sale_queue.sql
--
-- RT-1312 Phase 1 (F1, RT-1124 review): the till's unsent sale counts on its
-- stored heartbeat. [GATED] migration, owner-authorized 2026-11-10 (RT-1312
-- comment 16398, decision P1-D2): additive nullable columns, no backfill.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-device-health.openapi.yaml
--       (`SaleQueueReport` on the heartbeat, `SaleQueueView` on the console row)
--   - packages/db/__tests__/migration/0090-device-health-sale-queue.spec.ts
--
-- `device_health` (0068) gains, as the last stored beat reported them:
--   sale_queue_pending            sales waiting to be sent (current pairing)
--   sale_queue_dead_letter        sales the server refused for good
--   sale_queue_held               unsent sales of an earlier pairing (held)
--   sale_queue_oldest_pending_at  the oldest pending sale's time, NULL if none
-- All four NULL means unknown (a beat that carried no queue, or a till older
-- than the field): never 0. Counts only: no sale id, number or amount.
--
-- Nullable columns with no default are a catalog-only change: no rewrite and
-- no backfill. The lock wait is bounded so a busy heartbeat path cannot hold
-- the migration (or be held by it) for long.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE device_health
  ADD COLUMN IF NOT EXISTS sale_queue_pending           INTEGER,
  ADD COLUMN IF NOT EXISTS sale_queue_dead_letter       INTEGER,
  ADD COLUMN IF NOT EXISTS sale_queue_held              INTEGER,
  ADD COLUMN IF NOT EXISTS sale_queue_oldest_pending_at TIMESTAMPTZ;

ALTER TABLE device_health
  ADD CONSTRAINT device_health_sale_queue_bounds
    CHECK (
      (sale_queue_pending IS NULL OR sale_queue_pending BETWEEN 0 AND 1000000)
      AND (sale_queue_dead_letter IS NULL OR sale_queue_dead_letter BETWEEN 0 AND 1000000)
      AND (sale_queue_held IS NULL OR sale_queue_held BETWEEN 0 AND 1000000)
    ),
  ADD CONSTRAINT device_health_sale_queue_consistent
    CHECK (
      (sale_queue_pending IS NULL
        AND sale_queue_dead_letter IS NULL
        AND sale_queue_held IS NULL
        AND sale_queue_oldest_pending_at IS NULL)
      OR (sale_queue_pending IS NOT NULL
        AND sale_queue_dead_letter IS NOT NULL
        AND sale_queue_held IS NOT NULL)
    );

COMMIT;
