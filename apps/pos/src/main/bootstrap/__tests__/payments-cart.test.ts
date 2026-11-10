import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RT-1219 (RT-893 extraction 7) — the payments + cart wiring moved verbatim out of
 * `main/index.ts`. `index.ts` cannot be imported under vitest (it runs `app.whenReady()` at module
 * load), so the moved wiring is pinned here directly: every collaborator is a recording fake, the
 * construction and registration order is checked against one shared call log, and every closure the
 * wiring hands a collaborator is invoked.
 */

const m = vi.hoisted(() => {
  const order: string[] = [];
  const names = [
    'bindCartStore',
    'createParkResume',
    'bindParkStore',
    'createCataloguePriceLookup',
    'createCartBridgeHandlers',
    'createProductRepo',
    'createCatalogueResolver',
    'registerCartParkHandlers',
    'registerCartHandlers',
    'registerPaymentsHandlers',
    'registerRecoveryHandlers',
    'resolveSessionScope',
    'createPaymentAuditEmitter',
    'bindCartPaymentEligibility',
    'bindCashShiftGate',
    'bindCheckoutReturnAllowed',
    'bindCheckoutReturnGuard',
    'createDeferredReversalResolver',
    'createPaymentAttemptFsm',
    'createTenderLineFsm',
    'createPaymentsCancelHandler',
    'createPaymentsConfirmHandler',
    'createPaymentsForceFailHandler',
    'createPaymentsReadHandler',
    'createPaymentsStartHandler',
    'createPaymentsSubscribeHandler',
    'createTenderApplyHandler',
    'createTenderReadHandler',
    'createTenderReverseHandler',
    'createIdempotencyHelper',
    'bindAttemptHasLiveTender',
    'bindCartPaymentStatus',
    'bindPaymentAttemptsRepository',
    'bindPaymentActionOutboxRepository',
    'bindPaymentTenderLinesRepository',
    'createSettledAuditReconciler',
    'createSettlementCommitter',
    'reverseVoucher',
    'createManagerRecovery',
    'createRecoveryPaymentPort',
  ] as const;
  const fns = Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
    (typeof names)[number],
    ReturnType<typeof vi.fn>
  >;
  return { order, names, fns };
});

const f = m.fns;

