import { DatabaseOpenError, machineCodeOf } from '../db/client.js';
import { backupsDirFor } from '../db/pre-migration-snapshot.js';
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
 *   stage, a `DatabaseOpenError`, a `StartupStageError` (`runStartupStage`
 *   tags the SecretStore construction, whose production refusal is a plain
 *   Error; `src/main/secrets/` is a no-touch layer), else the stage fallback.
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

/** A startup step failed; `failureClass` names the step. The original is `cause`. */
export class StartupStageError extends Error {
  readonly failureClass: StartupFailureClass;

  constructor(failureClass: StartupFailureClass, cause: unknown) {
    super(`Startup step failed: ${failureClass}`, { cause });
    this.name = 'StartupStageError';
    this.failureClass = failureClass;
  }
}

/** Run one startup step; any throw is rethrown as a `StartupStageError` naming it. */
export function runStartupStage<T>(failureClass: StartupFailureClass, step: () => T): T {
  try {
    return step();
  } catch (err) {
    throw new StartupStageError(failureClass, err);
  }
}

/** Bounds the `cause` walk; real chains here are one or two deep. */
const MAX_CAUSE_DEPTH = 5;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  while (isPresent(current) && chain.length < MAX_CAUSE_DEPTH) {
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
  const stage = chain.find((e): e is StartupStageError => e instanceof StartupStageError);
  if (stage !== undefined) return { failureClass: stage.failureClass, code };
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
interface RefusalApp {
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
  // Nothing before the exit may throw out of here: a rejected `.catch` would
  // leave the process up with no window, holding the single-instance lock.
  bestEffort(() => {
    logError('[pos-pulse] fatal startup error:', err);
  });
  try {
    deps.closeDb();
  } catch (closeErr) {
    bestEffort(() => {
      logError('[pos-pulse] closing the database after a startup failure failed:', closeErr);
    });
  }

  let refusal: StartupRefusal;
  try {
    const failure = classifyStartupFailure(err);
    bestEffort(() => {
      logError('[pos-pulse] startup refused:', failure);
    });
    refusal = describeStartupFailureRefusal({ failure, backupsDir: resolveBackupsDir(deps.app) });
  } catch {
    deps.app.exit(1);
    return;
  }
  showRefusalAndExit(refusal, deps);
}

function bestEffort(step: () => void): void {
  try {
    step();
  } catch {
    // Logging is best effort here; the dialog and the exit are what matter.
  }
}

function resolveBackupsDir(app: FatalStartupDeps['app']): string | undefined {
  try {
    return backupsDirFor(app.getPath('userData'));
  } catch {
    return undefined;
  }
}
