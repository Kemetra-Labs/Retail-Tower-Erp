/**
 * RT-1498 close slice — read the server's verdict on ONE unresolved return, and close it as "not recorded".
 *
 * `readStatus` asks Backend-Core (`readReturnStatusByProvenance`, RT-1548) whether it recorded this
 * return, by its journaled provenance. The answer is the SERVER's; nothing is inferred locally:
 *   • `not_recorded`: a restrict-only `retry_hold` is written, so the background and bar resends stop and
 *     the quiet period can run out; it never frees the sale;
 *   • `recorded` that is this return writes nothing (the explicit resend confirms it through the
 *     dispatcher's own matcher); one that is NOT this return, or is a credit reversal, hands the return
 *     to support (`needs_support` from the read: no approval, Gap 2); a return that was already CLOSED
 *     and is now recorded is a late commit: audited, surfaced, never paid, and (RT-1553, migration 0071)
 *     handed to support by the one `needs_support` 0071 allows after a close, which blocks the sale again;
 *   • a 404 is "unavailable" (never a verdict), anything else that is not a verdict is "no verdict".
 *
 * `close` writes the terminal `not_recorded_closed` disposition, which frees the sale. It needs, in order:
 *   • a manager or admin session (the admission gate), a return of this terminal that was SENT and is not
 *     in flight (`never_sent`, `send_in_flight`) and is not already closed;
 *   • 15 minutes of ELAPSED time since the last send (`reconcile_too_soon`; a POS that cannot show it,
 *     after a restart or a stepped clock, counts it as not elapsed: `quiet_period_unproven`);
 *   • a FRESH affirmative `not_recorded` at close time: a `recorded` answer never closes, a 404 or no
 *     verdict refuses;
 *   • one single-use approval of kind `return.resolve_unknown` bound to this return AND to `close`,
 *     granted by another manager (four-eyes): spent in the SAME transaction as the disposition and its
 *     audit, so any refusal rolls the spend back.
 * A close is allowed from `needs_support` (spec §3.4). It sends nothing and never confirms or refuses.
 *
 * RT-1553: `checkClosed` is the same status read of ONE closed return without an operator request (the
 * automatic late-commit detection of `returns-late-commit.ts`): no admission refusal, no audit when the
 * read gives no verdict, and the same single-flight per return as a manual read.
 */
import type {
  ReturnJournalView,
  ReturnStatusCause,
  ReturnCloseReadiness,
  ReturnsCloseRequest,
  ReturnsCloseResponse,
  ReturnsReadStatusRequest,
  ReturnsReadStatusResponse,
  ReturnsRefusalReason,
} from '../../shared/returns/types.js';
import {
  auditRefusal,
  type RefusalIds,
  type ReturnActor,
  type ReturnsAudit,
} from './returns-audit.js';
import {
  SHUTTING_DOWN,
  latchedRecheck,
  type AuthSnapshot,
  type ReturnsAuthorizer,
} from './returns-auth.js';
import type { SendActivity } from './returns-dispatch.js';
import { matchingTotalMinor } from './returns-dispatch.js';
import {
  isClosedState,
  type ReturnDispositionsRepository,
} from './returns-dispositions-repository.js';
import { RETURN_SOURCE_SYSTEM } from './returns-quote.js';
import type { QuietPeriodCheck, ReturnQuietPeriod } from './returns-quiet-period.js';
import {
  isDisposable,
  spendResolveApproval,
  type ResolveApprovalSpender,
} from './returns-resolve-approval.js';
import type { JournalEntry, ReturnsRepository } from './returns-repository.js';
import { isOwnScope } from './returns-service.js';
import type { StatusReadAvailability } from './returns-status-availability.js';
import type { ReturnsStatusClient, StatusReadOutcome } from './returns-status-client.js';
import { isUuid } from './returns-wire.js';

export interface ReturnsCloseAPI {
  readStatus(req: ReturnsReadStatusRequest): Promise<ReturnsReadStatusResponse>;
  close(req: ReturnsCloseRequest): Promise<ReturnsCloseResponse>;
}

