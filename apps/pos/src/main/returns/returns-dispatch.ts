/**
 * RT-15 S2 — send one journaled return and record what Backend-Core said.
 *
 * Shared by the submit path and the resolver, so a first send and every
 * re-send behave identically: the journaled body bytes, the same
 * `Idempotency-Key` (= `externalId`), the same outcome mapping.
 *
 *   recorded (201 / 200 / replay)  → confirmed; audit confirmed + payout_ready
 *   refused                        → refused;   audit refused
 *   unknown (timeout / network…)   → unknown;   never success (AC9/AC10)
 *
 * A confirmation must name this return (`externalId`, `saleRef`), be in its
 * currency, return only the requested lines and quantities, and carry exactly
 * the quoted refund (the cash tender the server
 * checked against its own total); otherwise the row stays `unknown` and the anomaly is logged — nothing is
 * paid out on an answer the till cannot match.
 *
 * Confirmation is written once and atomically: the guarded `markConfirmed`
 * and both its audit rows (`confirmed`, `payout_ready`) commit in ONE local
 * transaction (`audit_events` lives in the same SQLite DB), and the audits are
 * written only when the transition changed the row. A second confirmation (a
 * resolver racing a submit, a later replay) therefore writes nothing (AC8). The
 * refusal transition and its audit are atomic the same way. If that local
 * commit fails, it rolls back: the row stays `pending` / `unknown`, the result
 * is `unconfirmed` (never a rejected call once the server has answered), and
 * the resolver's same-key resend confirms it later. Sends of the same return
 * are single-flight within the process.
 *
 * RT-1498 S4 (RT-196 §3.4): the dispatch COMMIT POINT also re-reads the return's disposition. A
 * closed return is never sent, by any operation; a `needs_support` return is sent only by the
 * explicit per-row `resend`, never by a background tick, the bar pass or a first send. A snapshot
 * taken before the disposition was written therefore cannot POST. And a 2xx the till cannot match
 * (U-3) or read (U-4) raises `needs_support` by itself, in the same transaction as the unknown
 * transition: it only restricts (no automatic resend); it never frees the sale or enables a payout.
 *
 * RT-1498 close slice: the commit point also honours a `retry_hold` (a status read answered "not
 * recorded"): a background or bar send is deferred while the hold is newer than the row's last attempt,
 * so the quiet period before a close can elapse; only the explicit `resend` is not held, and the
 * attempt it records voids the hold. Every attempt is anchored for that quiet period at the stamp the
 * journal records, and `isSending` tells a close whether a send of that return is in flight.
 */
import type { ReturnUnknownCause, ReturnsRefusalReason } from '../../shared/returns/types.js';
import { exponentFor } from '../sales-sync/create-sale-sync-client.js';
import type { ConfirmVia, ReturnsAudit, SendOperation } from './returns-audit.js';
import {
  isClosedState,
  type ReturnDispositionsRepository,
} from './returns-dispositions-repository.js';
import type { AuthSnapshot, ReturnsAuthorizer } from './returns-auth.js';
import { AUTH_FAILURE_CAUSES, type AuthFailureStreak } from './returns-causes.js';
import type { RecordReturnOutcome, ReturnsClient } from './returns-client.js';
import { amount4ToMinor, parseAmount4 } from './returns-money.js';
import type { ReturnQuietPeriod } from './returns-quiet-period.js';
import type { ConfirmInput, JournalEntry, ReturnsRepository } from './returns-repository.js';
import { returnedLinesMatch } from './returns-verify.js';
import { uuidv7 } from './uuidv7.js';
import type { WireSaleReturn } from './returns-wire.js';

/** Who raised an automatic `needs_support`: a 2xx the till cannot use, or repeated auth failures. */
type AutomaticSupportSource = 'send_response' | 'auth_failure';

