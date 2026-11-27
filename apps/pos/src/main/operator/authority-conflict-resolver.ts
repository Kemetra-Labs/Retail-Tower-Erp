import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type {
  AuditEvent,
  OperatorRefusal,
  RefusalCategory,
} from '../../shared/audit/event-shape.js';
import type { ResolveConflictRequest, ResolveConflictResponse } from '../../shared/bridge-api.js';

import type { CashierAdmissionAdmitted } from './cashier-admission-client.js';
import {
  admitCashierOnline,
  captureSendMark,
  endAdmissionTracked,
  mintAdmissionKey,
  monotonicNowMs,
  notifyGrantSeam,
  type AdmissionKey,
  type CashierAdmissionDeps,
  type OnlineAdmissionResult,
} from './cashier-admission.js';
import type { OperatorSessionRecord, SessionManager } from './session-manager.js';
import { tillClockSkewed } from './till-clock.js';

/**
 * RT-309 D9 (RT-113 planning record 10763 D9; owner approval RT-309 c19114) —
 * the cashier's decision on an authority-conflict lock.
 *
 * The offline reconcile answered `active_elsewhere`: the cashier is admitted on
 * another till, so this session was LOCKED with `lock_cause:
 * 'authority_conflict'` (it holds no authority; the ordinary unlock and every
 * sign-in refuse it). After a PIN check of the locked session's cashier (the
 * 004 verifier and its lockout), exactly two actions:
 *
 *  - `take_over_here`: an online admission with `takeover: true`. Only a live,
 *    contract-valid `admitted` reopens THIS session: it becomes
 *    online-confirmed, then (and only then) the offline grant is published, the
 *    session is unlocked and its heartbeat is armed;
 *  - `end_here`: the session ends `superseded_by_takeover`. The session-end
 *    rules hold the cart and any live tender (RT-116 §3.3, RT-352 / RT-442).
 *
 * The takeover request (its idempotency key, the send mark bound to it, and
 * when it was FIRST sent) is kept until the server's answer is known, so:
 *  - a retry after no answer replays the same request; the replayed
 *    `server_time` is the original issuance, so the till clock is judged from
 *    the FIRST send, and the admission's lease runs from the first send too;
 *  - «إنهاء هنا» after an unanswered takeover first replays it to learn the
 *    outcome: an `admitted` is released before the session ends; if the server
 *    is still unreachable the session stays locked (no local end while the
 *    server outcome is unknown).
 *
 * Fail closed: an `admitted` is never adopted (it is released, the session
 * stays locked) when the session changed, the pairing or the grant-invalidation
 * mark moved, `server_time` is not a valid timestamp, or the till clock is off
 * by more than the tolerance. Because the window starts at the FIRST send, a
 * replay on a correct till is never misread as skew; a detected skew is the
 * till's own clock (RT-1312 F18): fix it, then take over again. A 403 ends the
 * session `account_disabled_mid_session`.
 *
 * Audit (main-only, local): `operator.session.authority_conflict` with
 * `{resolution}` for each decision. Logs carry the action and outcome only.
 */

interface AuthorityConflictResolverDeps {
  sessionManager: Pick<SessionManager, 'getCurrent' | 'endIfCurrent' | 'renewAdmission' | 'unlock'>;
  /** 004 local PIN check for this terminal's cashier; null on a match. */
  verifyCashierPin: (operator_id: string, pin: string) => Promise<OperatorRefusal | null>;
  admission: CashierAdmissionDeps;
  /** The session was taken over here and holds a live admission: arm its heartbeat. */
  onTakenOver: (session_id: string) => void;
  audit: { emit(event: AuditEvent): void };
  /** The paired terminal; null when unpaired (then no audit is written). */
  resolveTerminalId: () => string | null;
  /** RT-1312 F18 — the till wall clock (epoch ms); omitted in tests that do not check it. */
  tillClockMs?: () => number;
  uuid?: () => string;
  now?: () => Date;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

type Action = ResolveConflictRequest['action'];

/** The conflict-locked session being resolved. */
interface Target {
  session: OperatorSessionRecord;
  user_id: string;
}

/** A takeover request whose server outcome is not known yet. */
interface PendingTakeover {
  session_id: string;
  key: AdmissionKey;
  /** The till wall clock when the request was FIRST sent (RT-1312 F18 window). */
  first_sent_till_ms: number | undefined;
  /** The monotonic clock just before the FIRST send: the lease runs from no earlier. */
  first_requested_at_ms: number;
}

type Admitted = CashierAdmissionAdmitted & { requested_at_ms: number };
type NotAdmitted = Exclude<OnlineAdmissionResult, { kind: 'admitted' }>;

const RATE_LIMITED: ResolveConflictResponse = { kind: 'takeover_rate_limited' };
/** Answers that say nothing about what the server did: the request stays pending. */
const UNKNOWN_OUTCOME: ReadonlySet<string> = new Set(['no_connection', 'unavailable']);
/** RFC 3339 `date-time` (the contract format of `server_time`). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function refuse(category: RefusalCategory): OperatorRefusal {
  return { kind: 'refused', category };
}

function validServerTime(value: string): boolean {
  return RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

export class AuthorityConflictResolver {
  private inFlight = false;
  private pending: PendingTakeover | null = null;

  constructor(private readonly deps: AuthorityConflictResolverDeps) {}

  async resolve(req: ResolveConflictRequest): Promise<ResolveConflictResponse> {
    if (this.inFlight) return this.refused('rate_limited', 'concurrent', req.action);
    this.inFlight = true;
    try {
      return await this.resolveOnce(req);
    } finally {
      this.inFlight = false;
    }
  }

  private async resolveOnce(req: ResolveConflictRequest): Promise<ResolveConflictResponse> {
    const target = this.conflictTarget();
    if (target.kind === 'refused') return this.refused(target.category, 'precheck', req.action);
    const pinRefusal = await this.deps.verifyCashierPin(target.session.operator_id, req.pin);
    if (pinRefusal !== null) return this.refused(pinRefusal.category, 'pin', req.action);
    if (!this.stillConflictLocked(target.session.id)) {
      return this.refused('state_invalid', 'session_changed', req.action);
    }
    return req.action === 'end_here' ? this.endHere(target) : this.takeOverHere(target);
  }

  /** The current session, locked for an authority conflict, of a cashier with a user id. */
  private conflictTarget(): (Target & { kind: 'target' }) | OperatorRefusal {
    const session = this.deps.sessionManager.getCurrent();
    if (session === null) return refuse('not_signed_in');
    const conflict = session.lock_state === 'locked' && session.lock_cause === 'authority_conflict';
    if (!conflict || session.role !== 'cashier' || session.user_id === undefined) {
      return refuse('state_invalid');
    }
    return { kind: 'target', session, user_id: session.user_id };
  }