/**
 * RT-1553: what one automatic status read of a closed return found. `late_commit`: the server has it
 * (the sale is blocked again); `clear`: a verdict that it does not; `no_verdict`: offline, unavailable
 * or unreadable (try again later); `skipped`: not read (the return is no longer closed-and-free, a read
 * or send of it is running, or the actor or domain stopped).
 */
export type ClosedCheck = 'late_commit' | 'clear' | 'no_verdict' | 'skipped';

export interface ClosedReturnChecker {
  checkClosed(actor: AuthSnapshot, entry: JournalEntry): Promise<ClosedCheck>;
}

export interface ReturnsCloseServiceDeps {
  /** The single authorization choke point (admission + every re-check). */
  readonly authorizer: ReturnsAuthorizer;
  /** RT-198: true once the return domain is stopping (app shutdown). */
  readonly isStopped: () => boolean;
  readonly repo: Pick<ReturnsRepository, 'read'>;
  readonly dispositions: Pick<
    ReturnDispositionsRepository,
    'stateOf' | 'insert' | 'hasEffectiveHold'
  >;
  readonly status: ReturnsStatusClient;
  /** Notes what each read answered: a 404 makes a close unavailable. */
  readonly availability: Pick<StatusReadAvailability, 'note'>;
  readonly quiet: Pick<ReturnQuietPeriod, 'check'>;
  /** Whether a send of a return is in flight (a read or a close is refused meanwhile). */
  readonly sends: SendActivity;
  readonly audit: ReturnsAudit;
  /** Renderer views of journal rows (with their dispositions). */
  readonly views: (entries: readonly JournalEntry[]) => ReturnJournalView[];
  /** Run `fn` in one local DB transaction (approval, disposition, audit). */
  readonly transaction: <T>(fn: () => T) => T;
  readonly now: () => string;
  /** The id of a new disposition (a UUID). */
  readonly newDispositionId: () => string;
  /** What `close` spends. Absent: a close refuses with `approval_invalid` (fail closed). */
  readonly escalation?: ResolveApprovalSpender;
}

type Operation = 'read_status' | 'close';
type Purpose = 'read' | 'close';

interface Refused {
  readonly kind: 'refused';
  readonly reason: ReturnsRefusalReason;
  readonly ret: ReturnJournalView | null;
}

/** What a read of the server found, for the return as it stands NOW (after the await). */
interface Fresh {
  readonly kind: 'read';
  readonly actor: AuthSnapshot;
  readonly entry: JournalEntry;
  readonly outcome: StatusReadOutcome;
  /** When the server's answer arrived (the terminal clock). */
  readonly at: string;
}

type Verdict =
  | { readonly kind: 'not_recorded' }
  | {
      readonly kind: 'recorded';
      readonly match: boolean;
      readonly creditLinked: boolean;
      readonly returnRef: string;
    }
  | { readonly kind: 'inconclusive'; readonly cause: ReturnStatusCause };

/** The server's answer as a verdict on THIS return: a match uses the dispatcher's own matcher. */
function verdictOf(entry: JournalEntry, outcome: StatusReadOutcome): Verdict {
  switch (outcome.kind) {
    case 'not_recorded':
      return { kind: 'not_recorded' };
    case 'recorded':
      return {
        kind: 'recorded',
        match: !outcome.creditLinked && matchingTotalMinor(entry, outcome.saleReturn) !== null,
        creditLinked: outcome.creditLinked,
        returnRef: outcome.saleReturn.returnRef,
      };
    case 'unavailable':
      return { kind: 'inconclusive', cause: 'unavailable' };
    case 'no_verdict':
      return { kind: 'inconclusive', cause: outcome.cause };
  }
}

/** Why a close cannot rest on a read that gave no verdict. */
function refusalForCause(cause: ReturnStatusCause): ReturnsRefusalReason {
  if (cause === 'unavailable') return 'returns_unavailable';
  return cause === 'unauthorized' ? 'read_unauthorized' : 'offline';
}

function readinessOf(check: QuietPeriodCheck): ReturnCloseReadiness {
  if (check.kind === 'elapsed') return { ready: true };
  if (check.kind === 'too_soon')
    return { ready: false, reason: 'too_soon', notBefore: check.notBefore };
  return { ready: false, reason: 'unproven' };
}

