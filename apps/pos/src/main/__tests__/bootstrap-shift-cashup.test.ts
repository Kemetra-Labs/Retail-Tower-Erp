import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-17 slice 3 part 3 — static guard on the composition root
 * (`src/main/index.ts` cannot be imported under vitest: it runs
 * `app.whenReady()` at load; same posture as `bootstrap-device-revocation`).
 *
 *  - The shift sync engine is registered behind `POS_PULSE_FEATURE_SHIFT_CASHUP`
 *    (default off) as a paired-only worker, with its stop in the worker
 *    registry (`registerShiftSync`, unit-tested in `compose-shift-sync.test.ts`).
 *  - It uses the sale-sync sources: the sendable device token (null unless
 *    paired, null once revoked), the current pairing's terminal, the live
 *    terminal resolver and the RT-215 detector.
 *  - RT-17 slice 4 part 1: the shift cash-up IPC is registered only with the
 *    flag on (`registerShiftCashupIpc`, unit-tested in `ipc/shift-cashup`),
 *    on the lock-guarded ipcMain, over the live operator session.
 *  - Part 2: the same registration carries the RT-215 pairing epoch (the
 *    revocation-aware re-check, F2), the live manager identity for the
 *    manager PIN enrolment, the session-start hook that refreshes a manager's
 *    last online sign-in (round 1 P2-1), and safeStorage for the PIN seal; a re-pair purges
 *    the other terminals' manager PIN records with the cashier ones.
 */

const indexSource = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');
// RT-893 extraction 4: the shift sync engine and the shift cash-up IPC registration moved,
// verbatim, out of `index.ts` into `bootstrap/shift.ts` (`registerShift`). Their assertions
// read that module; the forced-close handler and the PIN purge stay in `index.ts`.
const shiftSource = readFileSync(resolve(__dirname, '../bootstrap/shift.ts'), 'utf-8');

function count(pattern: RegExp): number {
  return shiftSource.match(pattern)?.length ?? 0;
}

