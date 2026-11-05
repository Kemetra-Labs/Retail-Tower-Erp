/**
 * RT-1233 — what a failed sale-processing drain means for sale sync.
 *
 * `classifySyncFailure` takes a §8 CONDITION, never an error: "a caller maps
 * its observed failure ... to ONE of these before classifying". The drain
 * makes no outbound call, so the only failures it observes are its own
 * Postgres errors and its lost-claim `SaleProcessingNotFoundError`. This is
 * that mapping, kept deliberately conservative:
 *
 *   - SQLSTATE class 22 (data exception) or 23 (integrity constraint
 *     violation), except 23505 and 23P01: the same sale fails the same way on every
 *     retry, so it is VALIDATION_FAILURE → needs-repair (an operator repairs
 *     it from the Console).
 *   - Everything else is TRANSIENT → failed-retryable, and BullMQ backs off:
 *     connection loss, 40001 / 40P01, 57P01, 23505 (a unique race converges on
 *     retry), 23P01 (the 0016 established-unit EXCLUDE guard on
 *     `stock_movements` fires on a concurrency race; the retry then reads the
 *     established unit and skips the line), the lost-claim not-found (it is thrown precisely so a retry
 *     converges), and anything unknown.
 *
 * A sale that keeps failing transiently until BullMQ gives up stays
 * `failed-retryable`; the RT-457 re-drive sweep picks it up again. Escalating
 * that to needs-repair would need a persistence tracker and is not decided
 * here.
 */
import {
  SYNC_FAILURE_CONDITION,
  type SyncFailureCondition,
} from "./sale-sync-failure-classifier";

const DETERMINISTIC_SQLSTATE = /^2[23][0-9A-Z]{3}$/;
/** Class-23 codes a race raises; a retry converges, so they stay transient. */
const RACE_SQLSTATES: ReadonlySet<string> = new Set(["23505", "23P01"]);

/** Maps a caught sale-processing error to the §8 condition it is recorded as. */
export function syncFailureConditionOf(err: unknown): SyncFailureCondition {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && DETERMINISTIC_SQLSTATE.test(code) && !RACE_SQLSTATES.has(code)) {
    return SYNC_FAILURE_CONDITION.VALIDATION_FAILURE;
  }
  return SYNC_FAILURE_CONDITION.TRANSIENT;
}

/**
 * Thrown by `SaleProcessingProcessor` instead of the original error once the
 * sale is quarantined as needs-repair. Retrying cannot help, and a retry that
 * happened to succeed would mark the sale synced while its open needs-repair
 * row stays in the Console list, so `SaleWorker` turns this into BullMQ's
 * `UnrecoverableError`. The original error is kept as `cause`.
 */
export class SaleProcessingQuarantinedError extends Error {
  constructor(cause: unknown) {
    super("sale quarantined as needs-repair", { cause });
    this.name = "SaleProcessingQuarantinedError";
  }
}
