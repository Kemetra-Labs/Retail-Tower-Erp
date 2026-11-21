/**
 * RT-1543 — send one outboxed refund execution and record what Backend-Core said.
 *
 * Shared by the post-payout send and the resolver, so a first send and every re-send behave
 * identically: the frozen body bytes, the same `Idempotency-Key` (= `externalId`).
 *
 *   recorded (201 / 200 / replay)   -> recorded, only if the answer names THIS execution
 *   refused (409 / 422)             -> refused (final, logged); the frozen bytes cannot succeed
 *   anything else, 400 and 404 too  -> unknown (logged with its cause and attempt); never success,
 *                                      retried with backoff
 *
 * A send runs on behalf of one authorization snapshot (the same choke point as the return
 * dispatcher): re-checked right before the POST, which carries the snapshot's own envelope. No
 * send starts once the domain is stopped, and a send in flight at stop touches nothing local when
 * it settles (the DB may already be closed). Sends of one execution are single-flight. Never throws.
 */
import type { AuthSnapshot, ReturnsAuthorizer } from './returns-auth.js';
import type { RecordExecutionOutcome, ReturnsClient } from './returns-client.js';
import type { ExecutionEntry, ReturnExecutionsRepository } from './returns-execution-repository.js';
import type { WireRefundExecution } from './returns-wire.js';

type ExecutionDispatchOutcome =
  | { readonly kind: 'recorded'; readonly entry: ExecutionEntry }
  | { readonly kind: 'refused'; readonly entry: ExecutionEntry }
  | { readonly kind: 'unconfirmed'; readonly entry: ExecutionEntry }
  /** Not sent: the actor is no longer authorized or the domain stopped; the row waits. */
  | { readonly kind: 'deferred'; readonly entry: ExecutionEntry };

export interface ReturnExecutionsDispatcher {
  send(entry: ExecutionEntry, snapshot: AuthSnapshot): Promise<ExecutionDispatchOutcome>;
  /** Send every open execution of one return (the post-payout kick), oldest first. */
  sendForReturn(returnId: string, snapshot: AuthSnapshot): Promise<void>;
  /** Settles when every send in flight has finished. */
  idle(): Promise<void>;
}

export interface ReturnExecutionsDispatchDeps {
  readonly client: Pick<ReturnsClient, 'recordRefundExecution'>;
  readonly repo: ReturnExecutionsRepository;
  /** The choke point: re-authorizes the actor immediately before every send. */
  readonly authorizer: Pick<ReturnsAuthorizer, 'recheck'>;
  readonly isStopped: () => boolean;
  readonly now: () => string;
  readonly logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

const OPEN_STATES: ReadonlySet<string> = new Set(['pending', 'unknown']);

/** What a row that is already final says, for a send that changed nothing. */
function outcomeOfState(entry: ExecutionEntry): ExecutionDispatchOutcome {
  if (entry.state === 'recorded') return { kind: 'recorded', entry };
  if (entry.state === 'refused') return { kind: 'refused', entry };
  return { kind: 'unconfirmed', entry };
}

const sameRef = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The answer names this execution: its own ref, its allocation and its return. */
function isThisExecution(entry: ExecutionEntry, answer: WireRefundExecution): boolean {
  return (
    sameRef(answer.executionRef, entry.executionId) &&
    sameRef(answer.allocationRef, entry.allocationRef) &&
    sameRef(answer.returnRef, entry.returnRef)
  );
}

class JournaledExecutionsDispatcher implements ReturnExecutionsDispatcher {
  private readonly inFlight = new Map<string, Promise<ExecutionDispatchOutcome>>();

  constructor(private readonly deps: ReturnExecutionsDispatchDeps) {}

  send(entry: ExecutionEntry, snapshot: AuthSnapshot): Promise<ExecutionDispatchOutcome> {
    const running = this.inFlight.get(entry.executionId);
    if (running !== undefined) return running;
    const promise = this.sendOnce(entry, snapshot).finally(() => {
      this.inFlight.delete(entry.executionId);
    });
    this.inFlight.set(entry.executionId, promise);
    return promise;
  }