export type DispatchOutcome =
  | { readonly kind: 'confirmed'; readonly entry: JournalEntry; readonly replayed: boolean }
  | {
      readonly kind: 'unconfirmed';
      readonly entry: JournalEntry;
      /** RT-196 S1: why this send left the row unknown; null when nothing was sent / unknown. */
      readonly cause: ReturnUnknownCause | null;
    }
  /**
   * Not sent: the actor is no longer authorized (the row stays pending/unknown), or, with `by:
   * 'disposition'` (RT-1498), the row's disposition forbids this send. The latter says nothing about
   * the actor, so a resolver pass goes on to its next row.
   */
  | {
      readonly kind: 'deferred';
      readonly entry: JournalEntry;
      readonly by?: 'disposition';
    }
  | {
      readonly kind: 'refused';
      readonly reason: ReturnsRefusalReason;
      readonly entry: JournalEntry;
    };

/** `resend` (RT-196 S1) is the manager's explicit per-row «إعادة الإرسال». */
export type DispatchOperation = SendOperation;

export interface ReturnsDispatcher {
  /**
   * Send `entry` on behalf of the authorization `snapshot`: re-checked against
   * the live state right before the POST, which carries the snapshot's envelope.
   */
  send(
    entry: JournalEntry,
    operation: DispatchOperation,
    snapshot: AuthSnapshot,
  ): Promise<DispatchOutcome>;
}

/** RT-1498 close slice: whether a send of one return is in flight in this process. */
export interface SendActivity {
  isSending(returnId: string): boolean;
}

/** The dispatcher the domain composes: the sending port plus its activity (for a close). */
export type JournaledDispatcher = ReturnsDispatcher & SendActivity;

export interface ReturnsDispatchLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ReturnsDispatchDeps {
  readonly client: Pick<ReturnsClient, 'recordReturn'>;
  readonly repo: ReturnsRepository;
  /** RT-1498 S4: read at the commit point; written by a mismatching or unreadable 2xx. */
  readonly dispositions: Pick<
    ReturnDispositionsRepository,
    'stateOf' | 'insert' | 'hasEffectiveHold'
  >;
  /**
   * RT-1498 close slice: anchors each attempt for the quiet period (called as the attempt is recorded,
   * with the stamp the journal stores). Absent: no anchor, so a close can never show its period.
   */
  readonly quiet?: Pick<ReturnQuietPeriod, 'markAttempt'>;
  /**
   * RT-1498 (OD-196-6): whether a return's resends failed on authentication long enough to hand it to
   * support by itself. Absent: the automatic `auth_failure` flag is never raised.
   */
  readonly authFailures?: Pick<AuthFailureStreak, 'reached'>;
  /** RT-1498 S4: the id of an automatic disposition (a UUID); defaults to a fresh UUIDv7. */
  readonly newDispositionId?: () => string;
  readonly audit: ReturnsAudit;
  /** The choke point: re-authorizes the actor immediately before every send. */
  readonly authorizer: Pick<ReturnsAuthorizer, 'recheck'>;
  /**
   * True once the return domain is stopping (app shutdown). No send starts
   * after it, and a send in flight when it flips does no local reads/writes
   * when it settles (the DB may already be closed).
   */
  readonly isStopped: () => boolean;
  /** Run `fn` in one local DB transaction (journal + audit_events). */
  readonly transaction: <T>(fn: () => T) => T;
  readonly now: () => string;
  readonly logger: ReturnsDispatchLogger;
}

/** What the current journal row says, for a send that changed nothing. */
function outcomeOfState(entry: JournalEntry): DispatchOutcome {
  if (entry.state === 'confirmed' || entry.state === 'paid_out') {
    return { kind: 'confirmed', entry, replayed: false };
  }
  if (entry.state === 'refused' && entry.refusalReason !== null) {
    return { kind: 'refused', reason: entry.refusalReason, entry };
  }
  return { kind: 'unconfirmed', entry, cause: null };
}

/** The answer names this return: its externalId, sale, currency and lines. */
function isThisReturn(entry: JournalEntry, saleReturn: WireSaleReturn): boolean {
  if (saleReturn.externalId !== entry.externalId) return false;
  if (saleReturn.saleRef.toLowerCase() !== entry.serverSaleRef.toLowerCase()) return false;
  if (saleReturn.currencyCode !== entry.currencyCode) return false;
  return returnedLinesMatch(entry.lines, saleReturn.lines);
}

