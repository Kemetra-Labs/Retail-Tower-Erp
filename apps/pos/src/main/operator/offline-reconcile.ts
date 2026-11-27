import type { Logger } from 'pino';

import type {
  CashierAdmissionAdmitted,
  CashierAdmissionResult,
} from './cashier-admission-client.js';
import {
  captureSendMark,
  endAdmissionTracked,
  monotonicNowMs,
  nextIdempotencyKey,
  notifyGrantSeam,
  type AdmissionSendMark,
  type CashierAdmissionDeps,
} from './cashier-admission.js';
import type {
  AuthorityLatchCause,
  OperatorSessionRecord,
  SessionManager,
} from './session-manager.js';

/**
 * RT-1312 F17 (owner decision D2; RT-113 P4, planning record 10763 D8) —
 * reconnect reconciliation of a cashier session admitted OFFLINE from the
 * sealed grant.
 *
 * Such a session holds no server admission (`offline-admission.ts`). While it
 * runs, this module asks Backend-Core to record one: `POST
 * /api/pos/v1/cashier-admissions` with `mode: reconcile_offline`, first at
 * once, then every {@link RECONCILE_RETRY_MS} until it is answered (a drain
 * that asks for a held cashier also nudges it, so a reconnect does not wait for
 * the next tick). The server's live admission always wins; it never lets the
 * offline admission silently supersede it, and `offline_admitted_at` (the
 * session's start) is provenance for audit only.
 *
 * Outcomes (every one is main-owned; this module reverses no tender and
 * discards no sale):
 *  - `admitted`: the session becomes `online_confirmed` (which also lifts the
 *    offline bound), the grant is refreshed through the seam and the keeper
 *    arms the heartbeat for the new admission;
 *  - `active_elsewhere` (a conflict) and `refused` (403): the grant is
 *    invalidated and the session is latched at once (no new sale), ending at its
 *    first safe point as `superseded_by_takeover` / `account_disabled_mid_session`,
 *    exactly as a lost heartbeat does. The PIN-gated "take over here / end
 *    here" lock screen (D9) is RT-309's UI work, not this module's;
 *  - device 401: the grant is invalidated; revocation stays the shared
 *    detector's call (RT-215); the reconcile retries;
 *  - 5xx, transport failure, no device token: the session stays offline within
 *    its bounds; retry every 60 s;
 *  - 400 / 409 / a malformed 200: a definite answer. It is logged, not retried
 *    (a fresh key would not change it), and the session stays as it was.
 *
 * Which sessions: only a LIVE offline-admitted session. A session that ended
 * before the till reconnected is not reconciled (that would leave a live server
 * admission for a cashier who is not signed in), and a restart loses the
 * in-memory session (D7): the next offline sign-in registers again.
 *
 * What this does NOT do (Backend-Core, not this module): the server accepts a
 * device-path sale only inside a server admission window that starts at
 * `created_at - 120 s`, and a `reconcile_offline` row is created at arrival
 * time (`offline_admitted_at` is audit provenance, never read there:
 * `operator-attribution.ts`). Reconciling therefore keeps the live session
 * recorded going forward, but it does not by itself make the server accept
 * sales made earlier outside every window (an outage longer than the 12 h TTL,
 * or after an `end`). Such a sale is answered 403 and dead-lettered by the
 * existing path, to be recovered through RT-1312 Phase 3 item 1 (quarantine
 * and Console repair).
 *
 * Sales gate (D2: "before draining those sales"): {@link isSaleHeld} is true
 * from the start of the reconcile until its first answer, so the drain does not
 * send that cashier's sales ahead of it. It is bounded so it can never strand a
 * sale: a transport failure never counts (the drain cannot send either), but
 * {@link RECONCILE_GATE_MAX_SERVER_ERRORS} answers of 5xx / 429 open it while
 * the reconcile keeps retrying. Whatever the server then decides per sale
 * (including a refusal, which dead-letters it) is unchanged.
 *
 * An answer for a session that is gone, replaced, or from before a re-pair is
 * never adopted: an `admitted` is released with an `end` echoing its
 * generation (as the heartbeat's orphan release does), a conflict still
 * invalidates the grant (fail closed). Once {@link OfflineReconciler.stop} has
 * run (RT-198 latch) nothing is sent and no answer changes anything.
 *
 * Logs carry the outcome kind only: no user id, admission id, key, name or
 * generation.
 */

