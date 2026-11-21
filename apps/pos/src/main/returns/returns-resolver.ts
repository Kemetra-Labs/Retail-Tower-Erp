/**
 * RT-15 S2 — resolve returns whose outcome is not known.
 *
 * A return left `pending` (the app stopped between journaling and the answer)
 * or `unknown` (the answer was lost: timeout, network, 5xx) is re-sent with the
 * IDENTICAL request — the journaled body bytes under the same Idempotency-Key —
 * through the shared dispatcher. Backend-Core either replays the recorded
 * return (201 with `Idempotent-Replayed`, or a 200 provenance replay), which
 * confirms it, or records it now, or refuses it. Never a second return.
 *
 * Runs on startup, on a slow interval, and on demand (`returns.resolve`). A
 * pass runs on behalf of one authorization snapshot taken at its start (a
 * signed-in, unlocked manager/admin on the paired terminal, with the envelope
 * it was admitted with — RT-197 A5); every send carries that snapshot's
 * envelope, and the dispatcher re-checks the snapshot against the live state
 * immediately before every send (the `returns-auth` choke point). The first
 * send it refuses stops the pass; the rows wait, unchanged, for a later
 * eligible operator. Passes are single-flight per process (one terminal per
 * process).
 *
 * Liveness without hammering (RT-197 I2): a background tick re-sends an
 * `unknown` row only once its own backoff has elapsed since its last attempt —
 * the sale-sync policy (1 s doubling per attempt, capped at 5 min) — so a row
 * whose answers keep getting lost is still retried at least every
 * cap + one tick, and one row's backoff never delays another. A never-sent
 * `pending` row is not delayed, and neither is the operator's on-demand
 * `returns.resolve` (`resolveOnce`).
 */
import {
  backoffMs,
  SALE_SYNC_BACKOFF_POLICY,
  type BackoffPolicy,
} from '../sales-sync/sale-sync-engine.js';
import { settledWithin } from '../sales-sync/settled-within.js';
import type { AuthSnapshot, ReturnsAuthorizer } from './returns-auth.js';
import type { ReturnsDispatcher } from './returns-dispatch.js';
import type { ReturnExecutionsDispatcher } from './returns-execution-dispatch.js';
import type { ReturnExecutionsRepository } from './returns-execution-repository.js';
import type { ReturnsRepository } from './returns-repository.js';

interface ReturnsTally {
  readonly confirmed: number;
  readonly refused: number;
  readonly unresolved: number;
}

export interface ResolveSummary extends ReturnsTally {
  /**
   * RT-1543: refund executions of this terminal still waiting to be recorded (pending or unknown)
   * when the pass ended. They are not part of the three counts above. A number that does not fall
   * means paid-out returns Backend-Core has not been told about. Absent when no execution outbox is
   * composed.
   */
  readonly executionsOpen?: number;
}

export interface ReturnsResolver {
  /**
   * On demand: re-send every unresolved return in the snapshot's scope, oldest
   * first, on behalf of `snapshot` (the caller's admission; re-checked before
   * each send).
   */
  resolveOnce(snapshot: AuthSnapshot): Promise<ResolveSummary>;
  /**
   * One background pass on behalf of the live authorized actor; a no-op (null)
   * while another pass runs or nobody eligible (with an envelope) is signed in.
   */
  tick(): Promise<ResolveSummary | null>;
  /** Settles when the active pass (if any) has finished, or after `timeoutMs`. */
  drain(timeoutMs: number): Promise<void>;
}

export interface ReturnsResolverDeps {
  readonly repo: Pick<ReturnsRepository, 'listUnresolved'>;
  readonly dispatcher: ReturnsDispatcher;
  /** The choke point; the dispatcher re-checks the pass's actor before each send. */
  readonly authorizer: Pick<ReturnsAuthorizer, 'current' | 'recheck'>;
  /** The domain clock (ISO-8601 UTC); the same one that stamps attempts. */
  readonly now: () => string;
  /** Per-row backoff for `unknown` rows (default: the sale-sync policy). */
  readonly backoff?: BackoffPolicy;
  /**
   * RT-1543: the refund-execution outbox, drained by the same pass after the returns (same
   * snapshot, same recheck before each send, same per-row backoff). Its open rows are reported as
   * `executionsOpen`, apart from the returns' counts. Absent: no executions are sent.
   */
  readonly executions?: {
    readonly repo: Pick<ReturnExecutionsRepository, 'listUnrecorded'>;
    readonly dispatcher: Pick<ReturnExecutionsDispatcher, 'send' | 'idle'>;
    /**
     * True once the return domain is stopping: the pass reads the outbox only while it is live
     * (this part runs after the returns' awaits, when the DB may already be closed).
     */
    readonly isStopped: () => boolean;
  };
}

const EMPTY: ReturnsTally = { confirmed: 0, refused: 0, unresolved: 0 };

/** The retry bookkeeping both outboxes share (a journal row and an execution row). */
interface Retryable {
  readonly state: string;
  readonly lastAttemptAt: string | null;
  readonly attemptCount: number;
}

/**
 * True when a background tick may re-send `entry` at `nowMs`: always for a row
 * that is not `unknown` or has no recorded attempt; else once
 * `backoffMs(policy, attemptCount)` has elapsed since its last attempt. An
 * unreadable stamp, or one in the future (the clock moved backwards, e.g. an
 * NTP correction of a fast RTC), is due: fail towards liveness, never starve.
 */
function isDue(entry: Retryable, nowMs: number, policy: BackoffPolicy): boolean {
  if (entry.state !== 'unknown' || entry.lastAttemptAt === null) return true;
  const waited = nowMs - Date.parse(entry.lastAttemptAt);
  return waited < 0 || !(waited < backoffMs(policy, entry.attemptCount));
}

