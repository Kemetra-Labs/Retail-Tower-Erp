### Added
- RT-1503 (spec 049 S2, plan Track B PR-3): the worker job `catalog-import-retention` (default hourly,
  `CATALOG_IMPORT_RETENTION_INTERVAL_MS`, at least one minute). Per tenant, under that tenant's own RLS context, it
  expires each open `draft` / `validated` import batch past `expires_at` with the spec 049 §8.1 conditional `UPDATE`
  (version-checked; `closed_at` set, `expires_at` and `preview_hash` cleared, `version` bumped) and writes one
  `catalog.import.expire` audit row in the same transaction. It then deletes the staged rows of `cancelled` / `expired`
  batches 30 days after `closed_at` and of `published` batches 13 months after `published_at`, stamps
  `rows_purged_at` and keeps the batch header (OD-6); the transaction rolls back if the deleted and stamped counts
  disagree. Bounded passes with `FOR UPDATE SKIP LOCKED`; a rerun is idempotent. No new grant, role or migration. The
  per-tenant sweeps now share one platform-admin tenant listing (`apps/worker/src/common/all-tenant-ids.ts`), so the
  RT-1389 allowlist does not grow. The 0124 migration spec also pins its Docker skip policy (only a missing container
  runtime skips under `MIGRATION_TEST_ALLOW_SKIP=1`).
