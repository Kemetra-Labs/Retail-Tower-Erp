import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  dialog: {},
}));

/**
 * RT-1219 — the `ipcMain.handle` channel set that `src/main/index.ts` registers at startup, pinned
 * so that moving wiring out of the startup callback into `bootstrap/*.ts` cannot add, drop or
 * reorder a channel.
 *
 * `index.ts` cannot be imported under vitest (it runs `app.whenReady()` at module load), so the
 * walk is static, then dynamic:
 *
 * 1. Parse `index.ts` and, at each call site, follow any function imported from `./bootstrap/*`
 *    into its module, in source order. This flattens the startup callback and the bootstrap
 *    modules it calls into one ordered list of IPC registrars: calls that pass the guarded
 *    `ipcMain` either as their first argument or as an `ipcMain:` property.
 * 2. Call each registrar with a recording `ipcMain` (and inert fakes for everything else), and
 *    collect the channels it hands to `ipcMain.handle`.
 *
 * Every branch is walked, so flag-gated registrars count as registered (all flags on). The
 * expected list was generated on the unchanged `index.ts` before the RT-1219 move.
 */

const MAIN_DIR = resolve(__dirname, '..');
const INDEX_PATH = resolve(MAIN_DIR, 'index.ts');
const BOOTSTRAP_DIR = resolve(MAIN_DIR, 'bootstrap');
const IPC_ARG = 'guardedIpcMain';

interface Registrar {
  /** Module path relative to `src/main`, without extension. */
  module: string;
  exportName: string;
  /** `positional`: `register(ipcMain, …)`; `property`: `register({ ipcMain, … })`. */
  shape: 'positional' | 'property';
}

/** Parses a TypeScript file from disk, with parent links set for the walk. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
}

/** Local import name → absolute `.ts` path of its module (relative imports only). */
function importsOf(sf: ts.SourceFile): Map<string, { file: string; exportName: string }> {
  const out = new Map<string, { file: string; exportName: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;
    const file = resolve(dirname(sf.fileName), spec.replace(/\.js$/, '.ts'));
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      out.set(el.name.text, { file, exportName: (el.propertyName ?? el.name).text });
    }
  }
  return out;
}

/**
 * Whether `call` hands the guarded `ipcMain` to its callee, and how: as the first argument, or as
 * an `ipcMain:` property of an object-literal first argument. `null` when it does not.
 */
function passesIpc(call: ts.CallExpression): Registrar['shape'] | null {
  const [first] = call.arguments;
  if (first === undefined) return null;
  if (ts.isIdentifier(first) && first.text === IPC_ARG) return 'positional';
  if (ts.isObjectLiteralExpression(first)) {
    const hasIpc = first.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'ipcMain' &&
        ts.isIdentifier(p.initializer) &&
        p.initializer.text === IPC_ARG,
    );
    if (hasIpc) return 'property';
  }
  return null;
}

/** Top-level function declarations of a file, by name. */
function functionsOf(sf: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const out = new Map<string, ts.FunctionDeclaration>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) out.set(stmt.name.text, stmt);
  }
  return out;
}

/**
 * The ordered registrars reached from `node` in `sf`: direct IPC registrar calls, plus (walked in
 * place) calls into a `bootstrap/*` function or into a function declared in the same file.
 */