  private stillConflictLocked(session_id: string): boolean {
    const current = this.deps.sessionManager.getCurrent();
    return (
      current?.id === session_id &&
      current.lock_state === 'locked' &&
      current.lock_cause === 'authority_conflict'
    );
  }

  // ── end here ──────────────────────────────────────────────────────────────

  private async endHere(target: Target): Promise<ResolveConflictResponse> {
    const pending = this.pendingFor(target.session.id);
    if (pending !== null) {
      // An earlier takeover got no answer: learn what the server did first.
      const settled = await this.settlePendingBeforeEnd(target, pending);
      if (settled !== null) return settled;
      if (!this.stillConflictLocked(target.session.id)) {
        return this.refused('state_invalid', 'session_changed', 'end_here');
      }
    }
    this.pending = null;
    this.audit(target.session, 'end_here');
    this.deps.sessionManager.endIfCurrent(target.session.id, 'superseded_by_takeover');
    this.log('end_here', 'resolved');
    return { kind: 'resolved', action: 'end_here' };
  }

  /** Replay the pending takeover; null when its outcome is known (and an admission released). */
  private async settlePendingBeforeEnd(
    target: Target,
    pending: PendingTakeover,
  ): Promise<ResolveConflictResponse | null> {
    const result = await this.send(target, pending);
    if (UNKNOWN_OUTCOME.has(result.kind))
      return this.refused('no_connection', result.kind, 'end_here');
    if (result.kind === 'rate_limited') return RATE_LIMITED;
    this.pending = null;
    if (result.kind === 'admitted') this.release(target, result);
    return null;
  }

  // ── take over here ────────────────────────────────────────────────────────

  private async takeOverHere(target: Target): Promise<ResolveConflictResponse> {
    const pending = this.pendingFor(target.session.id) ?? this.newPending(target.session.id);
    this.pending = pending;
    const result = await this.send(target, pending);
    if (result.kind !== 'admitted') return this.notAdmitted(target, result);
    const blocked = this.adoptionBlocker(target, pending, result);
    this.pending = null;
    if (blocked !== null) {
      this.release(target, result);
      return this.refused(blocked, 'not_adopted', 'take_over_here');
    }
    return this.adopt(target, pending, result);
  }

  private pendingFor(session_id: string): PendingTakeover | null {
    return this.pending?.session_id === session_id ? this.pending : null;
  }

  private newPending(session_id: string): PendingTakeover {
    return {
      session_id,
      key: mintAdmissionKey(this.deps.admission),
      first_sent_till_ms: this.deps.tillClockMs?.(),
      first_requested_at_ms: monotonicNowMs(this.deps.admission),
    };
  }

  /** The takeover request (a replay when the key was used before). The grant is NOT published here. */
  private send(target: Target, pending: PendingTakeover): Promise<OnlineAdmissionResult> {
    return admitCashierOnline(this.deps.admission, {
      user_id: target.user_id,
      operator_id: target.session.operator_id,
      takeover: true,
      ...pending.key,
      publishAdmitted: false,
    });
  }

