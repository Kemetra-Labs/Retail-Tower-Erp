/**
 * return-commit-deadline.ts — RT-1548 slice 2, BR-7: the bound on issuing the
 * COMMIT of a `recordReturn` request (`pos-sales/sales.yaml` 1.28.0-draft,
 * `recordReturn` "Late-commit bound"; RT-196 design spec section 4, BR-7).
 *
 * The runtime issues NO COMMIT later than `RETURN_COMMIT_BUDGET_MS` after it
 * received the request, and a request that runs out of budget is rolled back
 * and records nothing. The bound is what gives `readReturnStatusByProvenance`
 * its affirmative `not_recorded`.
 *
 * How it is enforced (PostgreSQL 16 has no `transaction_timeout`):
 *   1. The receipt is stamped by `ReturnCommitDeadlineMiddleware`, which runs
 *      before every guard and interceptor, so the budget includes
 *      authentication, the idempotency claim, the pool wait and the wait for the
 *      `sales` row lock (`lockSaleForReversal`), not only the statements.
 *   2. `guardClient` wraps the transaction's client: before EVERY statement it
 *      sets the transaction-local `statement_timeout` and `lock_timeout` to
 *      the remaining budget (so a lock wait or a slow statement is cancelled by
 *      Postgres when the budget ends), or throws when none is left.
 *   3. `runWithTenantContext`'s `beforeCommit` hook calls `assertOpen()`
 *      synchronously, right before the COMMIT call. This check is what makes
 *      the guarantee exact; the timeouts only unblock a wait.
 *
 * The bound is on ISSUING the COMMIT. How long the database takes to finish it
 * is bounded only under the deployment assumption in
 * `docs/operations/return-commit-bound.md` (no unbounded synchronous
 * replication commit wait).
 *
 * The clock is monotonic (`performance.now()`): a wall-clock step cannot move
 * the deadline. It is injectable so the arithmetic is testable.
 */
import {
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  RequestMethod,
} from "@nestjs/common";
import type { PoolClient } from "pg";

/** The BR-7 budget, from receipt of the request to the latest COMMIT issue. One named constant. */
export const RETURN_COMMIT_BUDGET_MS = 60_000;

/** A monotonic millisecond clock. */
export interface DeadlineClock {
  now(): number;
}

/** The production clock: `performance.now()`, monotonic, unaffected by wall-clock steps. */
export const monotonicClock: DeadlineClock = { now: () => performance.now() };

/** DI token that tests (and only tests) bind to a fake clock. */
export const RETURN_DEADLINE_CLOCK = Symbol("RETURN_DEADLINE_CLOCK");

/**
 * The budget ran out before the COMMIT could be issued. Nothing was recorded.
 * It is not an `HttpException`, so the global filter answers the contract's
 * `SystemFailure` shape (500 `internal_error`, no cause returned): the
 * `recordReturn` contract lists no other status for it.
 */
export class ReturnDeadlineExceededError extends Error {
  constructor(cause?: unknown) {
    super("the recordReturn commit budget (BR-7) is exhausted; the transaction was rolled back", { cause });
    this.name = "ReturnDeadlineExceededError";
  }
}

/**
 * A statement was started on the guarded client after the work had settled
 * (the transaction is about to be, or has been, committed or rolled back). It
 * was not sent. A programming fault, not a budget refusal: it is not mapped to
 * the deadline error.
 */
export class GuardedClientClosedError extends Error {
  constructor() {
    super("a statement was started on the recordReturn client after its work had settled");
    this.name = "GuardedClientClosedError";
  }
}

const STATEMENT_TIMEOUT = "57014"; // query_canceled
const LOCK_NOT_AVAILABLE = "55P03"; // lock_timeout

/**
 * Whether `err` is the signal of an exhausted budget: our own error, or the
 * Postgres cancel of the timeouts `guardClient` sets (walks `cause`).
 */