/** A refusal decided inside the close transaction: it rolls the approval's spend back. */
class CloseRefusal extends Error {
  constructor(readonly reason: ReturnsRefusalReason) {
    super(reason);
  }
}

const idsOf = (entry: JournalEntry): RefusalIds => ({
  returnId: entry.returnId,
  saleId: entry.saleId,
  saleRef: entry.serverSaleRef,
});

class ReturnsCloseService implements ReturnsCloseAPI {
  /** Returns with a read or a close running in this process (single-flight per return). */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: ReturnsCloseServiceDeps) {}

  // ── the shared plumbing ────────────────────────────────────────────────────────────────────────

  private refuse(
    actor: ReturnActor,
    op: Operation,
    reason: ReturnsRefusalReason,
    ids: RefusalIds = {},
    shown: JournalEntry | null = null,
  ): Refused {
    // Shutdown is not an operator refusal: never audited, and the DB may be closed.
    if (reason === 'shutting_down') return { ...SHUTTING_DOWN, ret: null };
    auditRefusal(this.deps.audit, actor, op, reason, ids);
    return { kind: 'refused', reason, ret: shown === null ? null : this.view(shown.returnId) };
  }

  private view(returnId: string): ReturnJournalView | null {
    const entry = this.deps.repo.read(returnId);
    return entry === null ? null : (this.deps.views([entry])[0] ?? null);
  }

  /** The admission gate (flag, session, manager/admin, unlocked), as every `returns.*` call has it. */
  private admit(op: Operation): { readonly actor: AuthSnapshot } | Refused {
    if (this.deps.isStopped()) return { ...SHUTTING_DOWN, ret: null };
    const live = this.deps.authorizer.current();
    if (live.kind === 'ok') return { actor: live.actor };
    if (live.actor === null) return { kind: 'refused', reason: live.reason, ret: null };
    return this.refuse(live.actor, op, live.reason);
  }

  /**
   * The journaled return a request names, when it is this terminal's, was sent, is unresolved and no
   * action on it is running. A CLOSED return still passes (a status read of it is the late-commit check).
   */
  private target(
    actor: AuthSnapshot,
    op: Operation,
    returnId: string,
  ): { readonly entry: JournalEntry } | Refused {
    if (!isUuid(returnId)) return this.refuse(actor, op, 'invalid_input');
    const entry = this.deps.repo.read(returnId);
    if (entry === null || !isOwnScope(entry, actor)) {
      return this.refuse(actor, op, 'return_not_found', { returnId });
    }
    if (!isDisposable(entry)) {
      const never = entry.state === 'pending' && entry.attemptCount === 0;
      return this.refuse(actor, op, never ? 'never_sent' : 'already_resolved', idsOf(entry), entry);
    }
    if (this.busy.has(entry.returnId) || this.deps.sends.isSending(entry.returnId)) {
      return this.refuse(actor, op, 'send_in_flight', idsOf(entry), entry);
    }
    return { entry };
  }

  /**
   * Ask the server, single-flight per return, then judge the answer against the return AS IT STANDS
   * after the await: still this terminal's authorized actor, still unresolved, and no send ran meanwhile
   * (a newer attempt would put the answer before the return's last send).
   */
  private async readFresh(
    actor: AuthSnapshot,
    op: Operation,
    entry: JournalEntry,
  ): Promise<Fresh | Refused> {
    this.busy.add(entry.returnId);
    let outcome: StatusReadOutcome;
    try {
      outcome = await this.deps.status.readStatus(
        {
          saleRef: entry.serverSaleRef,
          sourceSystem: RETURN_SOURCE_SYSTEM,
          externalId: entry.externalId,
        },
        actor.envelope,
      );
    } finally {
      this.busy.delete(entry.returnId);
    }
    const lost = latchedRecheck(this.deps, actor);
    if (lost !== null) return this.refuse(actor, op, lost, idsOf(entry));
    this.deps.availability.note(outcome);
    const at = this.deps.now();
    const now = this.deps.repo.read(entry.returnId);
    if (now === null) return this.refuse(actor, op, 'return_not_found', idsOf(entry));
    if (!isDisposable(now)) return this.refuse(actor, op, 'already_resolved', idsOf(now), now);
    if (now.lastAttemptAt !== entry.lastAttemptAt || now.attemptCount !== entry.attemptCount) {
      return this.refuse(actor, op, 'send_in_flight', idsOf(now), now);
    }
    return { kind: 'read', actor, entry: now, outcome, at };
  }

  // ── what each verdict does ─────────────────────────────────────────────────────────────────────

  /** No verdict: the audit says why, and nothing else is written. */
  private auditInconclusive(fresh: Fresh, cause: ReturnStatusCause, purpose: Purpose): void {
    this.deps.audit.statusRead(fresh.actor, {
      return_id: fresh.entry.returnId,
      verdict: 'inconclusive',
      cause,
      purpose,
    });
  }

  /** `not_recorded`: a restrict-only hold (once), then the audit; and whether a close is ready. */
  private holdAndAudit(fresh: Fresh, purpose: Purpose): void {
    const { actor, entry, at } = fresh;
    this.deps.transaction(() => {
      const closed = isClosedState(this.deps.dispositions.stateOf(entry.returnId));
      if (
        !closed &&
        !this.deps.dispositions.hasEffectiveHold(entry.returnId, entry.lastAttemptAt)
      ) {
        this.deps.dispositions.insert({
          dispositionId: this.deps.newDispositionId(),
          returnId: entry.returnId,
          kind: 'retry_hold',
          verdictSource: 'provenance_read',
          reason: 'not_recorded',
          readVerdictAt: at,
          approvalId: null,
          actorOperatorId: actor.operatorId,
          createdAt: at,
        });
      }
      this.deps.audit.statusRead(actor, {
        return_id: entry.returnId,
        verdict: 'not_recorded',
        purpose,
      });
    });
  }

  /**
   * `recorded`, in one transaction. A return already CLOSED is a late commit: audited, and (RT-1553,
   * migration 0071) handed to support once, whatever the answer matched, which blocks the sale again;
   * the closed row stays frozen, so it is never confirmed and never paid. This return, matched, writes
   * nothing. Anything else (another return, a credit reversal) hands it to support from the read (no
   * approval, Gap 2), once.
   */
  private recordedEffect(
    fresh: Fresh,
    verdict: Extract<Verdict, { kind: 'recorded' }>,
    purpose: Purpose,
  ): 'resend' | 'support' | 'late_commit' {
    const { actor, entry } = fresh;
    return this.deps.transaction(() => {
      const earlier = this.deps.dispositions.stateOf(entry.returnId);
      let effect: 'resend' | 'support' | 'late_commit' = 'resend';
      if (isClosedState(earlier)) {
        effect = 'late_commit';
        this.deps.audit.lateCommit(actor, {
          return_id: entry.returnId,
          return_ref: verdict.returnRef,
          credit_linked: verdict.creditLinked,
        });
        // RT-1553: the one support raise 0071 allows after a close (not again once it is raised).
        if (earlier === 'closed') this.raiseSupport(fresh);
      } else if (!verdict.match) {
        effect = 'support';
        if (earlier === null) this.raiseSupport(fresh);
      }
      this.deps.audit.statusRead(actor, {
        return_id: entry.returnId,
        verdict: verdict.match ? 'recorded_match' : 'recorded_mismatch',
        purpose,
      });
      return effect;
    });
  }

  /** Inside the transaction: `needs_support` from a read that proved a mismatch (no approval). */
  private raiseSupport(fresh: Fresh): void {
    const { actor, entry, at } = fresh;
    this.deps.dispositions.insert({
      dispositionId: this.deps.newDispositionId(),
      returnId: entry.returnId,
      kind: 'needs_support',
      verdictSource: 'provenance_read',
      reason: 'mismatch',
      readVerdictAt: at,
      approvalId: null,
      actorOperatorId: actor.operatorId,
      createdAt: at,
    });
    this.deps.audit.needsSupport(actor, {
      return_id: entry.returnId,
      approval_id: null,
      verdict_source: 'provenance_read',
      reason: 'mismatch',
      origin_user_unknown: true,
    });
  }

  // ── readStatus ─────────────────────────────────────────────────────────────────────────────────

  async readStatus(req: ReturnsReadStatusRequest): Promise<ReturnsReadStatusResponse> {
    const admitted = this.admit('read_status');
    if (!('actor' in admitted)) return admitted;
    const { actor } = admitted;
    const target = this.target(actor, 'read_status', req.returnId);
    if (!('entry' in target)) return target;
    const fresh = await this.readFresh(actor, 'read_status', target.entry);
    if (fresh.kind === 'refused') return fresh;
    return this.readAnswer(fresh, verdictOf(fresh.entry, fresh.outcome));
  }

  private readAnswer(fresh: Fresh, verdict: Verdict): ReturnsReadStatusResponse {
    if (verdict.kind === 'inconclusive') {
      this.auditInconclusive(fresh, verdict.cause, 'read');
      return { kind: 'inconclusive', ret: this.view(fresh.entry.returnId), cause: verdict.cause };
    }
    if (verdict.kind === 'recorded') {
      const outcome = this.recordedEffect(fresh, verdict, 'read');
      return { kind: 'recorded', ret: this.view(fresh.entry.returnId), outcome };
    }
    this.holdAndAudit(fresh, 'read');
    const closed = isClosedState(this.deps.dispositions.stateOf(fresh.entry.returnId));
    const close: ReturnCloseReadiness = closed
      ? { ready: false, reason: 'closed' }
      : readinessOf(this.deps.quiet.check(fresh.entry));
    return { kind: 'not_recorded', ret: this.view(fresh.entry.returnId), close };
  }

  // ── checkClosed (RT-1553: the automatic late-commit read) ───────────────────────────────────────

  async checkClosed(actor: AuthSnapshot, entry: JournalEntry): Promise<ClosedCheck> {
    if (!this.checkable(entry.returnId)) return 'skipped';
    this.busy.add(entry.returnId);
    let outcome: StatusReadOutcome;
    try {
      outcome = await this.deps.status.readStatus(
        {
          saleRef: entry.serverSaleRef,
          sourceSystem: RETURN_SOURCE_SYSTEM,
          externalId: entry.externalId,
        },
        actor.envelope,
      );
    } finally {
      this.busy.delete(entry.returnId);
    }
    // The stop latch and the actor's re-check first (the DB may be closed once stopped).
    if (latchedRecheck(this.deps, actor) !== null) return 'skipped';
    this.deps.availability.note(outcome);
    const now = this.deps.repo.read(entry.returnId);
    if (now === null || !isDisposable(now)) return 'skipped';
    const verdict = verdictOf(now, outcome);
    if (verdict.kind === 'inconclusive') return 'no_verdict';
    const fresh: Fresh = { kind: 'read', actor, entry: now, outcome, at: this.deps.now() };
    if (verdict.kind === 'not_recorded') {
      this.holdAndAudit(fresh, 'read');
      return 'clear';
    }
    return this.recordedEffect(fresh, verdict, 'read') === 'late_commit' ? 'late_commit' : 'clear';
  }

  /** A closed return that no read or send is running for (the stop latch first). */
  private checkable(returnId: string): boolean {
    if (this.deps.isStopped()) return false;
    if (this.busy.has(returnId) || this.deps.sends.isSending(returnId)) return false;
    return this.deps.dispositions.stateOf(returnId) === 'closed';
  }

  // ── close ──────────────────────────────────────────────────────────────────────────────────────

  async close(req: ReturnsCloseRequest): Promise<ReturnsCloseResponse> {
    const admitted = this.admit('close');
    if (!('actor' in admitted)) return admitted;
    const { actor } = admitted;
    if (!isUuid(req.approvalId)) return this.refuse(actor, 'close', 'invalid_input');
    const target = this.target(actor, 'close', req.returnId);
    if (!('entry' in target)) return target;
    const { entry } = target;
    const early = this.closeRefusal(actor, entry);
    if (early !== null) return early;
    const fresh = await this.readFresh(actor, 'close', entry);
    if (fresh.kind === 'refused') return fresh;
    const afterRead = this.closeRefusal(actor, fresh.entry);
    if (afterRead !== null) return afterRead;
    return this.closeOn(fresh, verdictOf(fresh.entry, fresh.outcome), req.approvalId);
  }

  /** Why this return cannot be closed now (closed already; the quiet period), or null. */
  private closeRefusal(actor: AuthSnapshot, entry: JournalEntry): Refused | null {
    if (isClosedState(this.deps.dispositions.stateOf(entry.returnId))) {
      return this.refuse(actor, 'close', 'already_resolved', idsOf(entry), entry);
    }
    const quiet = this.deps.quiet.check(entry);
    if (quiet.kind === 'elapsed') return null;
    const reason = quiet.kind === 'too_soon' ? 'reconcile_too_soon' : 'quiet_period_unproven';
    return this.refuse(actor, 'close', reason, idsOf(entry), entry);
  }

  private closeOn(fresh: Fresh, verdict: Verdict, approvalId: string): ReturnsCloseResponse {
    const { actor, entry } = fresh;
    if (verdict.kind === 'inconclusive') {
      this.auditInconclusive(fresh, verdict.cause, 'close');
      return this.refuse(actor, 'close', refusalForCause(verdict.cause), idsOf(entry), entry);
    }
    if (verdict.kind === 'recorded') {
      // The server HAS it: never a close. A mismatch goes to support; the refusal says to read first.
      this.recordedEffect(fresh, verdict, 'close');
      return this.refuse(actor, 'close', 'close_needs_not_recorded', idsOf(entry), entry);
    }
    try {
      this.deps.transaction(() => {
        this.writeClose(fresh, approvalId);
      });
    } catch (err) {
      if (err instanceof CloseRefusal) {
        return this.refuse(actor, 'close', err.reason, idsOf(entry), entry);
      }
      throw err;
    }
    return { kind: 'closed', ret: this.view(entry.returnId) };
  }

  /**
   * INSIDE the transaction, from fresh reads: re-check the state, spend the approval, prove who
   * requested and who approved, then write the close and its audits. Throws `CloseRefusal` (rolling the
   * spend back) for anything that does not hold. Synchronous: no await can change the actor in between.
   */
  private writeClose(fresh: Fresh, approvalId: string): void {
    const { actor, at } = fresh;
    const current = this.deps.repo.read(fresh.entry.returnId);
    if (current === null) throw new CloseRefusal('return_not_found');
    if (!isDisposable(current) || isClosedState(this.deps.dispositions.stateOf(current.returnId))) {
      throw new CloseRefusal('already_resolved');
    }
    // The read covered the return's last send as `fresh.entry` shows it: a send since makes the verdict
    // stale. And the quiet period must still be shown (RT-1498 review LOW-1; defence in depth).
    if (
      current.attemptCount !== fresh.entry.attemptCount ||
      current.lastAttemptAt !== fresh.entry.lastAttemptAt
    ) {
      throw new CloseRefusal('send_in_flight');
    }
    const quiet = this.deps.quiet.check(current);
    if (quiet.kind !== 'elapsed') {
      throw new CloseRefusal(
        quiet.kind === 'too_soon' ? 'reconcile_too_soon' : 'quiet_period_unproven',
      );
    }
    const spent = spendResolveApproval(this.deps.escalation, actor, approvalId, current, 'close');
    if (spent.kind === 'refused') throw new CloseRefusal(spent.reason);
    this.deps.dispositions.insert({
      dispositionId: this.deps.newDispositionId(),
      returnId: current.returnId,
      kind: 'not_recorded_closed',
      verdictSource: 'provenance_read',
      reason: 'not_recorded',
      readVerdictAt: at,
      approvalId,
      actorOperatorId: actor.operatorId,
      createdAt: this.deps.now(),
    });
    this.deps.audit.statusRead(actor, {
      return_id: current.returnId,
      verdict: 'not_recorded',
      purpose: 'close',
    });
    this.deps.audit.closedNotRecorded(
      actor,
      {
        return_id: current.returnId,
        approval_id: approvalId,
        read_verdict_at: at,
        // The return's originating users.id is not captured (RT-196 §9): four-eyes excluded only the requester.
        origin_user_unknown: true,
      },
      spent.approverUserId,
    );
  }
}

export function createReturnsCloseService(
  deps: ReturnsCloseServiceDeps,
): ReturnsCloseAPI & ClosedReturnChecker {
  return new ReturnsCloseService(deps);
}
