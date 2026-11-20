/**
 * RT-1503 (spec 049 S2) — cadence and batch sizes of the catalogue import
 * expiry and retention job.
 *
 * `CATALOG_IMPORT_RETENTION_INTERVAL_MS` (optional)
 *   - unset or blank → 3_600_000 (hourly);
 *   - otherwise a whole number of milliseconds, at least 60_000 (1 minute).
 * Any other value refuses boot (the scheduler resolves it at module init), so
 * a typo never silently falls back to the default.
 *
 * The interval bounds how late an open batch expires after its `expires_at`
 * (at most one interval, plus a retry backoff): until then the batch still
 * blocks a new upload with 409 `import_batch_open`. The 30-day and 13-month
 * purges are not sensitive to it.
 */

export const IMPORT_RETENTION_INTERVAL_ENV = "CATALOG_IMPORT_RETENTION_INTERVAL_MS";

export const DEFAULT_IMPORT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export const MIN_IMPORT_RETENTION_INTERVAL_MS = 60 * 1000;

/** Batches expired per transaction (one conditional UPDATE and one audit row each). */
export const DEFAULT_EXPIRY_BATCH_LIMIT = 100;

/**
 * Batches whose rows are purged per transaction: at most 10 batches. That is
 * about 50,000 rows when the runtime respects `data_row_count` (at most 5,000
 * rows per batch); migration 0124 does not enforce rows <= data_row_count, so
 * the row count per transaction is not a hard bound.
 */
export const DEFAULT_PURGE_BATCH_LIMIT = 10;

export interface ImportRetentionLimits {
  readonly expiryBatchLimit: number;
  readonly purgeBatchLimit: number;
}

export const DEFAULT_IMPORT_RETENTION_LIMITS: ImportRetentionLimits = Object.freeze({
  expiryBatchLimit: DEFAULT_EXPIRY_BATCH_LIMIT,
  purgeBatchLimit: DEFAULT_PURGE_BATCH_LIMIT,
});

/** The configured job interval in ms. Throws on an invalid value. */
export function resolveImportRetentionIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[IMPORT_RETENTION_INTERVAL_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_IMPORT_RETENTION_INTERVAL_MS;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= MIN_IMPORT_RETENTION_INTERVAL_MS) return parsed;
  throw new Error(
    `${IMPORT_RETENTION_INTERVAL_ENV} must be a whole number of milliseconds >= ${MIN_IMPORT_RETENTION_INTERVAL_MS}`,
  );
}
