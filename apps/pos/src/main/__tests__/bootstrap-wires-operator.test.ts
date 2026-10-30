import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * 004-operator-session — bootstrap-wires-operator guard.
 *
 * Asserts that `src/main/index.ts` imports and calls
 * `registerOperatorHandlers`, constructs the production
 * `OperatorExchanger` and `BackendClient`, and starts the
 * `InactivityMonitor`. A pure static check: importing `src/main/
 * index.ts` for runtime testing requires the Electron `app` /
 * `BrowserWindow` globals (the file invokes `app.whenReady()` at
 * module load), which are not available in vitest's `node` /
 * `happy-dom` environments.
 *
 * If a future contributor removes any of these wires, this guard
 * fails — and `/sign-in` would silently break end-to-end (an
 * `operator:*` IPC channel without a registered handler rejects
 * with "no handler for channel" at the bridge boundary).
 */

const INDEX_PATH = resolve(__dirname, '../index.ts');

describe('main/index.ts wires the operator namespace (004 S1)', () => {
  const source = readFileSync(INDEX_PATH, 'utf-8');
  const resolverSource = readFileSync(
    resolve(__dirname, '../operator/resolve-exchanger.ts'),
    'utf-8',
  );

  it('imports registerOperatorHandlers from ./ipc/operator', () => {
    expect(source).toMatch(
      /import\s+\{\s*registerOperatorHandlers\s*\}\s+from\s+'\.\/ipc\/operator/,
    );
  });

  it('builds the production OperatorExchanger through the RT-792 provider resolver', () => {
    // RT-893: `resolveAuthExchanger` lives in `bootstrap/env.ts`; index.ts imports and calls it.
    const envSource = readFileSync(resolve(__dirname, '../bootstrap/env.ts'), 'utf-8');
    expect(source).toContain('resolveAuthExchanger(mainLogger)');
    expect(source).toContain("from './bootstrap/env.js'");
    expect(envSource).toContain('resolveOperatorExchanger({');
    expect(envSource).toContain("from '../operator/resolve-exchanger.js'");
    expect(resolverSource).toContain('createDescopeExchanger');
    expect(resolverSource).toContain("from './descope-client.js'");
  });

  it('imports the production BackendClient factory', () => {
    expect(source).toContain('createBackendClient');
    expect(source).toContain("from './operator/backend-client.js'");
  });

  it('imports the SessionManager, SignInHandler, SignOutHandler, InactivityMonitor', () => {
    expect(source).toContain('SessionManager');
    expect(source).toContain('SignInHandler');
    expect(source).toContain('SignOutHandler');
    expect(source).toContain('InactivityMonitor');
    expect(source).toContain("from './operator/session-manager.js'");
    expect(source).toContain("from './operator/sign-in-handler.js'");
    expect(source).toContain("from './operator/sign-out-handler.js'");
    expect(source).toContain("from './operator/inactivity-monitor.js'");
  });

  it('imports the JwtHolder factory', () => {
    expect(source).toContain('createJwtHolder');
    expect(source).toContain("from './operator/jwt-holder.js'");
  });

  it('calls registerOperatorHandlers (the load-bearing call site)', () => {
    // #370: the call site now passes `guardedIpcMain` (the sender-origin-guarded
    // wrapper from createSenderGuardedIpcMain), not the raw `ipcMain`. Accept
    // either so the assertion tracks "operator handlers are wired to the IPC
    // surface" rather than the specific instance name.
    expect(source).toMatch(/registerOperatorHandlers\(\s*(?:guardedIpcMain|ipcMain)\s*,/);
  });

  it('starts the inactivity monitor', () => {
    expect(source).toMatch(/operatorInactivityMonitor\.start\(\)/);
  });

  it('reads DESCOPE_PROJECT_ID from process.env (public project id, not secret)', () => {
    const envSource = readFileSync(resolve(__dirname, '../bootstrap/env.ts'), 'utf-8');
    expect(envSource).toContain('env: process.env,');
    expect(resolverSource).toContain("env['DESCOPE_PROJECT_ID']");
  });

  it('has no Clerk exchanger left (RT-945: Descope is the only provider)', () => {
    expect(resolverSource).not.toMatch(/clerk/i);
    expect(source).not.toMatch(/from\s+['"]@clerk\//);
  });
});

describe('main/index.ts wires the audit-event outbox (004 T048)', () => {
  const source = readFileSync(INDEX_PATH, 'utf-8');

  it('imports AuditEmitter from ./audit/audit-emitter', () => {
    expect(source).toContain('AuditEmitter');
    expect(source).toContain("from './audit/audit-emitter.js'");
  });

  it('imports bindAuditEventsStoreDb from ./audit/audit-events-store', () => {
    expect(source).toContain('bindAuditEventsStoreDb');
    expect(source).toContain("from './audit/audit-events-store.js'");
  });

  it('passes auditEmitter to registerOperatorHandlers', () => {
    expect(source).toContain('auditEmitter,');
  });

  it('passes pairingStore to registerOperatorHandlers (trusted terminal_id source)', () => {
    expect(source).toContain('pairingStore,');
  });
});