  async sendForReturn(returnId: string, snapshot: AuthSnapshot): Promise<void> {
    if (this.deps.isStopped()) return;
    const open = this.deps.repo.listForReturn(returnId).filter((e) => OPEN_STATES.has(e.state));
    for (const entry of open) {
      const outcome = await this.send(entry, snapshot);
      // The stop latch first after every await: the DB may be closed (RT-198).
      if (outcome.kind === 'deferred' || this.deps.isStopped()) return;
    }
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private async sendOnce(
    entry: ExecutionEntry,
    snapshot: AuthSnapshot,
  ): Promise<ExecutionDispatchOutcome> {
    if (this.deps.isStopped()) return { kind: 'deferred', entry };
    try {
      return await this.sendChecked(entry, snapshot);
    } catch {
      this.deps.logger.warn({ execution_id: entry.executionId }, 'returns:execution_send_failed');
      return { kind: 'unconfirmed', entry };
    }
  }

  private async sendChecked(
    entry: ExecutionEntry,
    snapshot: AuthSnapshot,
  ): Promise<ExecutionDispatchOutcome> {
    const current = this.deps.repo.read(entry.executionId) ?? entry;
    if (!OPEN_STATES.has(current.state)) return outcomeOfState(current);
    if (this.deps.authorizer.recheck(snapshot) !== null) {
      this.deps.logger.warn(
        { execution_id: entry.executionId },
        'returns:execution_deferred_unauthorized',
      );
      return { kind: 'deferred', entry: current };
    }
    this.deps.repo.recordAttempt({ executionId: entry.executionId, now: this.deps.now() });
    const outcome = await this.deps.client.recordRefundExecution(
      {
        saleRef: current.serverSaleRef,
        returnRef: current.returnRef,
        bodyJson: current.requestBodyJson,
        idempotencyKey: current.externalId,
      },
      snapshot.envelope,
    );
    // Stopped while the POST was in flight: touch nothing local; the next start re-sends it.
    if (this.deps.isStopped()) return { kind: 'deferred', entry: current };
    return this.apply(current, outcome);
  }

  /**
   * Why this send left the execution unknown, and which attempt it was (ids and a closed cause
   * only: no amount, no body, no envelope), so a stuck payout report is diagnosable from the log.
   */
  private logUnknown(entry: ExecutionEntry, outcome: RecordExecutionOutcome): void {
    const attempt = entry.attemptCount + 1;
    if (outcome.kind === 'recorded') {
      this.deps.logger.warn(
        { execution_id: entry.executionId, attempt },
        'returns:execution_confirmation_mismatch',
      );
      return;
    }
    const cause = outcome.kind === 'unknown' ? outcome.cause : null;
    this.deps.logger.warn(
      { execution_id: entry.executionId, attempt, cause },
      'returns:execution_unknown',
    );
  }

  private apply(entry: ExecutionEntry, outcome: RecordExecutionOutcome): ExecutionDispatchOutcome {
    const stamp = { executionId: entry.executionId, now: this.deps.now() };
    if (outcome.kind === 'recorded' && isThisExecution(entry, outcome.execution)) {
      this.deps.repo.markRecorded(stamp);
    } else if (outcome.kind === 'refused') {
      this.deps.logger.warn(
        { execution_id: entry.executionId, reason: outcome.reason },
        'returns:execution_refused',
      );
      this.deps.repo.markRefused({ ...stamp, reason: outcome.reason });
    } else {
      this.logUnknown(entry, outcome);
      this.deps.repo.markUnknown(stamp);
    }
    return outcomeOfState(this.deps.repo.read(entry.executionId) ?? entry);
  }
}

export function createReturnExecutionsDispatcher(
  deps: ReturnExecutionsDispatchDeps,
): ReturnExecutionsDispatcher {
  return new JournaledExecutionsDispatcher(deps);
}
