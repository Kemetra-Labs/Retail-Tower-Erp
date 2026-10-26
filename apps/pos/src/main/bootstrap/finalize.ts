import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { PairedTerminal } from '../app/paired-workers.js';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { DatabaseHandle } from '../db/client.js';
import type { SettledAuditReconciler } from '../payments/settled-audit-reconciler.js';
import { dispatchFirstPrintOnFinalize } from '../receipts/dispatch-first-print-on-finalize.js';
import { buildFinalizeInput } from '../sales/finalize-dispatch.js';
import { createFinalizeListener } from '../sales/finalize-listener.js';
import { bindFinalizeTransaction } from '../sales/finalize-transaction.js';
import { bindSaleNumberAllocator } from '../sales/sale-number-allocator.js';
import { bindSaleSyncOutboxRepository } from '../sync-outbox/sale-sync-outbox.repository.js';
import type { SalesBridges } from './sales-bridges.js';

/** What `startFinalizeListener` closes over from the composition root (RT-900 extraction 6b). */
export interface FinalizeListenerDeps {
  /** The open database handle the finalize transaction, the outbox and the listener scan use. */
  db: DatabaseHandle;
  /** The sales repository, reused from the sales bridges (read for the first print). */
  salesRepo: SalesBridges['salesRepo'];
  /** The sale audit emitter the finalize transaction writes `sale.*` events through. */
  saleAuditEmitter: SalesBridges['saleAuditEmitter'];
  /** The print dispatcher the first print and the print recovery run through. */
  printDispatcher: SalesBridges['printDispatcher'];
  /** The drawer-kick dispatcher chained after a successful first print. */
  drawerKickDispatcher: SalesBridges['drawerKickDispatcher'];
  /** RT-496: re-emits the missing `payment.settled` audit of a stranded settled attempt. */
  settledAuditReconciler: Pick<SettledAuditReconciler, 'reconcile'>;
  /** Owns the stop callback for the finalize listener, run before the DB handle closes. */
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  mainLogger: Logger;
}

/**
 * Starts the AD-2 finalize listener for the paired terminal: the finalize transaction, the
 * first-print dispatch, the RT-496 settlement reconcile, the startup recovery scan and the
 * steady-state tick. `index.ts` calls it as the first step of the paired-only starter it registers
 * on the latch (`pairedWorkersLatch.register('finalize listener + sale-sync engine', …)`), at the
 * exact position the inline code held, so a terminal that pairs mid-process runs it the same way a
 * paired boot does. The sale-sync engine wiring follows it in `bootstrap/sale-sync.ts`.
 */
