import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-893 extraction 6a — static guard on the composition root (`src/main/index.ts` cannot be
 * imported under vitest: it runs `app.whenReady()` at load; same posture as
 * `bootstrap-returns-sale-void`). The read-only `sales.*` bridge, the `receipts.*` bridge and the
 * sale-history handlers moved, verbatim, out of `index.ts` into `bootstrap/sales-bridges.ts`.
 * The finalize worker and the sale-sync engine stay in `index.ts` until their own extractions.
 */
const indexSource = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');
const bridgesSource = readFileSync(resolve(__dirname, '../bootstrap/sales-bridges.ts'), 'utf-8');

describe('main/index.ts hands the sales bridges to bootstrap/sales-bridges.ts', () => {
  it('calls registerSalesBridges exactly once, with the bridge code gone from index.ts', () => {
    expect(indexSource.match(/registerSalesBridges\(/g)?.length ?? 0).toBe(1);
    expect(indexSource).toMatch(
      /import \{ registerSalesBridges \} from '\.\/bootstrap\/sales-bridges\.js';/,
    );
    for (const gone of [
      /createSalesBridge\(/,
      /registerSalesHandlers\(/,
      /createReceiptsBridge\(/,
      /registerReceiptsHandlers\(/,
      /createSaleHistoryService\(/,
      /registerSaleHistoryHandlers\(/,
      /createPrintDispatcher\(/,
      /createDrawerKickDispatcher\(/,
    ]) {
      expect(indexSource).not.toMatch(gone);
    }
  });

  it('does not import from index.ts', () => {
    expect(bridgesSource).not.toMatch(/from '\.\.?\/index(\.js)?'/);
  });

  it('registers each bridge exactly once, in the original order', () => {
    const at = (needle: string): number => bridgesSource.indexOf(needle);
    for (const needle of [
      'registerSalesHandlers(guardedIpcMain',
      'registerReceiptsHandlers(guardedIpcMain',
      'registerSaleHistoryHandlers(guardedIpcMain',
    ]) {
      expect(bridgesSource.split(needle).length - 1, needle).toBe(1);
    }
    expect(at('registerSalesHandlers(')).toBeLessThan(at('registerReceiptsHandlers('));
    expect(at('registerReceiptsHandlers(')).toBeLessThan(at('registerSaleHistoryHandlers('));
  });

  it('keeps the sale-finalization flag gate and the paired latch in index.ts', () => {
    const gate = indexSource.indexOf('if (getAppConfig().features?.saleFinalization === true) {');
    const call = indexSource.indexOf('registerSalesBridges({');
    const latch = indexSource.indexOf(
      "pairedWorkersLatch.register('finalize listener + sale-sync engine'",
    );
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
    expect(latch).toBeGreaterThan(call);
  });

  it('builds the print pipeline, drawer transport and audit forwarder first', () => {
    const at = indexSource.indexOf('registerSalesBridges({');
    for (const needle of [
      'const forwardAuditEvent = ',
      'const printPipeline = trackPrintPipeline(',
      'const chosenPrinterName = ',
      'const drawerKickTransport: DrawerKickTransport =',
    ]) {
      const decl = indexSource.indexOf(needle);
      expect(decl, needle).toBeGreaterThan(-1);
      expect(decl, needle).toBeLessThan(at);
    }
  });

  it('hands the paired finalize closure the handles it reuses', () => {
    expect(indexSource).toMatch(
      /const \{ salesRepo, saleAuditEmitter, printDispatcher, drawerKickDispatcher \} =\s*registerSalesBridges\(/,
    );
  });

  it('never hardcodes the device token key or reads a token outside the sendable reader', () => {
    expect(bridgesSource).not.toMatch(/DEVICE_TOKEN_KEY/);
    expect(bridgesSource.match(/createSendableDeviceTokenRead\(/g)?.length ?? 0).toBe(1);
    expect(bridgesSource).not.toMatch(/Authorization/);
  });
});
