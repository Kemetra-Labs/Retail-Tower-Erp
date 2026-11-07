import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
import type { AuditEmitter, AuditEventsStore } from '../audit/audit-emitter.js';
import { bindCartStore } from '../cart/cart-store.js';
import { createParkResume } from '../cart/park/park-resume.js';
import { bindParkStore } from '../cart/park/park-store.js';
import { createCataloguePriceLookup } from '../cart/park/resume-diff.js';
import { createCartBridgeHandlers } from '../cart/wire-cart-handlers.js';
import { createProductRepo } from '../catalogue/product-repo.js';
import { createCatalogueResolver } from '../catalogue/resolve-item-ref.js';
import type { DatabaseHandle } from '../db/client.js';
import { registerCartParkHandlers } from '../ipc/cart-park.js';
import { registerCartHandlers } from '../ipc/cart.js';
import { registerPaymentsHandlers } from '../ipc/payments.js';
import { registerRecoveryHandlers } from '../ipc/recovery.js';
import type { ManagerApprovalService } from '../operator/manager-approval-service.js';
import { resolveSessionScope } from '../operator/resolve-session-scope.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { SignOutHandler } from '../operator/sign-out-handler.js';
import type { PairingStore } from '../pairing/store.js';
import {
  createPaymentAuditEmitter,
  type PaymentAuditEmitter,
  type PaymentAuditEvent,
} from '../payments/audit-emitter.js';
import { bindCartPaymentEligibility } from '../payments/cart-payment-eligibility.js';
import { bindCashShiftGate } from '../payments/cash-shift-gate.js';
import {
  bindCheckoutReturnAllowed,
  bindCheckoutReturnGuard,
} from '../payments/checkout-return-guard.js';
import { createDeferredReversalResolver } from '../payments/deferred-reversal-resolver.js';
import {
  createPaymentAttemptFsm,
  type PaymentAttemptFsm,
} from '../payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm, type TenderLineFsm } from '../payments/fsm/tender-line-fsm.js';
import { createPaymentsCancelHandler } from '../payments/handlers/payments-cancel.js';
import { createPaymentsConfirmHandler } from '../payments/handlers/payments-confirm.js';
import { createPaymentsForceFailHandler } from '../payments/handlers/payments-force-fail.js';
import { createPaymentsReadHandler } from '../payments/handlers/payments-read.js';
import { createPaymentsStartHandler } from '../payments/handlers/payments-start.js';
import { createPaymentsSubscribeHandler } from '../payments/handlers/payments-subscribe.js';
import { createTenderApplyHandler } from '../payments/handlers/tender-apply.js';
import { createTenderReadHandler } from '../payments/handlers/tender-read.js';
import { createTenderReverseHandler } from '../payments/handlers/tender-reverse.js';
import { createIdempotencyHelper, type IdempotencyHelper } from '../payments/idempotency.js';
import {
  bindAttemptHasLiveTender,
  bindCartPaymentStatus,
  bindPaymentAttemptsRepository,
  type PaymentAttemptsRepository,
} from '../payments/repositories/payment-attempts.repository.js';
import { bindPaymentActionOutboxRepository } from '../payments/repositories/payment-action-outbox.repository.js';
import {
  bindPaymentTenderLinesRepository,
  type PaymentTenderLinesRepository,
} from '../payments/repositories/payment-tender-lines.repository.js';
import type { OperatorSessionForPayments } from '../payments/require-operator-session.js';
import {
  createSettledAuditReconciler,
  type SettledAuditReconciler,
} from '../payments/settled-audit-reconciler.js';
import { createSettlementCommitter } from '../payments/settlement-commit.js';
import {
  reverseVoucher,
  type ReverseVoucherInput,
  type ReverseVoucherOutcome,
} from '../payments/voucher-authority-client/reverse.js';
import { parseFeatureFlags } from '../app/feature-flags.js';
import {
  createManagerRecovery,
  createRecoveryPaymentPort,
  type ManagerRecovery,
} from '../recovery/manager-recovery.js';
import type { SaleAuditEvent } from '../sales/audit-emitter.js';
import type { ActionCategory as Audit004ActionCategory } from '../../shared/audit/event-shape.js';