describe('main/index.ts hands the RT-17 shift wiring to bootstrap/shift.ts', () => {
  it('calls registerShift exactly once, with the shift code gone from index.ts', () => {
    expect(indexSource.match(/registerShift\(/g)?.length ?? 0).toBe(1);
    expect(indexSource).toMatch(/import \{ registerShift \} from '\.\/bootstrap\/shift\.js';/);
    expect(indexSource).not.toMatch(/registerShiftSync\(/);
    expect(indexSource).not.toMatch(/startShiftSync\(/);
    expect(indexSource).not.toMatch(/registerShiftCashupIpc\(/);
  });

  it('keeps the boot order: after the returns wiring, before startUpdater', () => {
    const returns = indexSource.indexOf("workerRegistry.register('returns resolver'");
    const shift = indexSource.indexOf('registerShift({');
    const updater = indexSource.indexOf('startUpdater({ updateService })');
    expect(returns).toBeGreaterThan(-1);
    expect(shift).toBeGreaterThan(returns);
    expect(updater).toBeGreaterThan(shift);
  });

  it('does not import from index.ts', () => {
    expect(shiftSource).not.toMatch(/from '\.\.?\/index(\.js)?'/);
  });
});

describe('bootstrap/shift.ts wires the RT-17 shift sync engine', () => {
  it('registers the engine once, gated on the shift cash-up flag', () => {
    expect(count(/registerShiftSync\(/g)).toBe(1);
    expect(count(/startShiftSync\(/g)).toBe(1);
    expect(shiftSource).toMatch(
      /registerShiftSync\(\{\s*enabled: parseFeatureFlags\(process\.env\)\.shiftCashup,\s*pairedWorkers: pairedWorkersLatch,\s*workers: workerRegistry,/,
    );
  });

  it('uses the sale-sync device sources and the RT-215 detector', () => {
    expect(shiftSource).toMatch(
      /startShiftSync\(\{\s*db,\s*terminal,\s*client: \{\s*baseUrl: resolveApiBaseUrl\(\),\s*fetch: backendFetch,\s*detector: deviceAuthDetector,\s*getDeviceToken: readSendableDeviceToken,\s*currentTerminalId: \(\) => pairingStore\.getCurrentTerminalId\(\),\s*(?:\/\/[^\n]*\n\s*)?getEnvelope: createManagerEnvelopeReader\(\s*operatorSessionManager,\s*operatorEnvelopeHolder,?\s*\),\s*\},\s*resolveTerminalId: createCurrentTerminalResolver\(\(\) => pairingStore\.getStatus\(\)\),\s*logger: mainLogger,\s*onDrainNow: \(drainNow\) => \{\s*shiftSyncDrainNowRef\.current = drainNow;\s*\},\s*\}\)/,
    );
  });

  it('RT-554 (b): sends a forced close under the manager envelope only, and kicks the drain from the handler', () => {
    // The envelope reader is the manager / admin one, never the sale-sync (any-role) reader.
    expect(shiftSource).toMatch(/getEnvelope: createManagerEnvelopeReader\(/);
    // The forced-close handler is built over the cash-up tables, with the drain-now seam.
    expect(indexSource).toMatch(
      /forcedCloseHandler: new ForcedCloseHandler\(\{[\s\S]*?shiftCashup: composeShiftCashupService\(\{[\s\S]*?\}\),\s*deliverNow: \(\) =>\s*shiftSyncDrainNowRef\.current === null\s*\? Promise\.resolve\(false\)\s*: shiftSyncDrainNowRef\.current\(\),/,
    );
  });

  it('registers the shift cash-up IPC once, only with the flag on, on the lock-guarded ipcMain', () => {
    expect(count(/registerShiftCashupIpc\(/g)).toBe(1);
    expect(shiftSource).not.toMatch(/registerShiftCashupHandlers\(/);
    expect(shiftSource).toMatch(
      /registerShiftCashupIpc\(\{\s*enabled: parseFeatureFlags\(process\.env\)\.shiftCashup,\s*ipcMain: guardedIpcMain,\s*db,\s*isEnabled: \(\) => parseFeatureFlags\(process\.env\)\.shiftCashup,/,
    );
  });

  it('gates every shift call on the live operator session on the paired terminal', () => {
    expect(shiftSource).toMatch(
      /registerShiftCashupIpc\(\{[^}]*getSession: \(\) =>\s*resolveSessionScope\(\s*operatorSessionManager\.getCurrent\(\),\s*pairingStore\.getCurrentTerminalId\(\),?\s*\),\s*isSessionLocked: \(\) => operatorSessionManager\.getCurrent\(\)\?\.lock_state === 'locked',\s*pairedScope: async \(\) => pairedShiftScope\(await pairingStore\.getStatus\(\)\),/,
    );
  });

  it('wires the pairing epoch, the manager identity and the PIN seal (part 2)', () => {
    expect(shiftSource).toMatch(
      /registerShiftCashupIpc\(\{[^}]*pairedScope: async \(\) => pairedShiftScope\(await pairingStore\.getStatus\(\)\),\s*pairingEpoch: \(\) => pairingStore\.getPairingEpoch\(\),\s*getManager: \(\) => managerIdentityOf\(operatorSessionManager\.getCurrent\(\)\),\s*onSessionStarted: \(listener\) => \{\s*operatorSessionManager\.onStarted\(listener\);\s*\},\s*currentTerminalId: \(\) => pairingStore\.getCurrentTerminalId\(\),\s*safeStorage,/,
    );
  });

  it('purges the other terminals’ manager PIN records on a re-pair, with the cashier ones', () => {
    expect(indexSource).toMatch(
      /purgeOtherTerminalPins: \(terminalId\) =>\s*purgeOtherTerminalPinRecords\(db, terminalId\) \+\s*purgeOtherTerminalManagerPinRecords\(db, terminalId\),/,
    );
  });
});