/** The pass in flight, and whether it is a backoff-filtered background tick. */
interface RunningPass {
  readonly pass: Promise<ResolveSummary>;
  readonly background: boolean;
}

type StartPass = () => Promise<ResolveSummary>;

const ignore = (): undefined => undefined;

/**
 * Single-flight bookkeeping: at most one pass runs per process. An on-demand
 * pass shares a running on-demand pass, but never joins a background tick (it
 * skipped rows still backing off): it waits for the tick, then runs one
 * unfiltered pass. Every send of one return stays single-flight (dispatcher).
 */
class PassTracker {
  private running: RunningPass | null = null;

  get busy(): boolean {
    return this.running !== null;
  }

  background(start: StartPass): Promise<ResolveSummary> {
    return this.track(start(), true);
  }

  onDemand(start: StartPass): Promise<ResolveSummary> {
    if (this.running === null) return this.track(start(), false);
    if (!this.running.background) return this.running.pass;
    const afterTick = this.running.pass.then(ignore, ignore);
    return this.track(afterTick.then(start), false);
  }

  /** Settles when the pass in flight (if any) has finished, or after `timeoutMs`. */
  drain(timeoutMs: number): Promise<void> {
    if (this.running === null) return Promise.resolve();
    return settledWithin(this.running.pass, timeoutMs);
  }

  /** Track `work` as the one pass in flight until it settles. */
  private track(work: Promise<ResolveSummary>, background: boolean): Promise<ResolveSummary> {
    const current: Promise<ResolveSummary> = work.finally(() => {
      if (this.running?.pass === current) this.running = null;
    });
    this.running = { pass: current, background };
    return current;
  }
}

/** One pass over the snapshot's unresolved rows (background: only those due). */
function createPass(deps: ReturnsResolverDeps) {
  const policy = deps.backoff ?? SALE_SYNC_BACKOFF_POLICY;

  /** This pass's rows: all, or (background) only those due; the rest are still backing off. */
  function dueOf<T extends Retryable>(all: readonly T[], backgroundTick: boolean) {
    if (!backgroundTick) return { rows: all, waiting: 0 };
    const nowMs = Date.parse(deps.now());
    const rows = all.filter((entry) => isDue(entry, nowMs, policy));
    return { rows, waiting: all.length - rows.length };
  }

  /** The returns of this pass; `stopped` when the actor lost authorization part-way. */
  async function returnsPass(snapshot: AuthSnapshot, backgroundTick: boolean) {
    const { rows, waiting } = dueOf(deps.repo.listUnresolved(snapshot.scope), backgroundTick);
    // Rows still backing off stay unresolved.
    const tally = { ...EMPTY, unresolved: waiting };
    for (const [index, entry] of rows.entries()) {
      const outcome = await deps.dispatcher.send(entry, 'resolve', snapshot);
      // Not sent: the pass's actor lost authorization (sign-out, switch, lock,
      // unpairing…). Stop; this row and the rest wait for a later pass.
      if (outcome.kind === 'deferred') {
        return {
          tally: { ...tally, unresolved: tally.unresolved + rows.length - index },
          stopped: true,
        };
      }
      if (outcome.kind === 'confirmed') tally.confirmed += 1;
      else if (outcome.kind === 'refused') tally.refused += 1;
      else tally.unresolved += 1;
    }
    return { tally, stopped: false };
  }

  /** RT-1543: the refund executions of this pass, after the returns. */
  async function executionsPass(snapshot: AuthSnapshot, backgroundTick: boolean): Promise<void> {
    const { executions } = deps;
    if (executions === undefined || executions.isStopped()) return;
    const { rows } = dueOf(executions.repo.listUnrecorded(snapshot.scope), backgroundTick);
    for (const entry of rows) {
      const outcome = await executions.dispatcher.send(entry, snapshot);
      if (outcome.kind === 'deferred' || executions.isStopped()) return;
    }
  }

  /** RT-1543: the open executions now, as a summary field (none without an outbox, or once stopped). */
  function openExecutions(snapshot: AuthSnapshot): { executionsOpen?: number } {
    const { executions } = deps;
    // After stop the DB may be closed: the count is unknown, so the field is absent (never 0).
    if (executions === undefined || executions.isStopped()) return {};
    return { executionsOpen: executions.repo.listUnrecorded(snapshot.scope).length };
  }

  return async function pass(
    snapshot: AuthSnapshot,
    backgroundTick: boolean,
  ): Promise<ResolveSummary> {
    const { tally, stopped } = await returnsPass(snapshot, backgroundTick);
    if (!stopped) await executionsPass(snapshot, backgroundTick);
    return { ...tally, ...openExecutions(snapshot) };
  };
}

export function createReturnsResolver(deps: ReturnsResolverDeps): ReturnsResolver {
  const passes = new PassTracker();
  const pass = createPass(deps);

  return {
    // RT-1543: a post-payout execution send is not a pass; shutdown waits for it too.
    drain: async (timeoutMs) => {
      const idle = deps.executions?.dispatcher.idle();
      // Both waits share the one deadline, so shutdown never waits for twice the bound.
      await Promise.all([
        passes.drain(timeoutMs),
        idle === undefined ? undefined : settledWithin(idle, timeoutMs),
      ]);
    },
    resolveOnce: (snapshot) => passes.onDemand(() => pass(snapshot, false)),
    tick: () => {
      // The pass's authorization snapshot, taken once at its start.
      const live = deps.authorizer.current();
      if (passes.busy || live.kind !== 'ok') return Promise.resolve(null);
      if (deps.authorizer.recheck(live.actor) !== null) return Promise.resolve(null);
      return passes.background(() => pass(live.actor, true));
    },
  };
}