/**
 * RT-1219 (RT-893 extraction 7) — the payments + cart wiring, moved verbatim out of the
 * `singleInstanceReady.then` callback in `main/index.ts`.
 *
 * It is two calls, because the catalogue and branding read-down registers its IPC between the
 * cart channels and the payments channels; `index.ts` keeps that call in place so the IPC
 * registration order does not change:
 *
 * 1. `registerCart` builds the payments core (repositories, both FSMs, the idempotency helper, the
 *    payment audit emitter and the settled-audit reconciler) and registers `cart:*` and the Park
 *    channels. It returns the core, which `registerPayments` and later steps reuse.
 * 2. `registerPayments` registers `payments.*` / `tender.*`, the manager recovery channels, and
 *    starts the deferred voucher-reversal resolver.
 */

/** What  closes over from the composition root. */
export interface CartDeps {
  /** The lock-, recovery- and sale-boundary-guarded `ipcMain` the handlers are registered on. */
  guardedIpcMain: IpcMain;
  /** The open database handle every repository, FSM and store binds to. */
  db: DatabaseHandle;
  /** The operator session: the live session (tenant scope, lock state, attribution). */
  operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  /** The pairing store: the live paired terminal id (null while unpaired or revoked). */
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  /** The 004 audit emitter the cart and Park handlers write to. */
  auditEmitter: AuditEmitter;
  /** The 004 `audit_events` store the payment and sale audit forwarder writes to. */
  auditEventsStore: Pick<AuditEventsStore, 'insertIgnore'>;
  /** Whether this is the shipped (packaged) app; the dev catalogue fixture is refused there. */
  shippedApp: boolean;
  /** The one manager approval service (a post-handoff cancel spends an approval). */
  managerApprovals: Pick<ManagerApprovalService, 'consume'>;
  mainLogger: Logger;
}

/** What  closes over from the composition root, beyond . */
export interface PaymentsDeps extends CartDeps {
  /** The Backend-Core base URL the voucher-authority reverse client posts to. */
  apiBaseUrl: string;
  /** The reachability-observed Backend-Core fetch the voucher reverse client is built on. */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Ends the recovery-scoped session once a manager recovery completes. */
  operatorSignOutHandler: Pick<SignOutHandler, 'signOut'>;
  /**
   * RT-441: the manager recovery, bound here once it exists.  owns it (the manager
   * approval service is built before this call and reads it).
   */
  recoveryRef: { current: ManagerRecovery | null };
}

/** The payments core  builds;  and later steps reuse it. */
export interface PaymentsCore {
  paymentsAttemptsRepo: PaymentAttemptsRepository;
  paymentsLinesRepo: PaymentTenderLinesRepository;
  paymentAttemptFsm: PaymentAttemptFsm;
  tenderLineFsm: TenderLineFsm;
  paymentsIdempotency: IdempotencyHelper;
  paymentAuditEmitter: PaymentAuditEmitter;
  /** RT-496: heals or holds settlements stranded without their audit; the finalize listener uses it. */
  settledAuditReconciler: SettledAuditReconciler;
  /** Forwards a payment or sale audit event into the 004 `audit_events` table. */
  forwardAuditEvent: (evt: PaymentAuditEvent | SaleAuditEvent) => void;
}

/**
 * Builds the payments core and registers the `cart:*` and Park handlers. Called at the exact boot
 * position the inline code held in `main/index.ts`: after the operator handlers and before the
 * catalogue and branding read-down.
 */