vi.mock('../../cart/cart-store.js', () => ({ bindCartStore: m.fns.bindCartStore }));
vi.mock('../../cart/park/park-resume.js', () => ({ createParkResume: m.fns.createParkResume }));
vi.mock('../../cart/park/park-store.js', () => ({ bindParkStore: m.fns.bindParkStore }));
vi.mock('../../cart/park/resume-diff.js', () => ({
  createCataloguePriceLookup: m.fns.createCataloguePriceLookup,
}));
vi.mock('../../cart/wire-cart-handlers.js', () => ({
  createCartBridgeHandlers: m.fns.createCartBridgeHandlers,
}));
vi.mock('../../catalogue/product-repo.js', () => ({ createProductRepo: m.fns.createProductRepo }));
vi.mock('../../catalogue/resolve-item-ref.js', () => ({
  createCatalogueResolver: m.fns.createCatalogueResolver,
}));
vi.mock('../../ipc/cart-park.js', () => ({
  registerCartParkHandlers: m.fns.registerCartParkHandlers,
}));
vi.mock('../../ipc/cart.js', () => ({ registerCartHandlers: m.fns.registerCartHandlers }));
vi.mock('../../ipc/payments.js', () => ({
  registerPaymentsHandlers: m.fns.registerPaymentsHandlers,
}));
vi.mock('../../ipc/recovery.js', () => ({
  registerRecoveryHandlers: m.fns.registerRecoveryHandlers,
}));
vi.mock('../../operator/resolve-session-scope.js', () => ({
  resolveSessionScope: m.fns.resolveSessionScope,
}));
vi.mock('../../payments/audit-emitter.js', () => ({
  createPaymentAuditEmitter: m.fns.createPaymentAuditEmitter,
}));
vi.mock('../../payments/cart-payment-eligibility.js', () => ({
  bindCartPaymentEligibility: m.fns.bindCartPaymentEligibility,
}));
vi.mock('../../payments/cash-shift-gate.js', () => ({
  bindCashShiftGate: m.fns.bindCashShiftGate,
}));
vi.mock('../../payments/checkout-return-guard.js', () => ({
  bindCheckoutReturnAllowed: m.fns.bindCheckoutReturnAllowed,
  bindCheckoutReturnGuard: m.fns.bindCheckoutReturnGuard,
}));
vi.mock('../../payments/deferred-reversal-resolver.js', () => ({
  createDeferredReversalResolver: m.fns.createDeferredReversalResolver,
}));
vi.mock('../../payments/fsm/payment-attempt-fsm.js', () => ({
  createPaymentAttemptFsm: m.fns.createPaymentAttemptFsm,
}));
vi.mock('../../payments/fsm/tender-line-fsm.js', () => ({
  createTenderLineFsm: m.fns.createTenderLineFsm,
}));
vi.mock('../../payments/handlers/payments-cancel.js', () => ({
  createPaymentsCancelHandler: m.fns.createPaymentsCancelHandler,
}));
vi.mock('../../payments/handlers/payments-confirm.js', () => ({
  createPaymentsConfirmHandler: m.fns.createPaymentsConfirmHandler,
}));
vi.mock('../../payments/handlers/payments-force-fail.js', () => ({
  createPaymentsForceFailHandler: m.fns.createPaymentsForceFailHandler,
}));
vi.mock('../../payments/handlers/payments-read.js', () => ({
  createPaymentsReadHandler: m.fns.createPaymentsReadHandler,
}));
vi.mock('../../payments/handlers/payments-start.js', () => ({
  createPaymentsStartHandler: m.fns.createPaymentsStartHandler,
}));
vi.mock('../../payments/handlers/payments-subscribe.js', () => ({
  createPaymentsSubscribeHandler: m.fns.createPaymentsSubscribeHandler,
}));
vi.mock('../../payments/handlers/tender-apply.js', () => ({
  createTenderApplyHandler: m.fns.createTenderApplyHandler,
}));
vi.mock('../../payments/handlers/tender-read.js', () => ({
  createTenderReadHandler: m.fns.createTenderReadHandler,
}));
vi.mock('../../payments/handlers/tender-reverse.js', () => ({
  createTenderReverseHandler: m.fns.createTenderReverseHandler,
}));
vi.mock('../../payments/idempotency.js', () => ({
  createIdempotencyHelper: m.fns.createIdempotencyHelper,
}));
vi.mock('../../payments/repositories/payment-attempts.repository.js', () => ({
  bindAttemptHasLiveTender: m.fns.bindAttemptHasLiveTender,
  bindCartPaymentStatus: m.fns.bindCartPaymentStatus,
  bindPaymentAttemptsRepository: m.fns.bindPaymentAttemptsRepository,
}));
vi.mock('../../payments/repositories/payment-action-outbox.repository.js', () => ({
  bindPaymentActionOutboxRepository: m.fns.bindPaymentActionOutboxRepository,
}));
vi.mock('../../payments/repositories/payment-tender-lines.repository.js', () => ({
  bindPaymentTenderLinesRepository: m.fns.bindPaymentTenderLinesRepository,
}));
vi.mock('../../payments/settled-audit-reconciler.js', () => ({
  createSettledAuditReconciler: m.fns.createSettledAuditReconciler,
}));
vi.mock('../../payments/settlement-commit.js', () => ({
  createSettlementCommitter: m.fns.createSettlementCommitter,
}));
vi.mock('../../payments/voucher-authority-client/reverse.js', () => ({
  reverseVoucher: m.fns.reverseVoucher,
}));
vi.mock('../../recovery/manager-recovery.js', () => ({
  createManagerRecovery: m.fns.createManagerRecovery,
  createRecoveryPaymentPort: m.fns.createRecoveryPaymentPort,
}));

import {
  registerCart,
  registerPayments,
  type PaymentsCore,
  type PaymentsDeps,
} from '../payments-cart.js';

const CARD_FLAG = 'POS_PULSE_FEATURE_CARD_TENDER';

type Fn = (...args: unknown[]) => unknown;

/** The first argument object of the last call to `fn`. */
function arg(fn: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const call = fn.mock.calls.at(-1);
  if (call === undefined) throw new Error('not called');
  return call[index] as Record<string, unknown>;
}

