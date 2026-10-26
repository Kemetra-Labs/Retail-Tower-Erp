import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-893 extraction 5 — static guard on the composition root (`src/main/index.ts` cannot be
 * imported under vitest: it runs `app.whenReady()` at load; same posture as
 * `bootstrap-shift-cashup`). The `returns:*` and `saleVoid:*` wiring moved, verbatim, out of
 * `index.ts` into `bootstrap/returns.ts` and `bootstrap/sale-void.ts`.
 */
const indexSource = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');
const returnsSource = readFileSync(resolve(__dirname, '../bootstrap/returns.ts'), 'utf-8');
const saleVoidSource = readFileSync(resolve(__dirname, '../bootstrap/sale-void.ts'), 'utf-8');

describe('main/index.ts hands the returns wiring to bootstrap/returns.ts', () => {
  it('calls registerReturns exactly once, with the returns code gone from index.ts', () => {
    expect(indexSource.match(/registerReturns\(/g)?.length ?? 0).toBe(1);
    expect(indexSource).toMatch(/import \{ registerReturns \} from '\.\/bootstrap\/returns\.js';/);
    expect(indexSource).not.toMatch(/composeReturns\(/);
    expect(indexSource).not.toMatch(/scheduleReturnsResolver\(/);
    expect(indexSource).not.toMatch(/registerReturnsHandlers\(/);
  });

  it('does not import from index.ts', () => {
    expect(returnsSource).not.toMatch(/from '\.\.?\/index(\.js)?'/);
  });

  it('registers the handlers unconditionally and gates only the resolver on the flag', () => {
    expect(returnsSource.match(/registerReturnsHandlers\(/g)?.length ?? 0).toBe(1);
    expect(returnsSource).toMatch(
      /registerReturnsHandlers\(guardedIpcMain, \{ service: returnsDomain\.service \}\);\s*if \(parseFeatureFlags\(process\.env\)\.returns\) \{/,
    );
    expect(returnsSource.match(/scheduleReturnsResolver\(/g)?.length ?? 0).toBe(1);
  });
});

describe('main/index.ts hands the sale void wiring to bootstrap/sale-void.ts', () => {
  it('calls registerSaleVoid exactly once, with the sale void code gone from index.ts', () => {
    expect(indexSource.match(/registerSaleVoid\(/g)?.length ?? 0).toBe(1);
    expect(indexSource).toMatch(
      /import \{ registerSaleVoid \} from '\.\/bootstrap\/sale-void\.js';/,
    );
    expect(indexSource).not.toMatch(/composeSaleVoid\(/);
    expect(indexSource).not.toMatch(/scheduleSaleVoidSync\(/);
    expect(indexSource).not.toMatch(/registerSaleVoidHandlers\(/);
  });

  it('keeps the approval subject ref owned by index.ts, bound by the module', () => {
    expect(indexSource).toMatch(
      /const saleVoidRef: \{ current: ComposedSaleVoid \| null \} = \{ current: null \};/,
    );
    expect(indexSource).toMatch(/saleVoidRef\.current\?\.service\.approvalSubject\(input\)/);
    expect(saleVoidSource.match(/saleVoidRef\.current = saleVoidDomain;/g)?.length ?? 0).toBe(1);
  });

  it('does not import from index.ts', () => {
    expect(saleVoidSource).not.toMatch(/from '\.\.?\/index(\.js)?'/);
  });

  it('registers the handlers unconditionally and gates only the send on the flag', () => {
    expect(saleVoidSource.match(/registerSaleVoidHandlers\(/g)?.length ?? 0).toBe(1);
    expect(saleVoidSource.match(/scheduleSaleVoidSync\(/g)?.length ?? 0).toBe(1);
    expect(saleVoidSource).toMatch(
      /\}\);\s*if \(parseFeatureFlags\(process\.env\)\.saleVoid\) \{[\s\S]*scheduleSaleVoidSync\(/,
    );
  });
});

describe('boot order of the extracted wiring', () => {
  it('runs the sale void wiring, then returns, then shift cash-up, then startUpdater', () => {
    const saleVoid = indexSource.indexOf('registerSaleVoid({');
    const returns = indexSource.indexOf('registerReturns({');
    const shift = indexSource.indexOf('registerShift({');
    const updater = indexSource.indexOf('startUpdater({ updateService })');
    expect(saleVoid).toBeGreaterThan(-1);
    expect(returns).toBeGreaterThan(saleVoid);
    expect(shift).toBeGreaterThan(returns);
    expect(updater).toBeGreaterThan(shift);
  });

  it('builds the approval service, the audit forwarder and the print/drawer ports first', () => {
    const at = indexSource.indexOf('registerSaleVoid({');
    for (const needle of [
      'const managerApprovals = createManagerApprovalService(',
      'const forwardAuditEvent = ',
      'const printPipeline = trackPrintPipeline(',
      'const drawerKickTransport: DrawerKickTransport =',
    ]) {
      const decl = indexSource.indexOf(needle);
      expect(decl, needle).toBeGreaterThan(-1);
      expect(decl, needle).toBeLessThan(at);
    }
  });
});