function collectRegistrars(
  sf: ts.SourceFile,
  node: ts.Node,
  stack: readonly string[],
): Registrar[] {
  const imports = importsOf(sf);
  const locals = functionsOf(sf);
  const out: Registrar[] = [];
  const enter = (file: string, name: string): void => {
    const key = `${file}#${name}`;
    if (stack.includes(key)) throw new Error(`bootstrap call cycle at ${key}`);
    const target = file === sf.fileName ? sf : parse(file);
    const decl = functionsOf(target).get(name);
    if (decl === undefined) throw new Error(`no function ${name} in ${file}`);
    out.push(...collectRegistrars(target, decl, [...stack, key]));
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const imported = imports.get(name);
      const shape = passesIpc(n);
      if (imported !== undefined && shape !== null) {
        out.push({
          module: relative(MAIN_DIR, imported.file).replace(/\.ts$/, ''),
          exportName: imported.exportName,
          shape,
        });
      } else if (imported !== undefined && dirname(imported.file) === BOOTSTRAP_DIR) {
        enter(imported.file, imported.exportName);
      } else if (imported === undefined && locals.has(name) && locals.get(name) !== node) {
        enter(sf.fileName, name);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return out;
}

/** An inert, callable, infinitely deep stand-in for any dependency a registrar receives. */
function inert(): unknown {
  const target = function inertFn(): void {
    /* inert */
  };
  const proxy: unknown = new Proxy(target, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* empty(): Generator<never> {};
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
}

/**
 * Runs one registrar against a recording `ipcMain` (and inert fakes for its other dependencies,
 * with `enabled: true` for a flag-gated registrar) and returns the channels it passed to
 * `ipcMain.handle`, in order.
 */
async function channelsOf(registrar: Registrar): Promise<string[]> {
  const handled: string[] = [];
  const ipc = {
    handle: (channel: string): void => {
      handled.push(channel);
    },
    on: (): void => undefined,
    removeHandler: (): void => undefined,
  };
  const mod = (await import(resolve(MAIN_DIR, `${registrar.module}.ts`))) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const fn = mod[registrar.exportName];
  if (typeof fn !== 'function') {
    throw new Error(`${registrar.module}.${registrar.exportName} is not a function`);
  }
  const deps = inert();
  if (registrar.shape === 'positional') {
    fn(ipc, deps, deps);
  } else {
    const own: Record<string | symbol, unknown> = { ipcMain: ipc, enabled: true };
    fn(
      new Proxy(own, {
        get: (_t, key): unknown => {
          if (key in own) return own[key];
          return key === 'then' ? undefined : deps;
        },
      }),
    );
  }
  return handled;
}

/** Every `ipcMain.handle` channel `index.ts` registers at startup, in registration order. */
async function startupChannels(): Promise<string[]> {
  const channels: string[] = [];
  const index = parse(INDEX_PATH);
  for (const registrar of collectRegistrars(index, index, [])) {
    channels.push(...(await channelsOf(registrar)));
  }
  return channels;
}

/** Generated on the unchanged `index.ts` (origin/main 5108253), in registration order. */
const EXPECTED_STARTUP_CHANNELS: readonly string[] = [
  'app:ping',
  'app:version',
  'app:log',
  'app:report-error',
  'app:config',
  'pairing:get-status',
  'pairing:submit',
  'pairing:recheck',
  'updateStatus:get',
  'terminalStatus:get',
  'approval:listApprovers',
  'approval:request',
  'operator:unlock-session',
  'operator:get-lock-state',
  'operator:list-cashier-pin-status',
  'operator:reauthenticate',
  'operator:get-resume-state',
  'operator:sign-in',
  'operator:sign-out',
  'operator:get-current-session',
  'operator:_report-activity',
  'operator:dismiss-shift-closed-notice',
  'operator:emit-audit-event',
  'operator:_emit-audit-event-smoke',
  'operator:list-branch-roster',
  'operator:takeover-confirm',
  'operator:takeover-cancel',
  'operator:reset-cashier-pin',
  'operator:provision-cashier-pin',
  'operator:unlock-cashier',
  'operator:force-close-shift',
  'operator:list-stuck-shifts',
  'cart:create',
  'cart:lines:add',
  'cart:lines:update',
  'cart:lines:remove',
  'cart:lines:setNote',
  'cart:discountPlaceholders:add',
  'cart:discountPlaceholders:remove',
  'cart:void',
  'cart:cancelPostHandoff',
  'cart:returnToSale',
  'cart:returnToSaleEligibility',
  'cart:promotionPreview',
  'cart:undoLast',
  'cart:handoff',
  'cart:subscribe',
  'cart:snapshot',
  'cart:park',
  'cart:listParked',
  'cart:previewResume',
  'cart:resume',
  'catalogue:lookupBarcode',
  'catalogue:lookupSku',
  'catalogue:search',
  'catalogue:resolve',
  'catalogue:refresh',
  'catalogue:freshness',
  'catalogue:counts',
  'branding:get',
  'payments:start',
  'payments:confirm',
  'payments:cancel',
  'payments:subscribe',
  'payments:read',
  'tender:apply',
  'tender:reverse',
  'tender:read',
  'vouchers:validate',
  'payments:force-fail',
  'recovery:list-held',
  'recovery:complete-attempt',
  'recovery:cancel-attempt',
  'recovery:cancel-held-cart',
  'printer:list',
  'printer:get',
  'printer:set',
  'printer:testPrint',
  'sales:read',
  'sales:findByNumber',
  'sales:subscribe',
  'sales:unsubscribe',
  'sales:list',
  'sales:listRecent',
  'receipts:preview',
  'receipts:retryPrint',
  'receipts:reprint',
  'receipts:manualOverride',
  'saleHistory:list',
  'saleHistory:read',
  'saleHistory:reprint',
  'saleHistory:zoneStatus',
  'sales:syncStatus',
  'sale-void:lookup',
  'sale-void:request',
  'sale-void:list',
  'sale-void:acknowledge',
  'returns:lookup',
  'returns:quote',
  'returns:submit',
  'returns:resolve',
  'returns:list',
  'returns:payout',
  'returns:reprintSlip',
  'shiftCashup:open',
  'shiftCashup:payIn',
  'shiftCashup:payOut',
  'shiftCashup:close',
  'shiftCashup:status',
  'shiftCashup:enrollManagerPin',
  'shiftCashup:listEnrolledManagers',
  'shiftCashup:revokeManagerPin',
  'shiftCashup:abandonCount',
];

describe('startup IPC channel set (RT-1219)', () => {
  it('registers exactly the pinned ipcMain.handle channels, in the pinned order', async () => {
    const channels = await startupChannels();
    expect(channels).toEqual(EXPECTED_STARTUP_CHANNELS);
  });

  it('registers each channel once', async () => {
    const channels = await startupChannels();
    expect(new Set(channels).size).toBe(channels.length);
  });
});