/** Every first argument object `fn` was called with. */
function args(fn: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fn.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

interface Harness {
  deps: PaymentsDeps;
  getCurrent: ReturnType<typeof vi.fn>;
  getCurrentTerminalId: ReturnType<typeof vi.fn>;
  insertIgnore: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  logger: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
  backendFetch: ReturnType<typeof vi.fn>;
  readSendableDeviceToken: ReturnType<typeof vi.fn>;
}

/** Composition-root dependencies as recording fakes, with a live session on terminal-1. */
function makeHarness(): Harness {
  const getCurrent = vi.fn<() => unknown>(() => ({ tenant_id: 'tenant-1' }));
  const getCurrentTerminalId = vi.fn(() => 'terminal-1');
  const insertIgnore = vi.fn();
  const signOut = vi.fn(() => Promise.resolve());
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backendFetch = vi.fn();
  const readSendableDeviceToken = vi.fn(() => Promise.resolve('device-token-sentinel'));
  const deps = {
    guardedIpcMain: { marker: 'guarded-ipc-main' },
    db: { marker: 'db' },
    operatorSessionManager: { getCurrent },
    pairingStore: { getCurrentTerminalId },
    auditEmitter: { marker: 'audit-emitter' },
    auditEventsStore: { insertIgnore },
    shippedApp: true,
    managerApprovals: { marker: 'approvals' },
    mainLogger: logger,
    apiBaseUrl: 'https://backend.example.test',
    backendFetch,
    readSendableDeviceToken,
    operatorSignOutHandler: { signOut },
    recoveryRef: { current: null },
  } as unknown as PaymentsDeps;
  return {
    deps,
    getCurrent,
    getCurrentTerminalId,
    insertIgnore,
    signOut,
    logger,
    backendFetch,
    readSendableDeviceToken,
  };
}

let resolverStart: ReturnType<typeof vi.fn>;

beforeEach(() => {
  m.order.length = 0;
  for (const name of m.names) {
    f[name].mockReset();
    f[name].mockImplementation(() => {
      m.order.push(name);
      return { marker: name };
    });
  }
  resolverStart = vi.fn(() => Promise.resolve());
  f.createDeferredReversalResolver.mockImplementation(() => {
    m.order.push('createDeferredReversalResolver');
    return { start: resolverStart };
  });
  vi.stubEnv(CARD_FLAG, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registerCart', () => {
  it('builds the payments core before the cart handlers, then registers cart:* before Park', () => {
    const h = makeHarness();
    registerCart(h.deps);
    const at = (name: string): number => m.order.indexOf(name);
    expect(at('createCatalogueResolver')).toBeLessThan(at('bindPaymentAttemptsRepository'));
    expect(at('bindPaymentAttemptsRepository')).toBeLessThan(at('createPaymentAttemptFsm'));
    expect(at('createPaymentAttemptFsm')).toBeLessThan(at('createTenderLineFsm'));
    expect(at('createTenderLineFsm')).toBeLessThan(at('createIdempotencyHelper'));
    expect(at('createIdempotencyHelper')).toBeLessThan(at('createPaymentAuditEmitter'));
    expect(at('createPaymentAuditEmitter')).toBeLessThan(at('createSettledAuditReconciler'));
    expect(at('createSettledAuditReconciler')).toBeLessThan(at('bindCheckoutReturnGuard'));
    expect(at('bindCheckoutReturnGuard')).toBeLessThan(at('createCartBridgeHandlers'));
    expect(at('createCartBridgeHandlers')).toBeLessThan(at('registerCartHandlers'));
    expect(at('registerCartHandlers')).toBeLessThan(at('registerCartParkHandlers'));
    expect(f.registerPaymentsHandlers).not.toHaveBeenCalled();
    expect(f.registerRecoveryHandlers).not.toHaveBeenCalled();
  });

  it('returns the core it built, for registerPayments and the later steps', () => {
    const h = makeHarness();
    const core = registerCart(h.deps);
    expect(core).toEqual({
      paymentsAttemptsRepo: { marker: 'bindPaymentAttemptsRepository' },
      paymentsLinesRepo: { marker: 'bindPaymentTenderLinesRepository' },
      paymentAttemptFsm: { marker: 'createPaymentAttemptFsm' },
      tenderLineFsm: { marker: 'createTenderLineFsm' },
      paymentsIdempotency: { marker: 'createIdempotencyHelper' },
      paymentAuditEmitter: { marker: 'createPaymentAuditEmitter' },
      settledAuditReconciler: { marker: 'createSettledAuditReconciler' },
      forwardAuditEvent: expect.any(Function) as unknown,
    });
  });

  it('binds every repository and both FSMs to the one database and outbox', () => {
    const h = makeHarness();
    registerCart(h.deps);
    for (const bind of [
      f.bindPaymentAttemptsRepository,
      f.bindPaymentTenderLinesRepository,
      f.bindPaymentActionOutboxRepository,
    ]) {
      expect(bind).toHaveBeenCalledWith(h.deps.db);
    }
    const repos = {
      db: h.deps.db,
      attempts: { marker: 'bindPaymentAttemptsRepository' },
      lines: { marker: 'bindPaymentTenderLinesRepository' },
      outbox: { marker: 'bindPaymentActionOutboxRepository' },
    };
    expect(f.createPaymentAttemptFsm).toHaveBeenCalledWith(repos);
    expect(f.createTenderLineFsm).toHaveBeenCalledWith(repos);
    expect(f.createIdempotencyHelper).toHaveBeenCalledWith({
      outbox: { marker: 'bindPaymentActionOutboxRepository' },
    });
    expect(arg(f.bindCheckoutReturnGuard)).toEqual({
      db: h.deps.db,
      paymentAttemptFsm: { marker: 'createPaymentAttemptFsm' },
      auditEmitter: { marker: 'createPaymentAuditEmitter' },
    });
  });

  it('scopes the catalogue resolver to the live session tenant, or empty with no session', () => {
    const h = makeHarness();
    registerCart(h.deps);
    const { getTenantId, repo } = arg(f.createCatalogueResolver) as {
      getTenantId: () => string;
      repo: unknown;
    };
    expect(repo).toEqual({ marker: 'createProductRepo' });
    expect(getTenantId()).toBe('tenant-1');
    h.getCurrent.mockReturnValue(null);
    expect(getTenantId()).toBe('');
  });

  it('forwards payment and sale audit events into audit_events with the 004 field mapping', () => {
    const h = makeHarness();
    const core = registerCart(h.deps);
    expect(arg(f.createPaymentAuditEmitter)).toEqual({ sink: { write: core.forwardAuditEvent } });
    core.forwardAuditEvent({
      tenant_id: 't',
      branch_id: 'b',
      originating_terminal_id: 'term',
      attribution_operator_id: 'op',
      session_id: 's',
      action_category: 'payment.settled',
      created_at: '2026-11-06T00:00:00.000Z',
      payload: { a: 1 },
    } as unknown as Parameters<PaymentsCore['forwardAuditEvent']>[0]);
    expect(h.insertIgnore).toHaveBeenCalledWith({
      event_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      tenant_id: 't',
      branch_id: 'b',
      originating_terminal_id: 'term',
      acting_operator_id: 'op',
      session_id: 's',
      shift_id: null,
      action_category: 'payment.settled',
      created_at: '2026-11-06T00:00:00.000Z',
      approving_supervisor_id: null,
      payload: { a: 1 },
    });
  });

  it('gives the settled-audit reconciler the lines repo, the payment audit and an ISO clock', () => {
    const h = makeHarness();
    registerCart(h.deps);
    const deps = arg(f.createSettledAuditReconciler) as Record<string, unknown> & {
      now: () => string;
    };
    expect(deps.db).toBe(h.deps.db);
    expect(deps.linesRepo).toEqual({ marker: 'bindPaymentTenderLinesRepository' });
    expect(deps.auditEmitter).toEqual({ marker: 'createPaymentAuditEmitter' });
    expect(deps.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('wires the cart handlers with the shipped identity, approvals and payment reads', () => {
    const h = makeHarness();
    registerCart(h.deps);
    const deps = arg(f.createCartBridgeHandlers) as Record<string, unknown> & {
      getCurrentSession: Fn;
      getTerminalId: Fn;
    };
    expect(deps).toMatchObject({
      dbHandle: h.deps.db,
      logger: h.deps.mainLogger,
      auditEmitter: h.deps.auditEmitter,
      isPackaged: true,
      productionResolver: { marker: 'createCatalogueResolver' },
      cartPaymentStatus: { marker: 'bindCartPaymentStatus' },
      releaseCheckoutPayment: { marker: 'bindCheckoutReturnGuard' },
      checkoutReturnAllowed: { marker: 'bindCheckoutReturnAllowed' },
      approvals: h.deps.managerApprovals,
    });
    expect(deps.getCurrentSession()).toEqual({ tenant_id: 'tenant-1' });
    expect(deps.getTerminalId()).toBe('terminal-1');
    expect(f.registerCartHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      handlers: { marker: 'createCartBridgeHandlers' },
    });
  });

  it('registers Park on the guarded ipcMain over its own store and the catalogue prices', () => {
    const h = makeHarness();
    registerCart(h.deps);
    expect(f.registerCartParkHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      parkResume: { marker: 'createParkResume' },
    });
    const deps = arg(f.createParkResume) as Record<string, unknown> & {
      getCurrentSession: Fn;
      getTerminalId: Fn;
    };
    expect(deps).toMatchObject({
      db: h.deps.db,
      store: { marker: 'bindParkStore' },
      cartStore: { marker: 'bindCartStore' },
      auditEmitter: h.deps.auditEmitter,
      prices: { marker: 'createCataloguePriceLookup' },
      logger: h.deps.mainLogger,
    });
    expect(deps.getCurrentSession()).toEqual({ tenant_id: 'tenant-1' });
    expect(deps.getTerminalId()).toBe('terminal-1');
  });
});

/** Runs `registerCart`, clears the call log, then runs `registerPayments` on its core. */
function setup(): { h: Harness; core: PaymentsCore } {
  const h = makeHarness();
  const core = registerCart(h.deps);
  m.order.length = 0;
  for (const name of m.names) f[name].mockClear();
  registerPayments(h.deps, core);
  return { h, core };
}

describe('registerPayments', () => {
  it('registers payments.*/tender.*, then recovery, then starts the deferred resolver', () => {
    setup();
    const at = (name: string): number => m.order.indexOf(name);
    expect(at('registerPaymentsHandlers')).toBeGreaterThan(-1);
    expect(at('registerPaymentsHandlers')).toBeLessThan(at('createManagerRecovery'));
    expect(at('createManagerRecovery')).toBeLessThan(at('registerRecoveryHandlers'));
    expect(at('registerRecoveryHandlers')).toBeLessThan(at('createDeferredReversalResolver'));
    expect(resolverStart).toHaveBeenCalledTimes(1);
    expect(f.registerCartHandlers).not.toHaveBeenCalled();
  });

  it('hands registerPaymentsHandlers the nine handlers on the guarded ipcMain', () => {
    const { h } = setup();
    expect(f.registerPaymentsHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      paymentsStart: { marker: 'createPaymentsStartHandler' },
      paymentsConfirm: { marker: 'createPaymentsConfirmHandler' },
      paymentsCancel: { marker: 'createPaymentsCancelHandler' },
      paymentsSubscribe: { marker: 'createPaymentsSubscribeHandler' },
      paymentsRead: { marker: 'createPaymentsReadHandler' },
      tenderApply: { marker: 'createTenderApplyHandler' },
      tenderReverse: { marker: 'createTenderReverseHandler' },
      tenderRead: { marker: 'createTenderReadHandler' },
      paymentsForceFail: { marker: 'createPaymentsForceFailHandler' },
    });
  });

  it('gives every write handler the shared write deps, with the cash shift gate', () => {
    const { h, core } = setup();
    expect(f.bindCashShiftGate).toHaveBeenCalledWith(h.deps.db);
    for (const factory of [
      f.createPaymentsStartHandler,
      f.createPaymentsConfirmHandler,
      f.createPaymentsCancelHandler,
      f.createTenderApplyHandler,
      f.createTenderReverseHandler,
      f.createPaymentsForceFailHandler,
    ]) {
      expect(arg(factory)).toMatchObject({
        attemptsRepo: core.paymentsAttemptsRepo,
        linesRepo: core.paymentsLinesRepo,
        idempotency: core.paymentsIdempotency,
        auditEmitter: core.paymentAuditEmitter,
        cashShiftGate: { marker: 'bindCashShiftGate' },
      });
    }
    expect(arg(f.createPaymentsStartHandler)).toMatchObject({
      paymentAttemptFsm: core.paymentAttemptFsm,
      checkCartForPayment: { marker: 'bindCartPaymentEligibility' },
      attemptHasLiveTender: { marker: 'bindAttemptHasLiveTender' },
    });
    expect(arg(f.createPaymentsForceFailHandler)).toMatchObject({
      attemptHasLiveTender: { marker: 'bindAttemptHasLiveTender' },
    });
    expect(arg(f.createTenderApplyHandler)).toMatchObject({ tenderLineFsm: core.tenderLineFsm });
    expect(arg(f.createTenderReverseHandler)).toMatchObject({ tenderLineFsm: core.tenderLineFsm });
    expect(arg(f.createPaymentsConfirmHandler)).toMatchObject({
      settlement: { marker: 'createSettlementCommitter' },
      settledAuditReconciler: core.settledAuditReconciler,
    });
    expect(arg(f.createSettlementCommitter)).toEqual({
      db: h.deps.db,
      paymentAttemptFsm: core.paymentAttemptFsm,
      attemptsRepo: core.paymentsAttemptsRepo,
      auditEmitter: core.paymentAuditEmitter,
    });
  });

  it('gives the read handlers only the read deps', () => {
    const { core } = setup();
    for (const factory of [
      f.createPaymentsSubscribeHandler,
      f.createPaymentsReadHandler,
      f.createTenderReadHandler,
    ]) {
      expect(Object.keys(arg(factory)).sort()).toEqual([
        'attemptsRepo',
        'getCurrentSession',
        'linesRepo',
      ]);
      expect(arg(factory).attemptsRepo).toBe(core.paymentsAttemptsRepo);
    }
  });

  it('scopes payments to the live session on the real paired terminal id', () => {
    const { h } = setup();
    const { getCurrentSession } = arg(f.createPaymentsReadHandler) as { getCurrentSession: Fn };
    f.resolveSessionScope.mockReturnValue({ scope: 'resolved' });
    expect(getCurrentSession()).toEqual({ scope: 'resolved' });
    expect(f.resolveSessionScope).toHaveBeenLastCalledWith({ tenant_id: 'tenant-1' }, 'terminal-1');
    expect(h.getCurrentTerminalId).toHaveBeenCalled();
  });

  it('gives the handlers a wall clock and a fresh uuid per call', () => {
    setup();
    const start = arg(f.createPaymentsStartHandler) as { clock: () => Date; uuid: () => string };
    expect(start.clock()).toBeInstanceOf(Date);
    expect(start.uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(start.uuid()).not.toBe(start.uuid());
  });

  it('reads POS_PULSE_FEATURE_CARD_TENDER on every call, not once at boot', () => {
    setup();
    const { isCardTenderEnabled } = arg(f.createTenderApplyHandler) as {
      isCardTenderEnabled: () => boolean;
    };
    expect(isCardTenderEnabled()).toBe(false);
    vi.stubEnv(CARD_FLAG, 'true');
    expect(isCardTenderEnabled()).toBe(true);
  });

  it('binds the manager recovery into recoveryRef and registers its channels', () => {
    const { h } = setup();
    expect(h.deps.recoveryRef.current).toEqual({ marker: 'createManagerRecovery' });
    expect(f.registerRecoveryHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      recovery: { marker: 'createManagerRecovery' },
      logger: h.deps.mainLogger,
    });
    const deps = arg(f.createManagerRecovery) as Record<string, unknown> & {
      getSession: Fn;
      resolveTerminalId: Fn;
      endRecoverySession: Fn;
    };
    expect(deps).toMatchObject({
      db: h.deps.db,
      approvals: h.deps.managerApprovals,
      cartStore: { marker: 'bindCartStore' },
      payments: { marker: 'createRecoveryPaymentPort' },
      auditEmitter: h.deps.auditEmitter,
      logger: h.deps.mainLogger,
    });
    expect(deps.getSession()).toEqual({ tenant_id: 'tenant-1' });
    expect(deps.resolveTerminalId()).toBe('terminal-1');
    void deps.endRecoverySession();
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it('builds the recovery payment port from the same handlers under the recovery session', () => {
    const { core } = setup();
    const build = f.createRecoveryPaymentPort.mock.calls.at(-1)?.[0] as (
      getCurrentSession: () => unknown,
    ) => Record<string, unknown>;
    for (const name of m.names) f[name].mockClear();
    const recoverySession = (): unknown => ({ recovery: true });
    const port = build(recoverySession);
    expect(port).toEqual({
      apply: { marker: 'createTenderApplyHandler' },
      confirm: { marker: 'createPaymentsConfirmHandler' },
      cancel: { marker: 'createPaymentsCancelHandler' },
    });
    for (const factory of [
      f.createTenderApplyHandler,
      f.createPaymentsConfirmHandler,
      f.createPaymentsCancelHandler,
    ]) {
      expect(arg(factory)).toMatchObject({
        getCurrentSession: recoverySession,
        cashShiftGate: { marker: 'bindCashShiftGate' },
        auditEmitter: core.paymentAuditEmitter,
      });
    }
    expect(arg(f.createTenderApplyHandler)).toMatchObject({
      tenderLineFsm: core.tenderLineFsm,
      isCardTenderEnabled: expect.any(Function) as unknown,
    });
    expect(arg(f.createPaymentsConfirmHandler)).toMatchObject({
      settledAuditReconciler: core.settledAuditReconciler,
    });
  });
});

describe('registerPayments, deferred voucher-reversal resolver', () => {
  it('wires the resolver to the payments core, a forwarding logger and the payments clock', () => {
    const { h, core } = setup();
    const deps = arg(f.createDeferredReversalResolver) as Record<string, unknown> & {
      logger: Record<'info' | 'warn' | 'error', Fn>;
      clock: () => Date;
    };
    expect(deps).toMatchObject({
      linesRepo: core.paymentsLinesRepo,
      attemptsRepo: core.paymentsAttemptsRepo,
      tenderLineFsm: core.tenderLineFsm,
      auditEmitter: core.paymentAuditEmitter,
    });
    expect(deps.clock()).toBeInstanceOf(Date);
    deps.logger.info({ a: 1 }, 'i');
    deps.logger.warn({ a: 2 }, 'w');
    deps.logger.error({ a: 3 }, 'e');
    expect(h.logger.info).toHaveBeenCalledWith({ a: 1 }, 'i');
    expect(h.logger.warn).toHaveBeenCalledWith({ a: 2 }, 'w');
    expect(h.logger.error).toHaveBeenCalledWith({ a: 3 }, 'e');
  });

  it('reverses vouchers against the Backend-Core base URL with the per-line idempotency key', async () => {
    const { h } = setup();
    const { reverseVoucher } = arg(f.createDeferredReversalResolver) as {
      reverseVoucher: (input: unknown, options: { idempotencyKey: string }) => Promise<unknown>;
    };
    f.reverseVoucher.mockResolvedValue({ kind: 'reversed' });
    await expect(reverseVoucher({ line: 1 }, { idempotencyKey: 'k-1' })).resolves.toEqual({
      kind: 'reversed',
    });
    const options = arg(f.reverseVoucher, 1) as Record<string, unknown> & {
      logger: Record<'info' | 'warn' | 'error', Fn>;
    };
    expect(f.reverseVoucher).toHaveBeenCalledWith({ line: 1 }, expect.anything());
    expect(options).toMatchObject({
      baseUrl: 'https://backend.example.test',
      fetch: h.backendFetch,
      idempotencyKey: 'k-1',
      // RT-1110: the paired terminal's sendable device token (the one read-down uses).
      getDeviceToken: h.readSendableDeviceToken,
    });
    options.logger.info({ b: 1 }, 'i');
    options.logger.warn({ b: 2 }, 'w');
    options.logger.error({ b: 3 }, 'e');
    expect(h.logger.info).toHaveBeenCalledWith({ b: 1 }, 'i');
    expect(h.logger.warn).toHaveBeenCalledWith({ b: 2 }, 'w');
    expect(h.logger.error).toHaveBeenCalledWith({ b: 3 }, 'e');
  });

  it.each([
    [new Error('boom'), 'boom'],
    ['plain', 'plain'],
  ])('logs a failed start (%s) and does not throw', async (failure, message) => {
    const h = makeHarness();
    const core = registerCart(h.deps);
    resolverStart.mockRejectedValue(failure);
    expect(() => {
      registerPayments(h.deps, core);
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(h.logger.error).toHaveBeenCalledWith(
        { error: message },
        'deferred_reversal_resolver:start_failed',
      );
    });
  });
});

describe('module surface', () => {
  it('builds the read-deps getCurrentSession through the same adapter for every read factory', () => {
    setup();
    const sessions = args(f.createPaymentsSubscribeHandler)
      .concat(args(f.createPaymentsReadHandler), args(f.createTenderReadHandler))
      .map((d) => d.getCurrentSession);
    expect(new Set(sessions).size).toBe(1);
  });
});