/** D8: the reconcile cadence while unanswered. */
export const RECONCILE_RETRY_MS = 60_000;
/** The shortest gap between two attempts when a drain nudges (a reconnect). */
export const RECONCILE_NUDGE_MIN_MS = 10_000;
/** Answers of 5xx / 429 after which the sales gate opens (the reconcile goes on). */
export const RECONCILE_GATE_MAX_SERVER_ERRORS = 5;

export interface OfflineReconcilerDeps {
  sessionManager: Pick<SessionManager, 'getCurrent' | 'renewAdmission'>;
  admission: CashierAdmissionDeps;
  /** The session now holds a live admission: arm its heartbeat. */
  onAdopted: (session_id: string) => void;
  /** Authority is lost: latch the session and end it at its first safe point. */
  onConflict: (session_id: string, cause: AuthorityLatchCause) => void;
  /**
   * A late `admitted` named the admission the CURRENT session already holds (a
   * same-device re-admission returns the same id): the request renewed it, so
   * the generation the session holds may be stale. The keeper verifies early.
   */
  onLiveAdmissionRenewed: (admission_id: string) => void;
  /**
   * RT-309 (10763 D8) — the session adopted the admission (it is now
   * online-confirmed): write the conversion's audit event. Called exactly once
   * per conversion, never for a released or stale answer. A throw is ignored.
   */
  onReconciled?: ((record: OperatorSessionRecord) => void) | undefined;
  logger?: Pick<Logger, 'info' | 'warn'> | undefined;
}

/** What one reconcile tracks: the offline session it speaks for. */
interface Entry {
  session_id: string;
  user_id: string;
  operator_id: string;
  offline_admitted_at: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** The session is gone or replaced: nothing more is sent for it. */
  cancelled: boolean;
  /** A definite answer arrived: no more attempts. */
  finished: boolean;
  /** The sales gate no longer holds this cashier's sales. */
  gateOpen: boolean;
  server_errors: number;
  last_attempt_at_ms: number;
  /** No attempt yet, or the last one found Backend-Core unreachable: a reconnect may be near. */
  reconnect_possible: boolean;
}

/** Answers that mean Backend-Core could not be reached at all (nothing came back). */
const UNREACHABLE_KINDS: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'no_connection',
  'no_token',
]);

/** Answers that mean "Backend-Core is up but failing": they count toward the gate bound. */
const SERVER_ERROR_KINDS: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'unavailable',
  'rate_limited',
]);

/** Answers that invalidate offline grants, even for an answer nobody adopts (D4, OD5, OD6). */
const INVALIDATING_KINDS: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'refused',
  'active_elsewhere',
  'device_unauthorized',
]);

/** Answers that say nothing about the cashier: the reconcile simply tries again. */
const TRANSIENT_KINDS: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'no_connection',
  'no_token',
  'unavailable',
  'rate_limited',
]);

/** Definite answers a retry cannot change. */
const DEFINITE_KINDS: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'rejected',
  'idempotency_conflict',
]);

export class OfflineReconciler {
  private entry: Entry | null = null;
  private stopped = false;

  constructor(private readonly deps: OfflineReconcilerDeps) {}