/**
 * The server's refund in minor units when it matches this return; else null. Exported (RT-1498 close
 * slice) so a status read judges "the server's return is this one" with the SAME matcher, never a second.
 */
export function matchingTotalMinor(entry: JournalEntry, saleReturn: WireSaleReturn): number | null {
  if (!isThisReturn(entry, saleReturn)) return null;
  const total4 = parseAmount4(saleReturn.returnTotal);
  const minor = total4 === null ? null : amount4ToMinor(total4, exponentFor(entry.currencyCode));
  return minor === entry.quotedTotalMinor ? minor : null;
}

/**
 * INSIDE the caller's transaction: the guarded `markConfirmed`, then its two audits (`confirmed`,
 * `payout_ready`), written only when the transition changed the row. One writer for every
 * confirmation: a send's answer (`via: 'send'`) and, RT-1498 confirm-by-read, a status read that
 * matched this return (`via: 'status_read'`), so a read never confirms differently from a send.
 */
export function commitConfirmation(
  deps: {
    readonly repo: Pick<ReturnsRepository, 'markConfirmed' | 'read'>;
    readonly audit: Pick<ReturnsAudit, 'confirmed' | 'payoutReady'>;
  },
  input: ConfirmInput,
  replayed: boolean,
  via: ConfirmVia,
): boolean {
  if (!deps.repo.markConfirmed(input)) return false;
  const confirmed = deps.repo.read(input.returnId);
  if (confirmed === null) throw new Error('returns-dispatch: confirmed row vanished');
  deps.audit.confirmed(confirmed, replayed, via);
  deps.audit.payoutReady(confirmed);
  return true;
}

interface SendRequest {
  readonly entry: JournalEntry;
  readonly op: DispatchOperation;
  readonly snapshot: AuthSnapshot;
}

class JournaledReturnsDispatcher implements JournaledDispatcher {
  private readonly inFlight = new Map<string, Promise<DispatchOutcome>>();

  constructor(private readonly deps: ReturnsDispatchDeps) {}

  isSending(returnId: string): boolean {
    return this.inFlight.has(returnId);
  }

  send(
    entry: JournalEntry,
    operation: DispatchOperation,
    snapshot: AuthSnapshot,
  ): Promise<DispatchOutcome> {
    const running = this.inFlight.get(entry.returnId);
    if (running !== undefined) return running;
    const promise = this.sendOnce({ entry, op: operation, snapshot }).finally(() => {
      this.inFlight.delete(entry.returnId);
    });
    this.inFlight.set(entry.returnId, promise);
    return promise;
  }

  private async sendOnce(send: SendRequest): Promise<DispatchOutcome> {
    const { entry, op } = send;
    if (this.deps.isStopped()) return { kind: 'deferred', entry };
    const current = this.current(entry);
    // Commit point (a): the return's disposition, read right here, with no await before the
    // authorization recheck below. A closed return is never sent; a needs_support one only by
    // the explicit resend.
    if (this.heldByDisposition(current, op)) {
      return { kind: 'deferred', entry: current, by: 'disposition' };
    }
    // Commit point (b): never send for a snapshot whose actor is no longer
    // authorized or whose envelope is no longer live.
    if (this.deps.authorizer.recheck(send.snapshot) !== null) {
      this.deps.logger.warn({ return_id: entry.returnId }, 'returns:send_deferred_unauthorized');
      return { kind: 'deferred', entry: current };
    }
    const attempted = current.attemptCount > 0;
    const attemptAt = this.deps.now();
    this.deps.repo.recordAttempt({ returnId: entry.returnId, now: attemptAt });
    this.deps.quiet?.markAttempt(entry.returnId, attemptAt);
    // A5: the POST carries the rechecked snapshot's own envelope — no live
    // session or token read happens between the recheck and the wire.
    const outcome = await this.deps.client.recordReturn(
      {
        saleRef: entry.serverSaleRef,
        bodyJson: entry.requestBodyJson,
        idempotencyKey: entry.externalId,
        // P1: a send that may follow an earlier one never turns a pre-replay
        // 401/403/404 into a terminal refusal (the return may be recorded).
        // `recordAttempt` is committed before every POST, so a pre-increment
        // count of 0 proves no earlier send reached the server: a first send.
        resend: attempted,
      },
      send.snapshot.envelope,
    );
    // Stopped while the POST was in flight: touch nothing local (the DB may be
    // closed). The row stays pending/unknown; the next start re-sends it.
    if (this.deps.isStopped()) return { kind: 'deferred', entry };
    try {
      return this.apply(entry, outcome, op);
    } catch {
      this.deps.logger.warn({ return_id: entry.returnId }, 'returns:local_commit_failed');
      return this.pendingLocally(entry, op);
    }
  }