export function registerCart(deps: CartDeps): PaymentsCore {
  const {
    guardedIpcMain,
    db,
    operatorSessionManager,
    pairingStore,
    auditEmitter,
    auditEventsStore,
    shippedApp,
    managerApprovals,
    mainLogger,
  } = deps;

  // 009-product-search-and-barcode-lookup S4 (T043) — the production R7
  // resolver. 005 left `cart.resolveItemRef` unwired (refusing stub); 009
  // wires a real read-model-backed resolver behind the SAME §A1 seam. It
  // re-reads name/price authoritatively from the catalogue (the renderer
  // supplies only `{ item_ref }`), tenant-scoped to the live session (P17).
  // The dev fixture still wins in an unpackaged build with the fixture flag
  // set (see wire-cart-handlers.ts precedence); this is the production path.
  const catalogueResolver = createCatalogueResolver({
    repo: createProductRepo(db),
    // `linesAdd` gates `no_session` before the resolver runs, so a null
    // session never reaches here; coalesce defensively so the closure's
    // `string` return is total and never throws.
    getTenantId: () => operatorSessionManager.getCurrent()?.tenant_id ?? '',
  });

  // 006-payments-tender Slice 3 (T142 + F-002/F-003/F-004) — wire the
  // payments.* + tender.* bridge surface. The 8 handler factories share
  // the three S3a repositories, both FSMs, and a single idempotency
  // helper + audit-emitter pair.
  const paymentsAttemptsRepo = bindPaymentAttemptsRepository(db);
  const paymentsLinesRepo = bindPaymentTenderLinesRepository(db);
  const paymentsOutboxRepo = bindPaymentActionOutboxRepository(db);

  const paymentAttemptFsm = createPaymentAttemptFsm({
    db: db,
    attempts: paymentsAttemptsRepo,
    lines: paymentsLinesRepo,
    outbox: paymentsOutboxRepo,
  });
  const tenderLineFsm = createTenderLineFsm({
    db: db,
    attempts: paymentsAttemptsRepo,
    lines: paymentsLinesRepo,
    outbox: paymentsOutboxRepo,
  });

  const paymentsIdempotency = createIdempotencyHelper({ outbox: paymentsOutboxRepo });

  // Adapter — the payments and sales emitters write their own event shapes;
  // both forward to 004's `audit_events` table via the shared
  // `AuditEventsStore.insertIgnore` with the same field mapping. F-006:
  // 004's `ActionCategory` union does not yet include the 7 payment
  // categories at the TypeScript level (migration 0017 extends the SQL
  // CHECK only). The cast lives at this single seam and is bounded by the
  // migration's CHECK; a future PR by 004's owner should extend
  // `AUDIT_ACTION_CATEGORIES`.
  const forwardAuditEvent = (evt: PaymentAuditEvent | SaleAuditEvent): void => {
    auditEventsStore.insertIgnore({
      event_id: randomUUID(),
      tenant_id: evt.tenant_id,
      branch_id: evt.branch_id,
      originating_terminal_id: evt.originating_terminal_id,
      acting_operator_id: evt.attribution_operator_id,
      session_id: evt.session_id,
      shift_id: null,
      action_category: evt.action_category as unknown as Audit004ActionCategory,
      created_at: evt.created_at,
      approving_supervisor_id: null,
      payload: evt.payload,
    });
  };
  const paymentAuditEmitter = createPaymentAuditEmitter({
    sink: { write: forwardAuditEvent },
  });
  // RT-496 — heals (or holds for manual review) settled attempts stranded
  // without their `payment.settled` audit. Run at startup before the
  // finalize listener, and on a same-key `payments.confirm` replay.
  const settledAuditReconciler = createSettledAuditReconciler({
    db,
    linesRepo: paymentsLinesRepo,
    auditEmitter: paymentAuditEmitter,
    now: () => new Date().toISOString(),
  });

  // RT-26 — Checkout Back: the payments record decides whether a handed-off
  // cart may return to the Sale (no tender, no settled / force-failed payment)
  // and cancels a zero-funds started attempt inside the cart transaction.
  const releaseCheckoutPayment = bindCheckoutReturnGuard({
    db,
    paymentAttemptFsm,
    auditEmitter: paymentAuditEmitter,
  });

  // 005-sales-cart S2 — register `cart:*` IPC with DB-backed CartStore.
  const cartBridgeHandlers = createCartBridgeHandlers({
    dbHandle: db,
    getCurrentSession: () => operatorSessionManager.getCurrent(),
    // #380 (F-007) — stamp cart rows with the real terminal_id, not branch_id.
    getTerminalId: () => pairingStore.getCurrentTerminalId(),
    logger: mainLogger,
    auditEmitter,
    isPackaged: shippedApp,
    productionResolver: catalogueResolver,
    // Post-handoff cancel and the snapshot "paid" flag read the payments record.
    cartPaymentStatus: bindCartPaymentStatus(db),
    releaseCheckoutPayment,
    // RT-26 — read-only twin for Checkout's Back eligibility (no writes).
    checkoutReturnAllowed: bindCheckoutReturnAllowed(db),
    // RT-443 — a cashier's post-handoff cancel consumes a manager approval.
    approvals: managerApprovals,
  });
  registerCartHandlers(guardedIpcMain, { handlers: cartBridgeHandlers });

  // RT-440 (PK-2, spec 024) — Park v1: `cart:park` / `listParked` /
  // `previewResume` / `resume`. Local only, offline; resume re-prices from
  // the local catalogue read model. `cart:` channels, so the lock, recovery
  // and sale-boundary guards cover them.
  registerCartParkHandlers(guardedIpcMain, {
    parkResume: createParkResume({
      db,
      store: bindParkStore(db),
      cartStore: bindCartStore(db),
      getCurrentSession: () => operatorSessionManager.getCurrent(),
      getTerminalId: () => pairingStore.getCurrentTerminalId(),
      auditEmitter,
      prices: createCataloguePriceLookup(createProductRepo(db)),
      logger: mainLogger,
    }),
  });

  return {
    paymentsAttemptsRepo,
    paymentsLinesRepo,
    paymentAttemptFsm,
    tenderLineFsm,
    paymentsIdempotency,
    paymentAuditEmitter,
    settledAuditReconciler,
    forwardAuditEvent,
  };
}

