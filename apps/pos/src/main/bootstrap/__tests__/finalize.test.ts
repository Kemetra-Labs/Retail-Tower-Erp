import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  bindSaleSyncOutboxRepository: vi.fn(),
  bindSaleNumberAllocator: vi.fn(),
  bindFinalizeTransaction: vi.fn(),
  buildFinalizeInput: vi.fn(),
  createFinalizeListener: vi.fn(),
  dispatchFirstPrintOnFinalize: vi.fn(),
}));

vi.mock('../../sync-outbox/sale-sync-outbox.repository.js', () => ({
  bindSaleSyncOutboxRepository: m.bindSaleSyncOutboxRepository,
}));
vi.mock('../../sales/sale-number-allocator.js', () => ({
  bindSaleNumberAllocator: m.bindSaleNumberAllocator,
}));
vi.mock('../../sales/finalize-transaction.js', () => ({
  bindFinalizeTransaction: m.bindFinalizeTransaction,
}));
vi.mock('../../sales/finalize-dispatch.js', () => ({
  buildFinalizeInput: m.buildFinalizeInput,
}));
vi.mock('../../sales/finalize-listener.js', () => ({
  createFinalizeListener: m.createFinalizeListener,
}));
vi.mock('../../receipts/dispatch-first-print-on-finalize.js', () => ({
  dispatchFirstPrintOnFinalize: m.dispatchFirstPrintOnFinalize,
}));

import { startFinalizeListener } from '../finalize.js';
import type { FinalizeListenerDeps } from '../finalize.js';

/**
 * RT-893 extraction 6b — the AD-2 finalize listener wiring moved verbatim out of the paired-only
 * starter in `main/index.ts`. `index.ts` cannot be imported under vitest (it runs `app.whenReady()`
 * at module load), so the moved wiring is pinned here directly, with every collaborator replaced
 * by a recording fake.
 */
const TERMINAL = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

interface ListenerDeps {
  db: unknown;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  dispatch: (handoffActionId: string) => void;
  dispatchPrintRecovery: (saleId: string) => void;
  dispatchDrawerRecovery: (saleId: string) => void;
  tickIntervalMs: number;
  now: () => string;
}

