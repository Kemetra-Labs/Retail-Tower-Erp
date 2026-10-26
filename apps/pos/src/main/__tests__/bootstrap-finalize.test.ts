import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-893 extraction 6b — static guard on the composition root (`src/main/index.ts` cannot be
 * imported under vitest: it runs `app.whenReady()` at load; same posture as
 * `bootstrap-sales-bridges`). The AD-2 finalize listener wiring moved, verbatim, out of the
 * paired-only starter in `index.ts` into `bootstrap/finalize.ts`. The paired starter itself stays
 * in `index.ts`; * the sale-sync engine wiring moved after it in extraction 6c (see `bootstrap-sale-sync`).
 */
const indexSource = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');
const finalizeSource = readFileSync(resolve(__dirname, '../bootstrap/finalize.ts'), 'utf-8');

const LATCH = "pairedWorkersLatch.register('finalize listener + sale-sync engine'";

describe('main/index.ts hands the finalize listener to bootstrap/finalize.ts', () => {
  it('calls startFinalizeListener exactly once, with the listener code gone from index.ts', () => {
    expect(indexSource.match(/startFinalizeListener\(/g)?.length ?? 0).toBe(1);
    expect(indexSource).toMatch(
      /import \{ startFinalizeListener \} from '\.\/bootstrap\/finalize\.js';/,
    );
    for (const gone of [
      /createFinalizeListener\(/,
      /bindFinalizeTransaction\(/,
      /buildFinalizeInput\(/,
      /dispatchFirstPrintOnFinalize\(/,
      /bindSaleNumberAllocator\(/,
      /bindSaleSyncOutboxRepository\(/,
      /finalize_listener:started/,
    ]) {
      expect(indexSource).not.toMatch(gone);
    }
  });

  it('does not import from index.ts', () => {
    expect(finalizeSource).not.toMatch(/from '\.\.?\/index(\.js)?'/);
  });

  it('starts the listener first inside the paired starter, before the sale-sync engine', () => {
    const latch = indexSource.indexOf(LATCH);
    const call = indexSource.indexOf('startFinalizeListener(');
    const engine = indexSource.indexOf('startSaleSyncEngine(');
    expect(latch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(latch);
    expect(engine).toBeGreaterThan(call);
  });

  it('keeps the original order: reconcile, startup recovery, start, then the stop is registered', () => {
    const at = (needle: string): number => finalizeSource.indexOf(needle);
    expect(at('settledAuditReconciler.reconcile(')).toBeGreaterThan(-1);
    expect(at('settledAuditReconciler.reconcile(')).toBeLessThan(
      at('finalizeListener.runStartupRecovery()'),
    );
    expect(at('finalizeListener.runStartupRecovery()')).toBeLessThan(
      at('finalizeListener.start()'),
    );
    expect(at('finalizeListener.start()')).toBeLessThan(
      at("workerRegistry.register('finalize listener'"),
    );
  });

  it('binds the scan and the reconcile to the same terminal id (F-007 lockstep)', () => {
    expect(finalizeSource.match(/payments006TerminalId/g)?.length ?? 0).toBe(3);
    expect(finalizeSource).toMatch(/const payments006TerminalId = pairingStatus\.terminal_id;/);
    expect(finalizeSource).toMatch(/terminal_id: payments006TerminalId,/);
  });

  it('hands the starter the handles the sales bridges returned', () => {
    expect(indexSource).toMatch(
      /startFinalizeListener\(\s*\{\s*db,\s*salesRepo,\s*saleAuditEmitter,\s*printDispatcher,\s*drawerKickDispatcher,\s*settledAuditReconciler,\s*workerRegistry,\s*mainLogger,?\s*\},\s*pairingStatus,?\s*\)/,
    );
  });
});