/**
 * Registers the `payments.*` / `tender.*` handlers and the manager recovery channels, and starts
 * the deferred voucher-reversal resolver. Called at the exact boot position the inline code held
 * in `main/index.ts`: after the catalogue and branding read-down and before the printer ports.
 */
export function registerPayments(deps: PaymentsDeps, core: PaymentsCore): void {
  const {
    guardedIpcMain,
    db,
    operatorSessionManager,
    pairingStore,
    auditEmitter,
    managerApprovals,
    mainLogger,
    operatorSignOutHandler,
    recoveryRef,
  } = deps;
  const {
    paymentsAttemptsRepo,
    paymentsLinesRepo,
    paymentAttemptFsm,
    tenderLineFsm,
    paymentsIdempotency,
    paymentAuditEmitter,
    settledAuditReconciler,
  } = core;

  const paymentsSessionAdapter = (): OperatorSessionForPayments | null =>
    // #380 (F-007 FIXED) — stamp the REAL terminal_id from the pairing store,
    // NOT session.branch_id (the retired shortcut that collapsed every
    // terminal at a branch into one payment scope so one stuck attempt
    // bricked them all). resolveSessionScope is the extracted, unit-tested
    // seam shared with the sales adapter; returns null on no-session OR
    // unpaired. display_name flows through for 008 T094b's settled audit.
    resolveSessionScope(operatorSessionManager.getCurrent(), pairingStore.getCurrentTerminalId());

  const paymentsClock = (): Date => new Date();
  const paymentsUuid = (): string => randomUUID();

  // Shared dependency bundles for the payments/tender handler factories —
  // each factory destructures only the keys it declares.
  const paymentsReadDeps = {
    getCurrentSession: paymentsSessionAdapter,
    attemptsRepo: paymentsAttemptsRepo,
    linesRepo: paymentsLinesRepo,
  };
  const paymentsWriteDeps = {
    ...paymentsReadDeps,
    idempotency: paymentsIdempotency,
    auditEmitter: paymentAuditEmitter,
    clock: paymentsClock,
    cashShiftGate: bindCashShiftGate(db), // RT-998: cash needs an open shift (apply + settle)
  };

  const paymentsStart = createPaymentsStartHandler({
    ...paymentsWriteDeps,
    paymentAttemptFsm,
    uuid: paymentsUuid,
    // §A4: main decides if the cart may be paid (handed off, in scope, matches, unpaid).
    checkCartForPayment: bindCartPaymentEligibility(db),
    // §A4: never discard another cart's attempt while it holds tender.
    attemptHasLiveTender: bindAttemptHasLiveTender(db),
  });
  // RT-496 — the settle and its `payment.settled` audit commit in one
  // transaction (the audit sink writes to this same `db`, synchronously);
  // the reconciler heals or holds settlements stranded before that fix.
  const paymentsSettleDeps = {
    settlement: createSettlementCommitter({
      db,
      paymentAttemptFsm,
      attemptsRepo: paymentsAttemptsRepo,
      auditEmitter: paymentAuditEmitter,
    }),
    settledAuditReconciler,
  };
  const paymentsConfirm = createPaymentsConfirmHandler({
    ...paymentsWriteDeps,
    ...paymentsSettleDeps,
    paymentAttemptFsm,
  });
  const paymentsCancel = createPaymentsCancelHandler({
    ...paymentsWriteDeps,
    paymentAttemptFsm,
  });
  const paymentsSubscribe = createPaymentsSubscribeHandler(paymentsReadDeps);
  const paymentsRead = createPaymentsReadHandler(paymentsReadDeps);
  // RT-700 (P-26-1) — card refused in main while the flag is off; read per call.
  const isCardTenderEnabled = (): boolean => parseFeatureFlags(process.env).cardTender;
  const tenderApply = createTenderApplyHandler({
    ...paymentsWriteDeps,
    tenderLineFsm,
    uuid: paymentsUuid,
    logger: mainLogger,
    isCardTenderEnabled,
  });
  const tenderReverse = createTenderReverseHandler({
    ...paymentsWriteDeps,
    tenderLineFsm,
  });
  const tenderRead = createTenderReadHandler(paymentsReadDeps);
  const paymentsForceFail = createPaymentsForceFailHandler({
    ...paymentsWriteDeps,
    paymentAttemptFsm,
    // RT-441 — restricted: an attempt holding live tender goes to recovery.
    attemptHasLiveTender: bindAttemptHasLiveTender(db),
  });

  registerPaymentsHandlers(guardedIpcMain, {
    paymentsStart,
    paymentsConfirm,
    paymentsCancel,
    paymentsSubscribe,
    paymentsRead,
    tenderApply,
    tenderReverse,
    tenderRead,
    paymentsForceFail,
  });

  // RT-441 (RT-116 S6, §5) — manager recovery. Its payment calls run the
  // same handlers under a recovery-scoped session (the stuck attempt's own
  // session id), set only for the duration of one call after the approval
  // is consumed; normal calls keep their own session gate.
  const managerRecovery = createManagerRecovery({
    db,
    getSession: () => operatorSessionManager.getCurrent(),
    resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
    approvals: managerApprovals,
    cartStore: bindCartStore(db),
    payments: createRecoveryPaymentPort((getCurrentSession) => {
      const scoped = { ...paymentsWriteDeps, getCurrentSession };
      return {
        apply: createTenderApplyHandler({
          ...scoped,
          tenderLineFsm,
          uuid: paymentsUuid,
          logger: mainLogger,
          isCardTenderEnabled,
        }),
        confirm: createPaymentsConfirmHandler({
          ...scoped,
          ...paymentsSettleDeps,
          paymentAttemptFsm,
        }),
        cancel: createPaymentsCancelHandler({ ...scoped, paymentAttemptFsm }),
      };
    }),
    auditEmitter,
    endRecoverySession: () => operatorSignOutHandler.signOut(),
    logger: mainLogger,
  });
  recoveryRef.current = managerRecovery;
  registerRecoveryHandlers(guardedIpcMain, { recovery: managerRecovery, logger: mainLogger });

  // RT-442 (RT-116 S5, §9) — the #380 session-end / sign-in reversal sweep
  // is retired: no session end ever reverses tender. A zero-funds attempt is
  // closed and a live-tender attempt is held for its owner by the held-cart
  // lifecycle (`payments/held-attempts.ts`); nothing runs at boot (§6).

  startDeferredReversalResolver(deps, core, paymentsClock);
}