  /**
   * RT-1498 S4: does the return's disposition forbid this operation's send? A closed return is never
   * sent; a needs_support one, or one held by a `retry_hold` newer than its last attempt (the close
   * slice), only by the explicit per-row resend.
   */
  private heldByDisposition(entry: JournalEntry, op: DispatchOperation): boolean {
    const state = this.deps.dispositions.stateOf(entry.returnId);
    if (isClosedState(state)) return true;
    if (op === 'resend') return false;
    return (
      state === 'needs_support' ||
      this.deps.dispositions.hasEffectiveHold(entry.returnId, entry.lastAttemptAt)
    );
  }

  /** The server answered but the local commit failed: report unknown, never reject. */
  private pendingLocally(entry: JournalEntry, op: DispatchOperation): DispatchOutcome {
    try {
      return this.unconfirmed(entry, 'local_commit_failed', op);
    } catch {
      return {
        kind: 'unconfirmed',
        entry: { ...entry, state: 'unknown' },
        cause: 'local_commit_failed',
      };
    }
  }

  private apply(entry: JournalEntry, outcome: RecordReturnOutcome, op: DispatchOperation) {
    if (outcome.kind === 'recorded') {
      return this.confirm(entry, outcome.saleReturn, outcome.replayed, op);
    }
    if (outcome.kind === 'refused') return this.refuse(entry, outcome.reason, op);
    return this.unconfirmed(entry, outcome.cause, op);
  }

  private current(entry: JournalEntry): JournalEntry {
    return this.deps.repo.read(entry.returnId) ?? entry;
  }

  /**
   * The send left the row unknown: the guarded `markUnknown` and the cause audit
   * commit together, and the audit is written only when the transition changed
   * the row (RT-196 S1). If that local commit fails the row is still marked
   * `unknown` on its own — never left `pending`, which the resolver treats as
   * always due (no backoff) — and the lost cause audit is logged.
   */
  private unconfirmed(
    entry: JournalEntry,
    cause: ReturnUnknownCause,
    op: DispatchOperation,
  ): DispatchOutcome {
    const stamp = { returnId: entry.returnId, now: this.deps.now() };
    try {
      this.deps.transaction(() => {
        this.commitUnknown(entry, stamp, cause, op);
      });
    } catch {
      this.deps.logger.warn({ return_id: entry.returnId }, 'returns:attempt_unknown_audit_failed');
      this.deps.repo.markUnknown(stamp);
    }
    const outcome = outcomeOfState(this.current(entry));
    return outcome.kind === 'unconfirmed' ? { ...outcome, cause } : outcome;
  }

  /** Inside the transaction: the guarded transition, then its cause audit. */
  private commitUnknown(
    entry: JournalEntry,
    stamp: { readonly returnId: string; readonly now: string },
    cause: ReturnUnknownCause,
    op: DispatchOperation,
  ): void {
    if (!this.deps.repo.markUnknown(stamp)) return;
    this.deps.audit.attemptUnknown(this.current(entry), cause, op);
    if (cause === 'confirmation_mismatch' || cause === 'unreadable_body') {
      this.raiseSupport(this.current(entry), stamp.now, 'send_response');
    } else if (AUTH_FAILURE_CAUSES.has(cause) && this.authFailureStreakReached(entry.returnId)) {
      // Read AFTER this attempt's cause audit, in the same transaction: it counts this failure.
      this.raiseSupport(this.current(entry), stamp.now, 'auth_failure');
    }
  }

