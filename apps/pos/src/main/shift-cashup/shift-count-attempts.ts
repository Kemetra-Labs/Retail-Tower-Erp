/**
 * RT-997 — the shift Count Attempt, an append-only local fact (migration 0059,
 * [GATED]: owner approval before merge).
 *
 * The baseline (Shift & Cash, 1592–1625): each submitted count is a durable
 * attempt, and a recount is another attempt that never erases the prior one.
 * V1 (RT-17) kept only the count the close was made from. This records every
 * count the till evaluated for an open shift, before the close:
 *
 *   • `accepted` — the count the close rests on. It is written in the close's
 *     own transaction, just before the close row, and the close's link row
 *     (`shift_close_count_attempts`) names it; if the close rolls back, so does
 *     the attempt.
 *   • `refused` — the till evaluated the count (it was plausible, the shift was
 *     open, the cash-up was computed) and the close was refused: the variance
 *     needs a manager, the manager's PIN failed, the drawer moved after the
 *     approval. Written by `recordRefusedCount` after the refusal.
 *   • `abandoned` — allowed by the schema; nothing writes it yet (the cashier's
 *     walk-away is a renderer event with no channel, see the RT-997 report).
 *
 * A fact holds who counted, how much, the outcome and when, and nothing the
 * cashier could not already see: no expected cash, no variance. It stays on the
 * terminal (not in the shift sync outbox): sending it to Backend-Core needs an
 * approved contract first. Ids and amounts only; no PIN, no PII.
 */
import { isoInstant } from './shift-wire.js';

export type ShiftCountOutcome = 'accepted' | 'refused' | 'abandoned';

/** A Count Attempt as it is stored. */
export interface CountAttemptFact {
  attemptId: string;
  shiftId: string;
  /** The `users.id` of whoever counted (the cashier; a manager on a forced close). */
  actorUserId: string;
  countedCashMinor: number;
  outcome: ShiftCountOutcome;
  /** ISO-8601 UTC: the instant the till evaluated the count. */
  attemptedAt: string;
}

/**
 * What a close carries to be recorded on an accepted attempt: the count and the
 * shift come from the close itself.
 */
export type CountAttemptStamp = Pick<CountAttemptFact, 'attemptId' | 'actorUserId' | 'attemptedAt'>;

/** The repository's statement runner: SQL and parameters, rows changed. */
export type RunSql = (sql: string, ...params: unknown[]) => number;

const INSERT_ATTEMPT_SQL = `
  INSERT INTO shift_count_attempts (attempt_id, shift_id, actor_user_id, counted_cash_minor,
    outcome, attempted_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

const INSERT_LINK_SQL = `
  INSERT INTO shift_close_count_attempts (shift_id, attempt_id, created_at)
  VALUES (?, ?, ?)`;

/** Appends one attempt; the 0059 triggers refuse one on a closed shift. */
export function insertCountAttempt(run: RunSql, fact: CountAttemptFact, now: string): void {
  run(
    INSERT_ATTEMPT_SQL,
    fact.attemptId,
    fact.shiftId,
    fact.actorUserId.toLowerCase(),
    fact.countedCashMinor,
    fact.outcome,
    isoInstant({ field: 'attemptedAt', value: fact.attemptedAt }),
    now,
  );
}

/** Appends the close's link to the accepted attempt it rests on (after the close row). */
export function insertCloseCountLink(
  run: RunSql,
  link: { shiftId: string; attemptId: string },
  now: string,
): void {
  run(INSERT_LINK_SQL, link.shiftId, link.attemptId, now);
}
