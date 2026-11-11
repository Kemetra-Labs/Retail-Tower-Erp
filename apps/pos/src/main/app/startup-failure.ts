import { DatabaseOpenError, machineCodeOf } from '../db/client.js';
import { backupsDirFor } from '../db/pre-migration-snapshot.js';
import { SecretStoreUnavailableError } from '../secrets/index.js';
import { describeStartupFailureRefusal } from './startup-failure-refusal.js';
import type {
  StartupFailure,
  StartupFailureClass,
  StartupRefusal,
} from './startup-failure-refusal.js';

/**
 * RT-1324 (RT-1125 R-39) — a till that cannot start says why, then exits.
 *
 * Before this, every startup failure except the schema-ahead refusal reached
 * the composition root's `.catch`, which logged to the console (invisible in a
 * packaged build) and exited before any window existed: the till just vanished.
 *
 * - `classifyStartupFailure` names the failure class from the error's TYPE and
 *   `code`, never its message: a full disk (`SQLITE_FULL`, `ENOSPC`) at any
 *   stage, a `DatabaseOpenError`, the `SecretStoreUnavailableError` production
 *   refusal, else the caller's stage fallback.
 * - `showRefusalAndExit` is the one async-dialog-then-exit shape every startup
 *   refusal uses (`showMessageBox`, not the synchronous `showErrorBox`, which
 *   blocks the event loop and stalled the pino write in the packaged build).
 *   There is no window yet, so `window-all-closed` never fires: it exits itself.
 * - `refuseFatalStartup` is the `.catch` body: it always ends in `exit(1)`,
 *   whatever fails along the way.
 *
 * Nothing here restores, resets or re-pairs: the database holds the pairing and
 * the sealed device token. Recovery stays a support action.
 */

const DISK_FULL_CODES: ReadonlySet<string> = new Set(['SQLITE_FULL', 'ENOSPC']);

/** Bounds the `cause` walk; real chains here are one or two deep. */
const MAX_CAUSE_DEPTH = 5;

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

export function classifyStartupFailure(
  err: unknown,
  fallback: StartupFailureClass = 'unknown',
): StartupFailure {
  const chain = causeChain(err);
  const codes = chain.map(machineCodeOf).filter((code): code is string => code !== undefined);
  const diskFull = codes.find((code) => DISK_FULL_CODES.has(code));
  if (diskFull !== undefined) return { failureClass: 'disk_full', code: diskFull };

  const code = codes[0];
  if (chain.some((e) => e instanceof SecretStoreUnavailableError)) {
    return { failureClass: 'secret_store', code };
  }
  if (chain.some((e) => e instanceof DatabaseOpenError)) {
    return { failureClass: 'database_open', code };
  }
  return { failureClass: fallback, code };
}

/** The slice of Electron's `dialog` a refusal needs (a fake in tests). */
export interface RefusalDialog {
  showMessageBox(options: { type: 'error'; title: string; message: string }): Promise<unknown>;
}

/** The slice of Electron's `app` a refusal needs. */
export interface RefusalApp {
  exit(code: number): void;
}

export interface RefusalDeps {
  app: RefusalApp;
  dialog: RefusalDialog;
}

/** Show `refusal` in an error dialog, then exit 1 once it closes (or fails). */
export function showRefusalAndExit(refusal: StartupRefusal, deps: RefusalDeps): void {
  const exitRefused = (): void => {
    deps.app.exit(1);
  };
  try {
    void deps.dialog
      .showMessageBox({ type: 'error', title: refusal.title, message: refusal.body })
      .then(exitRefused, exitRefused);
  } catch {
    exitRefused();
  }
}

export interface FatalStartupDeps extends RefusalDeps {
  app: RefusalApp & { getPath(name: 'userData'): string };
  /** Stops the workers and closes the DB handle; may run before the DB opened. */
  closeDb: () => void;
  /**
   * Defaults to `console.error`, not the pino logger: the logger itself may be
   * what failed to initialize.
   */
  logError?: (...args: unknown[]) => void;
}

/** The composition root's fatal-startup `.catch`: log, close, explain, exit 1. */
export function refuseFatalStartup(err: unknown, deps: FatalStartupDeps): void {
  const logError = deps.logError ?? console.error;
  logError('[pos-pulse] fatal startup error:', err);
  try {
    deps.closeDb();
  } catch (closeErr) {
    logError('[pos-pulse] closing the database after a startup failure failed:', closeErr);
  }

  let refusal: StartupRefusal;
  try {
    const failure = classifyStartupFailure(err);
    logError('[pos-pulse] startup refused:', failure);
    refusal = describeStartupFailureRefusal({ failure, backupsDir: resolveBackupsDir(deps.app) });
  } catch {
    deps.app.exit(1);
    return;
  }
  showRefusalAndExit(refusal, deps);
}

function resolveBackupsDir(app: FatalStartupDeps['app']): string | undefined {
  try {
    return backupsDirFor(app.getPath('userData'));
  } catch {
    return undefined;
  }
}