  /**
   * Whether the auth-failure run reached the flag. A failing read is logged and counts as "not yet":
   * it must never roll back this attempt's cause audit (the next failure checks again).
   */
  private authFailureStreakReached(returnId: string): boolean {
    try {
      return this.deps.authFailures?.reached(returnId) === true;
    } catch {
      this.deps.logger.warn({ return_id: returnId }, 'returns:auth_failure_check_failed');
      return false;
    }
  }

  /**
   * RT-1498 S4 (U-3 / U-4): the server answered 2xx with something the till cannot match or read.
   * Resending the same bytes returns the same answer, so the row is handed to support once: an
   * automatic needs_support (no approval, no actor), in the caller's transaction. A return that
   * already has a disposition gets no second one. It only restricts; it frees nothing.
   *
   * RT-1498 (RT-196 §3.6, OD-196-6): the same automatic raise, with `auth_failure` as source and
   * reason, once the return's resends answered a pre-replay 401/403 on 3 consecutive attempts spanning
   * the quiet period (`AuthFailureStreak`): this till cannot read or resolve it, so support must.
   */
  private raiseSupport(entry: JournalEntry, now: string, source: AutomaticSupportSource): void {
    if (this.deps.dispositions.stateOf(entry.returnId) !== null) return;
    const reason = source === 'auth_failure' ? 'auth_failure' : 'mismatch';
    this.deps.dispositions.insert({
      dispositionId: (this.deps.newDispositionId ?? uuidv7)(),
      returnId: entry.returnId,
      kind: 'needs_support',
      verdictSource: source,
      reason,
      readVerdictAt: null,
      approvalId: null,
      actorOperatorId: null,
      createdAt: now,
    });
    this.deps.audit.needsSupport(
      {
        scope: entry.scope,
        operatorId: entry.operatorId,
        operatorSessionId: entry.operatorSessionId,
      },
      {
        return_id: entry.returnId,
        approval_id: null,
        verdict_source: source,
        reason,
      },
    );
  }

  private confirm(
    entry: JournalEntry,
    saleReturn: WireSaleReturn,
    replayed: boolean,
    op: DispatchOperation,
  ) {
    const totalMinor = matchingTotalMinor(entry, saleReturn);
    if (totalMinor === null) {
      this.deps.logger.warn({ return_id: entry.returnId }, 'returns:confirmation_mismatch');
      return this.unconfirmed(entry, 'confirmation_mismatch', op);
    }
    const input = {
      returnId: entry.returnId,
      returnRef: saleReturn.returnRef,
      returnTotalMinor: totalMinor,
      now: this.deps.now(),
    };
    const changed = this.deps.transaction(() => this.commitConfirmation(input, replayed));
    const fresh = this.current(entry);
    return changed
      ? ({ kind: 'confirmed', entry: fresh, replayed } as const)
      : outcomeOfState(fresh);
  }

  /** Inside the transaction: the guarded transition, then its two audits. */
  private commitConfirmation(input: ConfirmInput, replayed: boolean): boolean {
    return commitConfirmation(this.deps, input, replayed, 'send');
  }

  private refuse(entry: JournalEntry, reason: ReturnsRefusalReason, op: DispatchOperation) {
    const changed = this.deps.transaction(() => this.commitRefusal(entry, reason, op));
    const fresh = this.current(entry);
    return changed ? ({ kind: 'refused', reason, entry: fresh } as const) : outcomeOfState(fresh);
  }

  /** Inside the transaction: the guarded refusal, then its audit. */
  private commitRefusal(entry: JournalEntry, reason: ReturnsRefusalReason, op: DispatchOperation) {
    const now = this.deps.now();
    if (!this.deps.repo.markRefused({ returnId: entry.returnId, reason, now })) return false;
    const { scope, operatorId, operatorSessionId } = entry;
    this.deps.audit.refused(
      { scope, operatorId, operatorSessionId },
      {
        return_id: entry.returnId,
        sale_id: entry.saleId,
        sale_ref: entry.serverSaleRef,
        operation: op,
        reason,
      },
    );
    return true;
  }
}

export function createReturnsDispatcher(deps: ReturnsDispatchDeps): JournaledDispatcher {
  return new JournaledReturnsDispatcher(deps);
}