interface Harness {
  deps: FinalizeListenerDeps;
  events: string[];
  listener: { runStartupRecovery: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  stopListener: ReturnType<typeof vi.fn>;
  workersRegister: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  logger: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
}

function makeHarness(): Harness {
  const events: string[] = [];
  const stopListener = vi.fn();
  const listener = {
    runStartupRecovery: vi.fn(() => events.push('recovery')),
    start: vi.fn(() => events.push('start')),
    stop: stopListener,
  };
  const finalize = vi.fn();
  const reconcile = vi.fn(() => {
    events.push('reconcile');
    return { healed: [], unattributable: [] };
  });
  const workersRegister = vi.fn(() => events.push('register'));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  m.bindSaleSyncOutboxRepository.mockReturnValue({ marker: 'outboxRepo' });
  m.bindSaleNumberAllocator.mockReturnValue({ marker: 'allocator' });
  m.bindFinalizeTransaction.mockReturnValue({ finalize });
  m.createFinalizeListener.mockReturnValue(listener);
  m.dispatchFirstPrintOnFinalize.mockReturnValue(Promise.resolve());
  const deps = {
    db: { marker: 'db' },
    salesRepo: { marker: 'salesRepo' },
    saleAuditEmitter: { marker: 'saleAuditEmitter' },
    printDispatcher: { marker: 'printDispatcher' },
    drawerKickDispatcher: { marker: 'drawerKickDispatcher' },
    settledAuditReconciler: { reconcile },
    workerRegistry: { register: workersRegister },
    mainLogger: logger,
  } as unknown as FinalizeListenerDeps;
  return { deps, events, listener, stopListener, workersRegister, reconcile, finalize, logger };
}

function listenerDeps(): ListenerDeps {
  return m.createFinalizeListener.mock.calls[0]?.[0] as ListenerDeps;
}

describe('startFinalizeListener (RT-893 extraction 6b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles, runs the startup recovery, starts the tick, then registers the stop', () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    expect(h.events).toEqual(['reconcile', 'recovery', 'start', 'register']);
    expect(h.workersRegister).toHaveBeenCalledWith('finalize listener', expect.any(Function));
    const stop = h.workersRegister.mock.calls[0]?.[1] as () => void;
    stop();
    expect(h.stopListener).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith(
      { terminal_id: 'terminal-1' },
      'finalize_listener:started',
    );
  });

  it('binds the finalize transaction on the shared repositories and emitter', () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    expect(m.bindSaleSyncOutboxRepository).toHaveBeenCalledWith(h.deps.db);
    expect(m.bindSaleNumberAllocator).toHaveBeenCalledWith(h.deps.db);
    const txn = m.bindFinalizeTransaction.mock.calls[0]?.[0] as {
      db: unknown;
      salesRepo: unknown;
      outboxRepo: unknown;
      allocator: unknown;
      auditEmitter: unknown;
      now: () => string;
      saleIdGenerator: () => string;
      outboxRowIdGenerator: () => string;
    };
    expect(txn.db).toBe(h.deps.db);
    expect(txn.salesRepo).toBe(h.deps.salesRepo);
    expect(txn.outboxRepo).toEqual({ marker: 'outboxRepo' });
    expect(txn.allocator).toEqual({ marker: 'allocator' });
    expect(txn.auditEmitter).toBe(h.deps.saleAuditEmitter);
    expect(txn.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(txn.saleIdGenerator()).toMatch(/^[0-9a-f-]{36}$/);
    expect(txn.outboxRowIdGenerator()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('scopes the listener scan to the paired terminal, with the 200 ms tick', () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    const d = listenerDeps();
    expect(d.db).toBe(h.deps.db);
    expect(d.tenant_id).toBe('tenant-1');
    expect(d.branch_id).toBe('branch-1');
    expect(d.terminal_id).toBe('terminal-1');
    expect(d.tickIntervalMs).toBe(200);
    expect(d.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('reconciles stranded settlements for the same terminal the scan binds (F-007 lockstep)', () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    expect(h.reconcile).toHaveBeenCalledWith(TERMINAL);
    expect(listenerDeps().terminal_id).toBe(TERMINAL.terminal_id);
  });

  it('logs healed and unattributable strands, and never throws on a reconcile failure', () => {
    const h = makeHarness();
    h.reconcile.mockReturnValueOnce({ healed: ['pa-1'], unattributable: ['pa-2'] });
    startFinalizeListener(h.deps, TERMINAL);
    expect(h.logger.warn).toHaveBeenCalledWith(
      { payment_attempt_ids: ['pa-1'] },
      'settlement_reconciler:healed_stranded_settlements',
    );
    expect(h.logger.error).toHaveBeenCalledWith(
      { payment_attempt_ids: ['pa-2'] },
      'settlement_reconciler:unattributable_strand_needs_manual_review',
    );

    const failing = makeHarness();
    const boom = new Error('reconcile failed');
    failing.reconcile.mockImplementationOnce(() => {
      throw boom;
    });
    expect(() => {
      startFinalizeListener(failing.deps, TERMINAL);
    }).not.toThrow();
    expect(failing.logger.error).toHaveBeenCalledWith(
      { err: boom },
      'settlement_reconciler:failed',
    );
    expect(failing.listener.start).toHaveBeenCalledTimes(1);
  });

  it('skips a refused projection and leaves the row for the next tick', () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    m.buildFinalizeInput.mockReturnValueOnce({ kind: 'refused', reason: 'no_lines' });
    listenerDeps().dispatch('handoff-1');
    expect(m.buildFinalizeInput).toHaveBeenCalledWith({
      db: h.deps.db,
      handoff_action_id: 'handoff-1',
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      { handoff_action_id: 'handoff-1', reason: 'no_lines' },
      'finalize_dispatch:projection_refused',
    );
    expect(h.finalize).not.toHaveBeenCalled();
    expect(m.dispatchFirstPrintOnFinalize).not.toHaveBeenCalled();
  });

  it('finalizes a projected sale, then fires the first print without awaiting it', () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    const input = { marker: 'input' };
    const result = { kind: 'finalized', sale_id: 's1' };
    m.buildFinalizeInput.mockReturnValueOnce({ kind: 'projected', input });
    h.finalize.mockReturnValueOnce(result);
    listenerDeps().dispatch('handoff-2');
    expect(h.finalize).toHaveBeenCalledWith(input);
    expect(h.logger.info).toHaveBeenCalledWith(
      { handoff_action_id: 'handoff-2', kind: 'finalized' },
      'finalize_dispatch:finalized',
    );
    const [printResult, printDeps] = m.dispatchFirstPrintOnFinalize.mock.calls[0] as [
      unknown,
      {
        salesRepo: unknown;
        printDispatcher: unknown;
        drawerKickDispatcher: unknown;
        logError: (err: unknown) => void;
      },
    ];
    expect(printResult).toBe(result);
    expect(printDeps.salesRepo).toBe(h.deps.salesRepo);
    expect(printDeps.printDispatcher).toBe(h.deps.printDispatcher);
    expect(printDeps.drawerKickDispatcher).toBe(h.deps.drawerKickDispatcher);
    const infra = new Error('infra');
    printDeps.logError(infra);
    expect(h.logger.error).toHaveBeenCalledWith(
      { handoff_action_id: 'handoff-2', err: infra },
      'finalize_dispatch:print_seam_infra',
    );
  });

  it('logs an unexpected rejection of the first print instead of leaking it', async () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    const boom = new Error('print seam');
    m.buildFinalizeInput.mockReturnValueOnce({ kind: 'projected', input: {} });
    h.finalize.mockReturnValueOnce({ kind: 'finalized' });
    m.dispatchFirstPrintOnFinalize.mockReturnValueOnce(Promise.reject(boom));
    listenerDeps().dispatch('handoff-3');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.logger.error).toHaveBeenCalledWith(
      { handoff_action_id: 'handoff-3', err: boom },
      'finalize_dispatch:print_seam_unexpected',
    );
  });

  it('recovers a print through the same seam with a synthesised finalized result', async () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    listenerDeps().dispatchPrintRecovery('sale-7');
    expect(m.dispatchFirstPrintOnFinalize).toHaveBeenCalledWith(
      {
        kind: 'finalized',
        sale_id: 'sale-7',
        sale_number: '',
        receipt_number: '',
        finalized_at: '',
      },
      {
        salesRepo: h.deps.salesRepo,
        printDispatcher: h.deps.printDispatcher,
        drawerKickDispatcher: h.deps.drawerKickDispatcher,
      },
    );

    const boom = new Error('recovery');
    m.dispatchFirstPrintOnFinalize.mockReturnValueOnce(Promise.reject(boom));
    listenerDeps().dispatchPrintRecovery('sale-8');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.logger.error).toHaveBeenCalledWith(
      { sale_id: 'sale-8', err: boom },
      'finalize_recovery:print_recovery_unexpected',
    );
  });

  it('keeps the drawer recovery a logged stub', () => {
    const h = makeHarness();
    startFinalizeListener(h.deps, TERMINAL);
    listenerDeps().dispatchDrawerRecovery('sale-9');
    expect(h.logger.warn).toHaveBeenCalledWith(
      { sale_id: 'sale-9' },
      'finalize_recovery:drawer_recovery_stub',
    );
  });
});