  private notAdmitted(target: Target, result: NotAdmitted): ResolveConflictResponse {
    const outcome = result.kind;
    if (UNKNOWN_OUTCOME.has(outcome)) {
      // The request stays pending: a retry (or «إنهاء هنا») replays it.
      return this.refused('no_connection', outcome, 'take_over_here');
    }
    if (outcome === 'rate_limited') {
      this.log('take_over_here', 'rate_limited');
      return RATE_LIMITED;
    }
    this.pending = null;
    if (outcome === 'refused') {
      // 403: the cashier is no longer eligible (10763 D8). The grant was invalidated.
      this.deps.sessionManager.endIfCurrent(target.session.id, 'account_disabled_mid_session');
    }
    return this.refused('state_invalid', outcome, 'take_over_here');
  }

  /** Why an `admitted` may not be adopted; null when it may. */
  private adoptionBlocker(
    target: Target,
    pending: PendingTakeover,
    result: Admitted,
  ): RefusalCategory | null {
    if (!this.stillConflictLocked(target.session.id)) return 'state_invalid';
    if (sendMarkMoved(this.deps.admission, pending.key)) return 'state_invalid';
    if (!validServerTime(result.server_time)) return 'state_invalid';
    const clock = this.deps.tillClockMs;
    const sentAt = pending.first_sent_till_ms;
    if (clock !== undefined && sentAt !== undefined) {
      if (tillClockSkewed(result.server_time, sentAt, clock())) return 'clock_skew';
    }
    return null;
  }

  private adopt(
    target: Target,
    pending: PendingTakeover,
    result: Admitted,
  ): ResolveConflictResponse {
    const id = target.session.id;
    const renewed = this.deps.sessionManager.renewAdmission(id, {
      admission_id: result.admission_id,
      admission_ttl_seconds: result.admission_ttl_seconds,
      offline_grace_seconds: result.offline_grace_seconds,
      admission_generation: result.admission_generation,
      // A replay's lease ran from the first send: never later than that.
      admission_requested_at_ms: Math.min(pending.first_requested_at_ms, result.requested_at_ms),
    });
    if (!renewed) {
      this.release(target, result);
      return this.refused('state_invalid', 'not_adopted', 'take_over_here');
    }
    // The grant is published only now, bound to the request's send mark.
    notifyGrantSeam(this.deps.admission, result, {
      user_id: target.user_id,
      operator_id: target.session.operator_id,
      ...pending.key.send_mark,
    });
    this.audit(target.session, 'take_over_here');
    this.deps.sessionManager.unlock(this.now().toISOString(), { resolvesAuthorityConflict: true });
    this.deps.onTakenOver(id);
    this.log('take_over_here', 'resolved');
    return { kind: 'resolved', action: 'take_over_here' };
  }

  /** Never leave a live server admission for a session that did not adopt it. */
  private release(target: Target, result: CashierAdmissionAdmitted): void {
    if (this.deps.sessionManager.getCurrent()?.admission_id === result.admission_id) return;
    void endAdmissionTracked(
      this.deps.admission,
      result.admission_id,
      result.admission_generation,
      target.user_id,
    );
  }

  // ── audit and logs ────────────────────────────────────────────────────────

  private audit(record: OperatorSessionRecord, resolution: Action): void {
    try {
      const terminal_id = this.deps.resolveTerminalId();
      if (terminal_id === null || terminal_id.length === 0) {
        this.deps.logger?.warn(
          { event: 'operator.authority_conflict.audit_no_terminal' },
          'not audited',
        );
        return;
      }
      this.deps.audit.emit({
        event_id: (this.deps.uuid ?? randomUUID)(),
        tenant_id: record.tenant_id,
        branch_id: record.branch_id,
        originating_terminal_id: terminal_id,
        acting_operator_id: record.operator_id,
        session_id: record.id,
        shift_id: null,
        action_category: 'operator.session.authority_conflict',
        created_at: this.now().toISOString(),
        approving_supervisor_id: null,
        payload: { resolution },
      });
    } catch {
      this.deps.logger?.warn({ event: 'operator.authority_conflict.audit_failed' }, 'not audited');
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private refused(category: RefusalCategory, stage: string, action: Action): OperatorRefusal {
    this.log(action, `refused_${stage}`);
    return refuse(category);
  }

  private log(action: Action, outcome: string): void {
    this.deps.logger?.info(
      { event: 'operator.authority_conflict', action, outcome },
      'authority conflict resolution',
    );
  }
}

/** True when the pairing or the grant invalidation marker moved since the key was minted. */
function sendMarkMoved(deps: CashierAdmissionDeps, key: AdmissionKey): boolean {
  const now = captureSendMark(deps);
  const sent = key.send_mark;
  const pairing =
    sent.pairing_generation !== undefined && now.pairing_generation !== sent.pairing_generation;
  const invalidated =
    sent.invalidation_seq !== undefined && now.invalidation_seq !== sent.invalidation_seq;
  return pairing || invalidated;
}
