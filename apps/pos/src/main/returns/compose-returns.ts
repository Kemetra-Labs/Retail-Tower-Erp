/**
 * RT-15 S2 — composition of the return domain (used by `src/main/index.ts`).
 *
 * Builds client → repository → audit → dispatcher → resolver → service from
 * primitive dependencies, and schedules the background resolver. Kept out of
 * `index.ts` so the wiring itself is unit-tested.
 */
import { randomUUID } from 'node:crypto';

import type { ManagerApprovalService } from '../operator/manager-approval-service.js';
import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import type { DatabaseHandle } from '../db/client.js';
import type { DrawerKickTransport } from '../drawer/drawer-kick-transport.js';
import type { DrawerSlot } from '../drawer/drawer-slot.js';
import type { PrintPipeline } from '../receipts/print-pipeline.js';
import { bindSalesRepository } from '../sales/repositories/sales.repository.js';
import { createSaleVoidRepository } from '../sale-void/sale-void-repository.js';
import { DEFAULT_CURRENCY_CODE } from '../sales-sync/create-sale-sync-client.js';
import { createSaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import { createReturnsAudit, type ReturnsAuditSink } from './returns-audit.js';
import {
  createAuthFailureStreak,
  createReturnCauseReader,
  type ReturnCauseReader,
} from './returns-causes.js';
import { DRAIN_MARGIN_MS } from '../sales-sync/settled-within.js';
import {
  createReturnsClient,
  RETURNS_REQUEST_TIMEOUT_MS,
  type CreateReturnsClientDeps,
} from './returns-client.js';
import { createReturnsCloseService } from './returns-close-service.js';
import { createReturnsDispatcher } from './returns-dispatch.js';
import { createLateCommitDetector, type LateCommitDetector } from './returns-late-commit.js';
import {
  createReturnDispositionsRepository,
  type ReturnDispositionsRepository,
} from './returns-dispositions-repository.js';
import { createReturnsPayoutService } from './returns-payout.js';
import {
  createReturnPayoutsRepository,
  type ReturnPayoutsRepository,
} from './returns-payout-repository.js';
import { createReturnExecutionsDispatcher } from './returns-execution-dispatch.js';
import { createExecutionEnqueuer } from './returns-execution-enqueue.js';
import { createReturnExecutionsRepository } from './returns-execution-repository.js';
import { createReturnOriginRepository } from './returns-origin-repository.js';
import {
  createReturnsRepository,
  type JournalEntry,
  type ReturnScope,
} from './returns-repository.js';
import {
  RETURN_QUIET_PERIOD_MS,
  createReturnQuietPeriod,
  type QuietPeriodClocks,
} from './returns-quiet-period.js';
import { createReturnsResolver, type ReturnsResolver } from './returns-resolver.js';
import {
  createReturnsAuthorizer,
  type ReturnsAuthorizer,
  type ReturnsSession,
} from './returns-auth.js';
import { createReturnsService } from './returns-service.js';
import {
  createStatusReadAvailability,
  type StatusReadAvailability,
} from './returns-status-availability.js';
import { createReturnsStatusClient } from './returns-status-client.js';
import { toJournalView } from './returns-views.js';
import { newReturnExternalId, uuidv7 } from './uuidv7.js';

export interface ReturnsLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ComposeReturnsDeps {
  readonly db: DatabaseHandle;
  /** Backend-Core base URL and fetch. */
  readonly http: Omit<CreateReturnsClientDeps, 'timeoutMs'>;
  /**
   * The in-process operator-envelope reader. Given ONLY to the authorizer: it
   * is read when an authorization snapshot is taken and at a recheck, never by
   * the client or on a send path (RT-197 A5).
   */
  readonly getOperatorEnvelope: () => string | null;
  readonly isEnabled: () => boolean;
  /** The live operator session on the live paired terminal (null if either is absent). */
  readonly getSession: () => ReturnsSession | null;
  /**
   * RT-1498 (`0073_return_journal_origin`): provider-neutral `users.id` of the live operator (null
   * when absent). Captured on the authorization snapshot so journal inserts record the originator.
   */
  readonly getActorUserId?: () => string | null;
  /** True while the operator session is inactivity-locked (RT-117). */
  readonly isSessionLocked: () => boolean;
  readonly auditSink: ReturnsAuditSink;
  readonly logger: ReturnsLogger;
  readonly now: () => string;
  /**
   * The terminal's capture currency — the same source as the sale-sync
   * capture (`createSaleSyncClient` `currencyCode ?? DEFAULT_CURRENCY_CODE`).
   */
  readonly captureCurrencyCode?: string;
  /** RT-15 S4: the sale drawer's hardware port (the same instance sales use). */
  readonly drawer: DrawerKickTransport;
  /**
   * RT-1403 S2 (M1): the terminal's one drawer slot, shared with the void payout. Production passes
   * the terminal's; absent, the payout holds one of its own.
   */
  readonly drawerSlot?: DrawerSlot;
  /** RT-15 S4: the receipt print pipeline (the same instance sales use). */
  readonly printer: Pick<PrintPipeline, 'printRendered'>;
  /**
   * RT-1543: the terminal's open shift id — the shift whose drawer paid — read in the paid commit,
   * or null when none is open (then no refund execution is reported: the contract requires the
   * shift and none is invented).
   */
  readonly openShiftRef: (scope: ReturnScope) => string | null;
  /**
   * RT-1543 follow-up: the shift that was open on the terminal at an instant (the payout's claim),
   * or null. Read only when no shift is open now, so a payout claimed while a shift was open and
   * completed after a manager closed it still reports its execution with that shift.
   */
  readonly shiftRefAt: (scope: ReturnScope, at: string) => string | null;
  /**
   * RT-1543: true when shift cash-up is enabled for this till (`POS_PULSE_FEATURE_SHIFT_CASHUP`,
   * read per call). Only such a till can report a refund execution (the contract requires the
   * shift), so only a NEW return of such a till carries an `allocationRef`. A till without it sends
   * none, enqueues nothing, and its returns post at acceptance with untracked settlement.
   */
  readonly isShiftCashupEnabled: () => boolean;
  /**
   * RT-1498 S4/S5: what `returns.escalate` spends: the manager approval service (it consumes the
   * single-use `return.resolve_unknown` approval) and the live operator's provider-neutral
   * `users.id` (null when the session has none). Absent, escalation refuses (`approval_invalid`).
   */
  readonly escalation?: {
    readonly approvals: Pick<ManagerApprovalService, 'consume' | 'evidence'>;
    readonly userId: () => string | null;
  };
  /**
   * RT-1498 close slice: the clocks the quiet period (15 minutes of ELAPSED time) is shown with: a wall
   * clock and a monotonic one (default: `Date.now` and `performance.now`). Tests inject both.
   */
  readonly clocks?: QuietPeriodClocks;
  /**
   * RT-1498 close slice: whether the server's status read is available (the last probe was not a 404).
   * The composition root shares ONE with the close approval's subject resolver (`closeAvailable`), which
   * is built earlier; absent, the domain keeps its own.
   */
  readonly statusAvailability?: StatusReadAvailability;
}

export interface ComposedReturns {
  readonly service: ReturnsBridgeAPI;
  readonly resolver: ReturnsResolver;
  /**
   * RT-1553: a status read of each return of `saleId` the till closed as not recorded, on behalf of
   * the live returns actor (a signed-in, unlocked manager or admin with an envelope); a no-op without
   * one. A late commit blocks the sale again. Never rejects. The void lookup runs it (best effort).
   */
  readonly checkSaleLive: (saleId: string) => Promise<void>;
  /**
   * Latch the domain stopped (RT-198): every `returns.*` call answers
   * `shutting_down` before any DB access, no send starts, and work in flight
   * writes nothing when it settles (the DB closes right after). Idempotent;
   * synchronous, like every worker stop in `bootstrap-workers.ts`.
   */
  readonly stop: () => void;
}

/** Renderer views of journal rows, each with its payout and last cause (one query each). */
function viewsWithPayouts(
  payouts: ReturnPayoutsRepository,
  causes: ReturnCauseReader,
  dispositions: Pick<ReturnDispositionsRepository, 'statesOf'>,
  now: () => string,
) {
  return (entries: readonly JournalEntry[]): ReturnJournalView[] => {
    const rows = payouts.readMany(entries.map((e) => e.returnId));
    const unresolved = entries.filter((e) => e.state === 'pending' || e.state === 'unknown');
    const ids = unresolved.map((e) => e.returnId);
    const lastCauses = causes.lastCauses(ids);
    const states = dispositions.statesOf(ids);
    const at = now();
    return entries.map((e) => {
      const state = states.get(e.returnId);
      return toJournalView(
        e,
        rows.get(e.returnId) ?? null,
        at,
        lastCauses.get(e.returnId) ?? null,
        // RT-1553: a late commit is a support state on screen (the return stays closed for the flow).
        state === undefined ? null : state === 'closed' ? 'closed' : 'needs_support',
      );
    });
  };
}

export function composeReturns(deps: ComposeReturnsDeps): ComposedReturns {
  const { now } = deps;
  let stopped = false;
  const isStopped = (): boolean => stopped;
  const transaction = <T>(fn: () => T): T => deps.db.transaction(fn)();
  const client = createReturnsClient(deps.http);
  const repo = createReturnsRepository(deps.db);
  const origins = createReturnOriginRepository(deps.db);
  const dispositions = createReturnDispositionsRepository(deps.db);
  const payouts = createReturnPayoutsRepository(deps.db);
  const views = viewsWithPayouts(payouts, createReturnCauseReader(deps.db), dispositions, now);
  const sales = bindSalesRepository(deps.db);
  const audit = createReturnsAudit({ sink: deps.auditSink, now, newEventId: randomUUID });
  // RT-530: a sale with a live void (requested, sent or confirmed) is not returnable.
  const saleVoids = createSaleVoidRepository(deps.db);
  const authorizer = createReturnsAuthorizer({
    isEnabled: deps.isEnabled,
    getSession: deps.getSession,
    ...(deps.getActorUserId === undefined ? {} : { getActorUserId: deps.getActorUserId }),
    isSessionLocked: deps.isSessionLocked,
    getEnvelope: deps.getOperatorEnvelope,
  });
  // RT-1498 close slice: every attempt is anchored for the quiet period (15 minutes of ELAPSED time).
  const quiet = createReturnQuietPeriod(deps.clocks);
  const statusAvailability = deps.statusAvailability ?? createStatusReadAvailability();
  const dispatcher = createReturnsDispatcher({
    authorizer,
    client,
    repo,
    dispositions,
    quiet,
    // RT-1498 (OD-196-6): 3 consecutive pre-replay 401/403 resends over the quiet period → support.
    authFailures: createAuthFailureStreak(deps.db, RETURN_QUIET_PERIOD_MS, deps.clocks?.mono),
    audit,
    now,
    logger: deps.logger,
    isStopped,
    transaction,
  });
  // RT-1553: the status read and the close (built before the service and the resolver, which use its
  // late-commit check).
  const closer = createReturnsCloseService({
    authorizer,
    isStopped,
    repo,
    dispositions,
    status: createReturnsStatusClient(deps.http),
    availability: statusAvailability,
    quiet,
    sends: dispatcher,
    audit,
    views,
    transaction,
    now,
    newDispositionId: uuidv7,
    ...(deps.escalation === undefined ? {} : { escalation: deps.escalation }),
    origins,
  });
  const lateCommits = createLateCommitDetector({
    repo,
    dispositions,
    checker: closer,
    now,
    isStopped,
    logger: deps.logger,
  });
  const executions = createReturnExecutionsRepository(deps.db);
  const executionDispatcher = createReturnExecutionsDispatcher({
    client,
    repo: executions,
    authorizer,
    isStopped,
    now,
    logger: deps.logger,
  });
  const resolver = createReturnsResolver({
    repo,
    dispatcher,
    authorizer,
    now,
    executions: { repo: executions, dispatcher: executionDispatcher, isStopped },
    lateCommits,
  });
  const shared = {
    authorizer,
    repo,
    dispositions,
    audit,
    transaction,
    now,
    isStopped,
    origins,
    ...(deps.escalation === undefined ? {} : { escalation: deps.escalation }),
  };
  const core = createReturnsService({
    ...shared,
    captureCurrencyCode: deps.captureCurrencyCode ?? DEFAULT_CURRENCY_CODE,
    sales,
    saleRefs: createSaleSyncStateRepo(deps.db),
    voids: { blocksReturn: (saleId) => saleVoids.liveForSale(saleId) !== null },
    client,
    dispatcher,
    resolver,
    newReturnId: randomUUID,
    newExternalId: () => newReturnExternalId(),
    newAllocationRef: () => (deps.isShiftCashupEnabled() ? uuidv7() : undefined),
    views,
    lateCommits,
    newDispositionId: uuidv7,
    recordLineDetails: (returnId, details) => {
      payouts.recordLineDetails(returnId, details);
    },
  });
  const payout = createReturnsPayoutService({
    authorizer,
    repo,
    payouts,
    sales,
    audit,
    drawer: deps.drawer,
    ...(deps.drawerSlot === undefined ? {} : { drawerSlot: deps.drawerSlot }),
    shiftRule: { enabled: deps.isShiftCashupEnabled, openShiftRef: deps.openShiftRef },
    printer: deps.printer,
    transaction,
    isStopped,
    now,
    view: (entry) => toJournalView(entry, payouts.read(entry.returnId), now()),
    enqueueExecutions: createExecutionEnqueuer({
      repo: executions,
      openShiftRef: deps.openShiftRef,
      shiftRefAt: deps.shiftRefAt,
      newExecutionRef: () => uuidv7(),
      logger: deps.logger,
    }),
    reportExecutions: (actor, returnId) => {
      executionDispatcher.sendForReturn(returnId, actor).catch((err: unknown) => {
        deps.logger.error({ err }, 'returns:execution_kick_failed');
      });
    },
  });
  const service: ReturnsBridgeAPI = {
    lookup: (req) => core.lookup(req),
    quote: (req) => core.quote(req),
    submit: (req) => core.submit(req),
    resolve: () => core.resolve(),
    list: () => core.list(),
    payout: (req) => payout.payout(req),
    reprintSlip: (req) => payout.reprintSlip(req),
    resend: (req) => core.resend(req),
    escalate: (req) => core.escalate(req),
    readStatus: (req) => closer.readStatus(req),
    close: (req) => closer.close(req),
  };
  const stop = (): void => {
    stopped = true;
  };
  const checkSaleLive = liveSaleCheck(lateCommits, authorizer, isStopped, deps.logger);
  return { service, resolver, checkSaleLive, stop };
}

/**
 * RT-1553: the late-commit check of a sale on behalf of the LIVE returns actor (a signed-in, unlocked
 * manager or admin with an envelope); a no-op without one or once stopped. Never rejects.
 */
function liveSaleCheck(
  lateCommits: Pick<LateCommitDetector, 'checkSale'>,
  authorizer: Pick<ReturnsAuthorizer, 'current'>,
  isStopped: () => boolean,
  logger: Pick<ReturnsLogger, 'error'>,
): (saleId: string) => Promise<void> {
  return async (saleId) => {
    if (isStopped()) return;
    const live = authorizer.current();
    if (live.kind !== 'ok') return;
    try {
      await lateCommits.checkSale(live.actor, saleId);
    } catch (err: unknown) {
      logger.error({ err }, 'returns:late_commit_check_failed');
    }
  };
}

/**
 * The longest the stop waits for a pass in flight: the returns client's request
 * timeout plus the drain margin, so the drain never gives up before the client
 * has aborted the request it is waiting on.
 */
export const RETURNS_DRAIN_TIMEOUT_MS = RETURNS_REQUEST_TIMEOUT_MS + DRAIN_MARGIN_MS;

export interface ScheduleResolverInput {
  readonly resolver: Pick<ReturnsResolver, 'tick' | 'drain'>;
  /** Latches the domain stopped (`ComposedReturns.stop`). */
  readonly stopDomain: () => void;
  readonly intervalMs: number;
  /** Upper bound on waiting for an in-flight pass (`RETURNS_DRAIN_TIMEOUT_MS`). */
  readonly drainTimeoutMs: number;
  readonly logger: Pick<ReturnsLogger, 'error'>;
}

/**
 * Run one resolver tick now (startup) and then every `intervalMs`. Each tick
 * resolves its scope live, so a terminal paired in-process is picked up
 * without a restart.
 *
 * Returns the worker stopper (registered in `bootstrap-workers.ts`, called
 * synchronously right before the DB closes). It clears the interval and
 * latches the domain stopped, so no send starts and an in-flight send skips
 * all local writes when it settles — closing the DB right after is safe. It
 * also returns a promise that settles when the active pass is done (bounded
 * by `drainTimeoutMs`).
 */
export function scheduleReturnsResolver(input: ScheduleResolverInput): () => Promise<void> {
  const run = (): void => {
    input.resolver.tick().catch((err: unknown) => {
      input.logger.error({ err }, 'returns_resolver:tick_unexpected');
    });
  };
  run();
  const timer = setInterval(run, input.intervalMs);
  return () => {
    clearInterval(timer);
    input.stopDomain();
    return input.resolver.drain(input.drainTimeoutMs);
  };
}