export function isDeadlineTimeoutError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    if (current instanceof ReturnDeadlineExceededError) return true;
    const code = (current as { code?: unknown }).code;
    if (code === STATEMENT_TIMEOUT || code === LOCK_NOT_AVAILABLE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const ARM_TIMEOUTS_SQL = "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)";

/** The deadline of one `recordReturn` request. */
export class CommitDeadline {
  constructor(
    private readonly receivedAt: number,
    private readonly clock: DeadlineClock = monotonicClock,
    private readonly budgetMs: number = RETURN_COMMIT_BUDGET_MS,
  ) {}

  /** A deadline whose clock starts now (a caller that has no receipt stamp). */
  static startingNow(clock: DeadlineClock = monotonicClock, budgetMs: number = RETURN_COMMIT_BUDGET_MS): CommitDeadline {
    return new CommitDeadline(clock.now(), clock, budgetMs);
  }

  /** Milliseconds left; zero or negative once the budget is gone. */
  remainingMs(): number {
    return this.receivedAt + this.budgetMs - this.clock.now();
  }

  /**
   * Throws when less than one whole millisecond is left. Zero must count as
   * expired: Postgres reads `statement_timeout = 0` as "no timeout".
   */
  assertOpen(): void {
    if (Math.floor(this.remainingMs()) < 1) throw new ReturnDeadlineExceededError();
  }

  /**
   * The client the transaction's work uses. Before each statement, in call
   * order and one at a time, it arms `statement_timeout` and `lock_timeout`
   * (transaction-local) to the budget left at that moment, or throws when none
   * is left, without sending the statement. Everything but `query` is the real
   * client's. This guard never closes; the request path uses `runGuarded`.
   */
  guardClient(client: PoolClient): PoolClient {
    return this.guard(client).client;
  }

  /**
   * Runs `work` with a guarded client and closes the guard when the work has
   * settled, success or failure, which is before the COMMIT or ROLLBACK that
   * follows. A statement started after that (an orphaned branch of a failed
   * `Promise.all`, a late callback) is refused with `GuardedClientClosedError`
   * and never reaches the connection, so nothing runs after ROLLBACK, COMMIT or
   * the release of the client.
   */
  async runGuarded<T>(client: PoolClient, work: (guarded: PoolClient) => Promise<T>): Promise<T> {
    const guard = this.guard(client);
    try {
      return await work(guard.client);
    } finally {
      guard.close();
    }
  }

  private guard(client: PoolClient): { client: PoolClient; close: () => void } {
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const refuseIfClosed = (): void => {
      if (closed) throw new GuardedClientClosedError();
    };
    const guardedQuery = (...args: unknown[]): Promise<unknown> => {
      const turn = tail.then(async () => {
        refuseIfClosed();
        this.assertOpen();
        const ms = Math.floor(this.remainingMs());
        await client.query(ARM_TIMEOUTS_SQL, [String(ms)]);
        // The work may have settled during the arming round trip: check again,
        // in the same tick as the statement call.
        refuseIfClosed();
        return (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
      });
      tail = turn.catch(() => undefined);
      return turn;
    };
    const proxy = new Proxy(client, {
      get(target, prop) {
        if (prop === "query") return guardedQuery;
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return {
      client: proxy,
      close: () => {
        closed = true;
      },
    };
  }
}

const STAMP = "returnCommitDeadline";

/**
 * Stamps the receipt of a `recordReturn` request. Registered on the route in
 * `SalesModule`, ahead of every guard and interceptor.
 */
@Injectable()
export class ReturnCommitDeadlineMiddleware implements NestMiddleware {
  constructor(@Inject(RETURN_DEADLINE_CLOCK) private readonly clock: DeadlineClock) {}

  use(req: object, _res: unknown, next: () => void): void {
    (req as Record<string, unknown>)[STAMP] = CommitDeadline.startingNow(this.clock);
    next();
  }
}

/**
 * The deadline stamped on the request. A request that was never stamped (a
 * direct call, a test) gets a fresh full budget from now: bounded, never
 * unbounded.
 */
export function commitDeadlineOf(req: object | undefined): CommitDeadline {
  const stamped = req === undefined ? undefined : (req as Record<string, unknown>)[STAMP];
  return stamped instanceof CommitDeadline ? stamped : CommitDeadline.startingNow();
}

/** The one route whose COMMIT the BR-7 bound covers. */
export const RECORD_RETURN_ROUTE = "api/pos/v1/sales/:saleRef/returns";

/**
 * Registers `ReturnCommitDeadlineMiddleware` on `recordReturn`. `SalesModule`
 * imports it; a hand-rolled test module that mounts the sales controllers
 * imports it too, so the receipt is stamped the same way.
 */
@Module({
  // The clock is a provider so a db-integration spec can override it with a fake.
  providers: [{ provide: RETURN_DEADLINE_CLOCK, useValue: monotonicClock }, ReturnCommitDeadlineMiddleware],
})
export class ReturnCommitDeadlineModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ReturnCommitDeadlineMiddleware)
      .forRoutes({ path: RECORD_RETURN_ROUTE, method: RequestMethod.POST });
  }
}
