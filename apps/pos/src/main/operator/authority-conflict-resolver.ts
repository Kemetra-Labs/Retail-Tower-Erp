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
 * 'authority_conflict'` (it holds no authority; the ordinary unlock refuses
 * it). After a PIN check of the locked session's cashier (the 004 verifier and
 * its lockout), exactly two actions:
 *
 *  - `take_over_here`: an online admission with `takeover: true` (the server
 *    ends the other till's admission; that till gets its own conflict on its
 *    next reconcile or heartbeat). Only a live `admitted` reopens THIS session:
 *    it becomes online-confirmed, is unlocked and its heartbeat is armed. The
 *    idempotency key is kept across a `no_connection` / 5xx retry, so a request
 *    that did reach the server replays instead of taking over twice;
 *  - `end_here`: the session ends `superseded_by_takeover`. The session-end
 *    rules hold the cart and any live tender (RT-116 §3.3, RT-352 / RT-442);
 *    nothing is reversed or discarded.
 *
 * Fail closed everywhere: any other answer keeps the lock (a 403 ends the
 * session `account_disabled_mid_session`, as the reconcile's 403 does). An
 * `admitted` is never adopted when the session changed, the pairing changed,
 * a grant invalidation landed while it was in flight, or the till clock is
 * skewed: it is released with an `end` echoing its generation.
 *
 * Audit (main-only, local): `operator.session.authority_conflict` with
 * `{resolution}` for each decision. Best-effort: the session state change is
 * the safety property. Logs carry the action and outcome only: never the PIN,
 * user id, admission id, key or generation.
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

const RATE_LIMITED: ResolveConflictResponse = { kind: 'takeover_rate_limited' };

function refuse(category: RefusalCategory): OperatorRefusal {
  return { kind: 'refused', category };
}

export class AuthorityConflictResolver {
  private inFlight = false;
  /** The takeover key, kept for a retry of the same session after no answer. */
  private pendingKey: { session_id: string; key: AdmissionKey } | null = null;

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

  private endHere(target: Target): ResolveConflictResponse {
    this.pendingKey = null;
    this.audit(target.session, 'end_here');
    this.deps.sessionManager.endIfCurrent(target.session.id, 'superseded_by_takeover');
    this.log('end_here', 'resolved');
    return { kind: 'resolved', action: 'end_here' };
  }

  private async takeOverHere(target: Target): Promise<ResolveConflictResponse> {
    const key = this.keyFor(target.session.id);
    const sentAtMs = this.deps.tillClockMs?.();
    const result = await admitCashierOnline(this.deps.admission, {
      user_id: target.user_id,
      operator_id: target.session.operator_id,
      takeover: true,
      ...key,
    });
    if (result.kind !== 'admitted') return this.notAdmitted(target, result);
    this.pendingKey = null;
    const blocked = this.adoptionBlocker(target, key, result, sentAtMs);
    if (blocked !== null) {
      this.release(target, result);
      return this.refused(blocked, 'not_adopted', 'take_over_here');
    }
    return this.adopt(target, result);
  }

  /** Re-use the key of an unanswered takeover of the same session; else mint one. */
  private keyFor(session_id: string): AdmissionKey {
    if (this.pendingKey?.session_id === session_id) return this.pendingKey.key;
    const key = mintAdmissionKey(this.deps.admission);
    this.pendingKey = { session_id, key };
    return key;
  }

  private notAdmitted(
    target: Target,
    result: Exclude<OnlineAdmissionResult, { kind: 'admitted' }>,
  ): ResolveConflictResponse {
    const outcome = result.kind;
    if (outcome === 'no_connection' || outcome === 'unavailable') {
      // The key stays: a retry replays a request that may have reached the server.
      return this.refused('no_connection', outcome, 'take_over_here');
    }
    this.pendingKey = null;
    if (outcome === 'rate_limited') {
      this.log('take_over_here', 'rate_limited');
      return RATE_LIMITED;
    }
    if (outcome === 'refused') {
      // 403: the cashier is no longer eligible (10763 D8). The grant was invalidated.
      this.deps.sessionManager.endIfCurrent(target.session.id, 'account_disabled_mid_session');
    }
    return this.refused('state_invalid', outcome, 'take_over_here');
  }

  /** Why an `admitted` may not be adopted; null when it may. */
  private adoptionBlocker(
    target: Target,
    key: AdmissionKey,
    result: CashierAdmissionAdmitted,
    sentAtMs: number | undefined,
  ): RefusalCategory | null {
    if (!this.stillConflictLocked(target.session.id)) return 'state_invalid';
    if (sendMarkMoved(this.deps.admission, key)) return 'state_invalid';
    const clock = this.deps.tillClockMs;
    if (clock !== undefined && sentAtMs !== undefined) {
      if (tillClockSkewed(result.server_time, sentAtMs, clock())) return 'clock_skew';
    }
    return null;
  }

  private adopt(
    target: Target,
    result: CashierAdmissionAdmitted & { requested_at_ms: number },
  ): ResolveConflictResponse {
    const id = target.session.id;
    const renewed = this.deps.sessionManager.renewAdmission(id, {
      admission_id: result.admission_id,
      admission_ttl_seconds: result.admission_ttl_seconds,
      offline_grace_seconds: result.offline_grace_seconds,
      admission_generation: result.admission_generation,
      admission_requested_at_ms: result.requested_at_ms,
    });
    if (!renewed) {
      this.release(target, result);
      return this.refused('state_invalid', 'not_adopted', 'take_over_here');
    }
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