/**
 * The last step of `registerPayments`, in the same position: starts the 006 T271 deferred
 * voucher-reversal resolver on the payments clock.
 */
function startDeferredReversalResolver(
  deps: PaymentsDeps,
  core: PaymentsCore,
  paymentsClock: () => Date,
): void {
  const { mainLogger, apiBaseUrl, backendFetch } = deps;
  const { paymentsLinesRepo, paymentsAttemptsRepo, tenderLineFsm, paymentAuditEmitter } = core;

  // 006 T271 — deferred-reversal resolver bootstrap.
  //
  // The resolver scans `payment_tender_lines` for `reversal_pending`
  // voucher lines and retries `vouchers.reverse` against V-A. It runs
  // on (a) app start, (b) future 003 network-restore signal, (c)
  // explicit cashier retry (no bridge surface yet).
  //
  // **Production wiring (PR #222 fixup — CR-1).** The V-A reverse
  // client is wired here using the same `apiBaseUrl` + `fetch` seam
  // the operator backend already uses. The resolver supplies the
  // per-line `idempotencyKey` (derived from `tender_line_id`); the
  // closure bakes in baseUrl / fetch / logger.
  //
  // The 003 network-restore signal is still TBD (no network module
  // yet); the resolver runs without it via (a) app-start and (c)
  // the manual-retry entry point.
  const reverseVoucherForResolver = async (
    input: ReverseVoucherInput,
    options: { idempotencyKey: string },
  ): Promise<ReverseVoucherOutcome> => {
    return await reverseVoucher(input, {
      baseUrl: apiBaseUrl,
      fetch: backendFetch,
      logger: {
        info: (payload, msg): void => {
          mainLogger.info(payload, msg);
        },
        warn: (payload, msg): void => {
          mainLogger.warn(payload, msg);
        },
        error: (payload, msg): void => {
          mainLogger.error(payload, msg);
        },
      },
      idempotencyKey: options.idempotencyKey,
    });
  };
  const deferredReversalResolver = createDeferredReversalResolver({
    linesRepo: paymentsLinesRepo,
    attemptsRepo: paymentsAttemptsRepo,
    tenderLineFsm,
    auditEmitter: paymentAuditEmitter,
    reverseVoucher: reverseVoucherForResolver,
    logger: {
      info: (payload, msg): void => {
        mainLogger.info(payload, msg);
      },
      warn: (payload, msg): void => {
        mainLogger.warn(payload, msg);
      },
      error: (payload, msg): void => {
        mainLogger.error(payload, msg);
      },
    },
    clock: paymentsClock,
  });
  void deferredReversalResolver.start().catch((err: unknown) => {
    mainLogger.error(
      { error: err instanceof Error ? err.message : String(err) },
      'deferred_reversal_resolver:start_failed',
    );
  });
}
