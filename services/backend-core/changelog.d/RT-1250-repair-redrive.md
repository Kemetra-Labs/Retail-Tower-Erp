### Fixed
- RT-1250, owner decision 2026-11-06 (option 2): a sale repaired through the Console
  (`POST /api/v1/catalog/sale-sync-ops/sales/{saleRef}/repair`) is now processed even when the repair
  comes more than `SALE_REDRIVE_MAX_AGE_MS` (7 days) after capture. The RT-457 re-drive sweep also selects
  an unprocessed `failed-retryable` sale whose needs-repair dead-letter was resolved inside the age window;
  the max age and the capture-time rule for sales nobody repaired are unchanged.