export function startFinalizeListener(
  deps: FinalizeListenerDeps,
  pairingStatus: PairedTerminal,
): void {
  const {
    db,
    salesRepo,
    saleAuditEmitter,
    printDispatcher,
    drawerKickDispatcher,
    settledAuditReconciler,
    workerRegistry,
    mainLogger,
  } = deps;

  const outboxRepo = bindSaleSyncOutboxRepository(db);
  const allocator = bindSaleNumberAllocator(db);
  // saleAuditEmitter + printDispatcher + drawerKickDispatcher are built by
  // `registerSalesBridges` (T094c — unconditional handlers) and passed in; the paired
  // starter reuses them for the finalize-listener wiring.
  const finalizeTransaction = bindFinalizeTransaction({
    db: db,
    salesRepo,
    outboxRepo,
    allocator,
    auditEmitter: saleAuditEmitter,
    now: () => new Date().toISOString(),
    saleIdGenerator: () => randomUUID(),
    outboxRowIdGenerator: () => randomUUID(),
  });

  // The AD-2 dispatch closure: project the settled payment into a
  // FinalizeInput (T094b), then run the atomic finalize (T091). A
  // projection refusal is logged and skipped — the worker re-scans
  // the same row on the next tick (idempotent NOT EXISTS clause).
  // After a FRESH finalize commits, fire the first print asynchronously
  // (T273) — NOT part of the atomic transaction; the Sale is already
  // durable. Idempotent replays do NOT re-print (extracted + unit-tested
  // in dispatch-first-print-on-finalize.ts).
  const finalizeDb = db;
  const dispatch = (handoff_action_id: string): void => {
    const projected = buildFinalizeInput({ db: finalizeDb, handoff_action_id });
    if (projected.kind === 'refused') {
      mainLogger.warn(
        { handoff_action_id, reason: projected.reason },
        'finalize_dispatch:projection_refused',
      );
      return;
    }
    const result = finalizeTransaction.finalize(projected.input);
    mainLogger.info({ handoff_action_id, kind: result.kind }, 'finalize_dispatch:finalized');
    void dispatchFirstPrintOnFinalize(result, {
      salesRepo,
      printDispatcher,
      drawerKickDispatcher,
      logError: (err: unknown) => {
        mainLogger.error({ handoff_action_id, err }, 'finalize_dispatch:print_seam_infra');
      },
    }).catch((err: unknown) => {
      mainLogger.error({ handoff_action_id, err }, 'finalize_dispatch:print_seam_unexpected');
    });
  };

  // #380 (F-007 FIXED) — the AD-2 scan filters `audit_events` by
  // `originating_terminal_id`, which 006 writes as the payment attempt's
  // `terminal_id`. Post-#380 that value comes from
  // `paymentsSessionAdapter`, which now sources the REAL terminal_id from
  // `pairingStore.getCurrentTerminalId()` (= `pairingStatus.terminal_id`
  // here). The scan MUST bind the SAME value 006 wrote, or it matches
  // zero settled rows and finalizes nothing. This is the lockstep half of
  // the adapter flip — pinned by finalize-listener.f007-scope.test.ts.
  const payments006TerminalId = pairingStatus.terminal_id;
  const finalizeListener = createFinalizeListener({
    db: db,
    tenant_id: pairingStatus.tenant_id,
    branch_id: pairingStatus.branch_id,
    terminal_id: payments006TerminalId,
    dispatch,
    // Print recovery (T273): a sale that crashed before a successful
    // first print is re-attempted via the SAME print dispatcher. Reuses
    // the finalize→print seam by synthesising a `finalized` result for
    // the recovered sale_id (the seam reads the row + derives the
    // payload). The drawer-kick dispatcher is wired here too, so a
    // recovered print success chains its drawer decision exactly like a
    // live finalize (the dispatcher's readBySale guard makes it
    // idempotent — a sale that already has a drawer row is a no-op).
    dispatchPrintRecovery: (sale_id: string): void => {
      void dispatchFirstPrintOnFinalize(
        { kind: 'finalized', sale_id, sale_number: '', receipt_number: '', finalized_at: '' },
        { salesRepo, printDispatcher, drawerKickDispatcher },
      ).catch((err: unknown) => {
        mainLogger.error({ sale_id, err }, 'finalize_recovery:print_recovery_unexpected');
      });
    },
    // Drawer recovery sub-scan #2 (T092): a cash-inclusive sale whose
    // print already succeeded but whose drawer never got a row (crashed
    // between print success and kick). The forward drawer-kick dispatcher
    // now exists, but driving it from recovery needs the sale-row read +
    // successful-print lookup that lives in finalize-listener territory
    // (`src/main/sales/**`, out of this S4a wave's allow-list). Tracked as
    // a follow-up; until then this logs (the sale + receipt are durable,
    // only the drawer pop is missed on the crash-recovery path).
    dispatchDrawerRecovery: (sale_id: string): void => {
      mainLogger.warn({ sale_id }, 'finalize_recovery:drawer_recovery_stub');
    },
    tickIntervalMs: 200,
    now: () => new Date().toISOString(),
  });

  // RT-496 — before the first tick: re-emit the missing `payment.settled`
  // audit of any attributable strand so the listener finalizes it; an
  // unattributable one stays held (it blocks the cash-up close) and is
  // reported for manual review. A failure here is logged, never fatal:
  // every strand it leaves is still counted by the cash-up hold.
  try {
    const reconciled = settledAuditReconciler.reconcile({
      tenant_id: pairingStatus.tenant_id,
      branch_id: pairingStatus.branch_id,
      terminal_id: payments006TerminalId,
    });
    if (reconciled.healed.length > 0) {
      mainLogger.warn(
        { payment_attempt_ids: reconciled.healed },
        'settlement_reconciler:healed_stranded_settlements',
      );
    }
    if (reconciled.unattributable.length > 0) {
      mainLogger.error(
        { payment_attempt_ids: reconciled.unattributable },
        'settlement_reconciler:unattributable_strand_needs_manual_review',
      );
    }
  } catch (err) {
    mainLogger.error({ err }, 'settlement_reconciler:failed');
  }

  // Recovery scan first (re-fires any settled-but-unfinalized rows from
  // a prior crash), then install the steady-state tick driver.
  finalizeListener.runStartupRecovery();
  finalizeListener.start();
  workerRegistry.register('finalize listener', () => {
    finalizeListener.stop();
  });
  mainLogger.info({ terminal_id: pairingStatus.terminal_id }, 'finalize_listener:started');
}
