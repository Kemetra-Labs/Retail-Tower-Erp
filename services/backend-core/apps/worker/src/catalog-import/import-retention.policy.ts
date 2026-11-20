/**
 * RT-1503 (spec 049 S2) — the retention windows of the catalogue import
 * expiry and retention job. No NestJS, BullMQ or database imports.
 *
 * Windows (OD-6; spec 049 §8.1, §8.7, §10):
 *   - an open `draft` or `validated` batch expires once `expires_at <= now`
 *     (`expires_at` is the batch's last change + 7 days, moved by the runtime
 *     on every change; the 7-day arithmetic is the runtime's, not this job's);
 *   - the rows of a `cancelled` or `expired` batch are deleted 30 days after
 *     `closed_at`;
 *   - the rows of a `published` batch are deleted 13 months after
 *     `published_at`;
 *   - the batch header always stays (`rows_purged_at` records the purge).
 *
 * Every boundary is inclusive (`<=`), like the spec's expiry predicate: a
 * batch whose instant equals the cutoff is due.
 *
 * The SQL (import-retention.repository.ts) is the only place the cutoffs are
 * computed: on the database clock, one instant per pass, in UTC
 * (`(instant AT TIME ZONE 'UTC' - interval) AT TIME ZONE 'UTC'`). PostgreSQL
 * subtracts months on the calendar and clamps the day to the end of a shorter
 * month (2026-03-31 - 13 months = 2025-02-28). The integration spec pins that
 * arithmetic at fixed instants on real PostgreSQL.
 */

/** Rows of a cancelled or expired batch are kept this many days after `closed_at`. */
export const CLOSED_ROWS_RETENTION_DAYS = 30;

/** Rows of a published batch are kept this many months after `published_at`. */
export const PUBLISHED_ROWS_RETENTION_MONTHS = 13;

export type ImportBatchState =
  | "draft"
  | "validated"
  | "pending_approval"
  | "approved"
  | "published"
  | "cancelled"
  | "expired";