  /** Wire to `SessionManager.onStarted`: reconcile an offline-admitted cashier session. */
  onSessionStarted(record: OperatorSessionRecord): void {
    if (this.stopped) return;
    this.cancel();
    if (record.authority !== 'offline_grant' || record.user_id === undefined) return;
    const entry: Entry = {
      session_id: record.id,
      user_id: record.user_id,
      operator_id: record.operator_id,
      offline_admitted_at: record.started_at,
      timer: null,
      inFlight: false,
      cancelled: false,
      finished: false,
      gateOpen: false,
      server_errors: 0,
      last_attempt_at_ms: Number.NEGATIVE_INFINITY,
      reconnect_possible: true,
    };
    this.entry = entry;
    // A macrotask later, not inside the session's create(): sign-in finishes first.
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.attempt(entry);
    }, 0);
  }

  /** Wire to `SessionManager.onEnded`: a session that ends is not reconciled any more. */
  onSessionEnded(record: OperatorSessionRecord): void {
    if (this.entry?.session_id === record.id) this.cancel();
  }

  /**
   * The drain asks, per device-path sale: hold this cashier's sale? True from
   * the start of the reconcile until its first answer (bounded, see the module
   * doc). Asking also nudges an attempt when none has run for
   * {@link RECONCILE_NUDGE_MIN_MS}, so a reconnect is reconciled at the next
   * drain tick rather than at the next 60 s tick.
   */
  isSaleHeld(user_id: string): boolean {
    const entry = this.holdingEntry(user_id);
    if (entry === null) return false;
    if (this.nudgeDue(entry)) void this.attempt(entry);
    return true;
  }

  /** The reconcile whose first answer `user_id`'s sales wait for, if any. */
  private holdingEntry(user_id: string): Entry | null {
    const entry = this.entry;
    if (entry === null || entry.user_id !== user_id) return null;
    return this.isStopped() || entry.gateOpen ? null : entry;
  }

  /**
   * A nudge only brings a RECONNECT forward. After any answer from the server
   * (5xx, 429, 401) the 60 s cadence stands: the held sales are skipped
   * untouched, so the drain asks every tick and would otherwise speed the
   * retries up (and reach the gate bound in a fraction of the time).
   */
  private nudgeDue(entry: Entry): boolean {
    if (entry.inFlight || !entry.reconnect_possible) return false;
    return this.nowMs() - entry.last_attempt_at_ms >= RECONCILE_NUDGE_MIN_MS;
  }

  /** RT-198 shutdown latch: idempotent; clears the timer; nothing runs afterwards. */
  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  /** Read through a method: `stop()` can run while a request is in flight. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private nowMs(): number {
    return monotonicNowMs(this.deps.admission);
  }

  private cancel(): void {
    const entry = this.entry;
    if (entry === null) return;
    entry.cancelled = true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    this.entry = null;
  }

  private mayAttempt(entry: Entry): boolean {
    return !this.isStopped() && !entry.cancelled && !entry.finished && !entry.inFlight;
  }

  private isLive(entry: Entry): boolean {
    return (
      !this.stopped &&
      !entry.cancelled &&
      this.deps.sessionManager.getCurrent()?.id === entry.session_id
    );
  }

  private async attempt(entry: Entry): Promise<void> {
    if (!this.mayAttempt(entry)) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.inFlight = true;
    entry.last_attempt_at_ms = this.nowMs();
    // Stamped before the request goes out: the server's TTL runs from no earlier.
    const requested_at_ms = entry.last_attempt_at_ms;
    const mark = captureSendMark(this.deps.admission);
    const result = await this.request(entry);
    entry.inFlight = false;
    if (this.isStopped()) return;
    const who = { user_id: entry.user_id, operator_id: entry.operator_id, ...mark };
    if (!this.isLive(entry) || pairingChanged(this.deps.admission, mark)) {
      this.release(entry, result, who);
      return;
    }
    this.log(result.kind);
    entry.reconnect_possible = UNREACHABLE_KINDS.has(result.kind);
    this.apply(entry, result, requested_at_ms, who);
  }

  private async request(entry: Entry): Promise<CashierAdmissionResult> {
    try {
      return await this.deps.admission.client.reconcile({
        mode: 'reconcile_offline',
        user_id: entry.user_id,
        offline_admitted_at: entry.offline_admitted_at,
        idempotency_key: nextIdempotencyKey(this.deps.admission),
      });
    } catch {
      return { kind: 'no_connection' };
    }
  }

  private apply(
    entry: Entry,
    result: CashierAdmissionResult,
    requested_at_ms: number,
    who: AdmissionWho,
  ): void {
    switch (result.kind) {
      case 'admitted':
        this.adopt(entry, result, requested_at_ms, who);
        return;
      case 'active_elsewhere':
        this.conflict(entry, result, who, 'superseded_by_takeover');
        return;
      case 'refused':
        this.conflict(entry, result, who, 'account_disabled_mid_session');
        return;
      case 'device_unauthorized':
        // RT-215: the shared detector saw this answer and decides on revocation.
        notifyGrantSeam(this.deps.admission, result, who);
        entry.gateOpen = true;
        this.scheduleRetry(entry);
        return;
      default:
        this.notAnswered(entry, result);
    }
  }

  private adopt(
    entry: Entry,
    result: CashierAdmissionAdmitted,
    requested_at_ms: number,
    who: AdmissionWho,
  ): void {
    const adopted = this.deps.sessionManager.renewAdmission(entry.session_id, {
      admission_id: result.admission_id,
      admission_ttl_seconds: result.admission_ttl_seconds,
      offline_grace_seconds: result.offline_grace_seconds,
      admission_generation: result.admission_generation,
      admission_requested_at_ms: requested_at_ms,
    });
    if (!adopted) {
      this.release(entry, result, who);
      return;
    }
    notifyGrantSeam(this.deps.admission, result, who);
    this.finish(entry);
    this.auditReconciled(entry);
    this.deps.onAdopted(entry.session_id);
  }

  /** RT-309 (D8): one audit event for the conversion; it never changes the outcome. */
  private auditReconciled(entry: Entry): void {
    const current = this.deps.sessionManager.getCurrent();
    if (current?.id !== entry.session_id) return;
    try {
      this.deps.onReconciled?.(current);
    } catch {
      // The audit write must not change the outcome (the RT-444 precedent).
    }
  }

  private conflict(
    entry: Entry,
    result: CashierAdmissionResult,
    who: AdmissionWho,
    cause: AuthorityLatchCause,
  ): void {
    notifyGrantSeam(this.deps.admission, result, who);
    this.finish(entry);
    this.deps.onConflict(entry.session_id, cause);
  }

  /** Unreachable, failing, or a definite rejection: the session stays offline. */
  private notAnswered(entry: Entry, result: CashierAdmissionResult): void {
    if (DEFINITE_KINDS.has(result.kind)) {
      this.finish(entry);
      return;
    }
    if (SERVER_ERROR_KINDS.has(result.kind)) {
      entry.server_errors += 1;
      if (entry.server_errors >= RECONCILE_GATE_MAX_SERVER_ERRORS) entry.gateOpen = true;
    }
    this.scheduleRetry(entry);
  }

  /** A definite answer arrived: stop reconciling and release the sales gate. */
  private finish(entry: Entry): void {
    entry.finished = true;
    entry.gateOpen = true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private scheduleRetry(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.attempt(entry);
    }, RECONCILE_RETRY_MS);
  }

  /**
   * An answer nobody may adopt (the session ended or was replaced, the pairing
   * changed, or the session refused the admission). Fail closed: a conflict
   * still invalidates the grant. An `admitted` leaves a live server admission,
   * so end it, echoing this response's generation.
   */
  private release(entry: Entry, result: CashierAdmissionResult, who: AdmissionWho): void {
    if (INVALIDATING_KINDS.has(result.kind)) notifyGrantSeam(this.deps.admission, result, who);
    if (result.kind === 'admitted') this.releaseAdmitted(entry, result);
    if (entry.cancelled) return;
    // A transient answer for a session that is still live is no reason to stop reconciling it.
    if (this.isLive(entry) && TRANSIENT_KINDS.has(result.kind)) {
      this.scheduleRetry(entry);
      return;
    }
    this.finish(entry);
  }

  /** End the orphan admission, unless the live session holds that same id (ending it would end theirs). */
  private releaseAdmitted(entry: Entry, result: CashierAdmissionAdmitted): void {
    if (this.heldByLiveSession(result.admission_id)) {
      this.deps.onLiveAdmissionRenewed(result.admission_id);
      return;
    }
    void endAdmissionTracked(
      this.deps.admission,
      result.admission_id,
      result.admission_generation,
      entry.user_id,
    ).then((res) => {
      this.deps.logger?.info(
        { event: 'operator.offline_reconcile.end', outcome: res.kind },
        'offline reconcile orphan admission end',
      );
    });
  }

  private heldByLiveSession(admission_id: string): boolean {
    return this.deps.sessionManager.getCurrent()?.admission_id === admission_id;
  }

  private log(outcome: string): void {
    this.deps.logger?.info(
      { event: 'operator.offline_reconcile', outcome },
      'offline reconcile outcome',
    );
  }
}

type AdmissionWho = AdmissionSendMark & { user_id: string; operator_id: string };

/** True when the pairing differs from the one the request was SENT under. */
function pairingChanged(deps: CashierAdmissionDeps, sent: AdmissionSendMark): boolean {
  if (sent.pairing_generation === undefined) return false;
  return captureSendMark(deps).pairing_generation !== sent.pairing_generation;
}
