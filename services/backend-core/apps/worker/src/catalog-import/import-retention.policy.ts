/**
 * RT-1503 (spec 049 S2) — pure policy of the catalogue import expiry and
 * retention job. No NestJS, BullMQ or database imports.
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
 * The SQL (import-retention.repository.ts) applies the same windows on the
 * database clock in UTC: `(clock AT TIME ZONE 'UTC' - interval) AT TIME ZONE
 * 'UTC'`. PostgreSQL subtracts months on the calendar and clamps the day to
 * the end of a shorter month (2026-03-31 - 13 months = 2025-02-28);
 * `subtractUtcMonths` does the same, so the unit tests here describe what the
 * SQL does. The integration spec checks the SQL at the edges.
 */

/** Rows of a cancelled or expired batch are kept this many days after `closed_at`. */
export const CLOSED_ROWS_RETENTION_DAYS = 30;

/** Rows of a published batch are kept this many months after `published_at`. */
export const PUBLISHED_ROWS_RETENTION_MONTHS = 13;

/** The open states that expire (the reserved approval states never do). */
export const EXPIRABLE_STATES = Object.freeze(["draft", "validated"] as const);

/** The closed states whose rows age on `closed_at`. */
const CLOSED_PURGEABLE_STATES = Object.freeze(["cancelled", "expired"] as const);

export type ImportBatchState =
  | "draft"
  | "validated"
  | "pending_approval"
  | "approved"
  | "published"
  | "cancelled"
  | "expired";

export interface ImportRetentionCutoffs {
  /** A cancelled or expired batch with `closed_at <=` this is due for the row purge. */
  readonly closedCutoff: Date;
  /** A published batch with `published_at <=` this is due for the row purge. */
  readonly publishedCutoff: Date;
}

export interface BatchExpiryFacts {
  readonly state: ImportBatchState;
  readonly expiresAt: Date | null;
}

export interface BatchRetentionFacts {
  readonly state: ImportBatchState;
  readonly closedAt: Date | null;
  readonly publishedAt: Date | null;
  readonly rowsPurgedAt: Date | null;
}

function assertWholeNonNegative(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a whole, non-negative number`);
  }
}

/** `now` minus `days` whole UTC days. */
export function subtractUtcDays(now: Date, days: number): Date {
  assertWholeNonNegative(days, "days");
  const out = new Date(now.getTime());
  out.setUTCDate(out.getUTCDate() - days);
  return out;
}

/** `now` minus `months` calendar months in UTC, the day clamped to the target month's last day. */
export function subtractUtcMonths(now: Date, months: number): Date {
  assertWholeNonNegative(months, "months");
  const totalMonths = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Date(now.getTime());
  out.setUTCFullYear(year, month, Math.min(now.getUTCDate(), lastDay));
  return out;
}

export function computeImportRetentionCutoffs(now: Date): ImportRetentionCutoffs {
  return {
    closedCutoff: subtractUtcDays(now, CLOSED_ROWS_RETENTION_DAYS),
    publishedCutoff: subtractUtcMonths(now, PUBLISHED_ROWS_RETENTION_MONTHS),
  };
}

/** True when an open draft / validated batch has reached its `expires_at`. */
export function isExpiryDue(batch: BatchExpiryFacts, now: Date): boolean {
  if (!(EXPIRABLE_STATES as readonly string[]).includes(batch.state)) return false;
  return batch.expiresAt !== null && batch.expiresAt.getTime() <= now.getTime();
}

/** True when a closed batch's rows are past their window and not yet purged. */
export function isRowsPurgeDue(batch: BatchRetentionFacts, cutoffs: ImportRetentionCutoffs): boolean {
  if (batch.rowsPurgedAt !== null) return false;
  if (batch.state === "published") {
    return batch.publishedAt !== null && batch.publishedAt.getTime() <= cutoffs.publishedCutoff.getTime();
  }
  if ((CLOSED_PURGEABLE_STATES as readonly string[]).includes(batch.state)) {
    return batch.closedAt !== null && batch.closedAt.getTime() <= cutoffs.closedCutoff.getTime();
  }
  return false;
}
