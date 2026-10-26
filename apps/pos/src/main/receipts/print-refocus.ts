/**
 * RT-847 — give the cashier window back its OS activation after a receipt print.
 *
 * The OS-print path prints silently to a Windows printer queue. Some drivers
 * open their own window when a job arrives (in the rt9 lab, the offline HP
 * Laser MFP's "Printer Status" window, about 470 ms after the completion
 * screen). That window takes the foreground, POS loses activation, and the
 * cashier's next Enter goes to the driver window instead of «بيع جديد».
 *
 * `withPrintRefocus` wraps the transport's `OsPrintFn` (not the adapter: the
 * adapter's own deadline can fire while the transport's print is still in
 * flight) and, once the print is over (success, failure or the transport's
 * timeout, which also destroys the print window):
 *
 *   1. re-activates the cashier window if it lost activation, and
 *   2. watches for a short grace period and re-activates it once more on the
 *      first blur. The print callback fires when the job is spooled, which can
 *      be BEFORE the driver opens its window.
 *
 * It never steals focus:
 *   - while any print is still in flight (a driver that shows a legitimate
 *     dialog, such as a print-to-file save box, does so inside the call; a
 *     print that starts during the grace period cancels it);
 *   - when the cashier window was not the active window as the prints began
 *     (the cashier had switched away on purpose);
 *   - when the cashier window is minimized, hidden, destroyed or not built yet.
 *
 * `BrowserWindow.focus()` is the activation call. Windows lets it take the
 * foreground because this process received the last input event (the
 * cashier's confirming keystroke or click); the driver window took the
 * foreground without input. Once the window is active again, Chromium restores
 * focus to the element that held it; the renderer re-asks for the visible ring
 * (`CompletionPanel`, RT-840 `focusVisibly`).
 *
 * Logging is structural only: never the slip HTML (FR-071 / AD-9).
 */

import type { OsPrintFn } from './os-print-adapter.js';

/** How long after a print settles a blur still counts as the print's doing (ms). */
export const PRINT_REFOCUS_GRACE_MS = 3_000;

/** The slice of a `BrowserWindow` this module needs (a fake in tests). */
export interface RefocusWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  focus(): void;
  once(event: 'blur', listener: () => void): unknown;
  removeListener(event: 'blur', listener: () => void): unknown;
}

/** Structural logger port — never receives slip content. */
export interface PrintRefocusLogger {
  info(...args: unknown[]): void;
}

export interface PrintRefocusConfig {
  /** The cashier window, read at use time (it is built after the print ports). */
  getWindow: () => RefocusWindow | undefined;
  /** Grace period after a print settles (ms). Defaults to {@link PRINT_REFOCUS_GRACE_MS}. */
  graceMs?: number;
  /** Optional structural logger; defaults to no-op. */
  logger?: PrintRefocusLogger;
}

const NOOP_LOGGER: PrintRefocusLogger = { info: () => {} };

/** A window this module may activate: built, not destroyed, shown and not minimized. */
function usable(win: RefocusWindow | undefined): win is RefocusWindow {
  return win !== undefined && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

/**
 * Wrap an `OsPrintFn` so the cashier window gets its activation back after the
 * print. The wrapped function keeps the inner contract: its callback fires
 * exactly once with the inner outcome, unchanged.
 */
export function withPrintRefocus(print: OsPrintFn, config: PrintRefocusConfig): OsPrintFn {
  const graceMs = config.graceMs ?? PRINT_REFOCUS_GRACE_MS;
  const logger = config.logger ?? NOOP_LOGGER;

  /** Prints in flight through this wrapper. */
  let inFlight = 0;
  /** Whether the cashier window was active when the current run of prints began. */
  let hadFocus = false;
  /** Tears down the post-print blur watch; set only while it is armed. */
  let disarmWatch: (() => void) | undefined;

  const reactivate = (win: RefocusWindow, trigger: 'settle' | 'blur'): void => {
    // A refocus failure must never change or swallow the print outcome.
    try {
      win.focus();
      logger.info({ msg: 'os_print:refocus', trigger });
    } catch {
      // best effort: the cashier can still click back into the window
    }
  };

  const armWatch = (win: RefocusWindow): void => {
    const onBlur = (): void => {
      disarm();
      // Let Windows finish the activation change before asking for it back.
      setTimeout(() => {
        if (inFlight === 0 && usable(win) && !win.isFocused()) reactivate(win, 'blur');
      }, 0);
    };
    const timer = setTimeout(() => {
      disarm();
    }, graceMs);
    const disarm = (): void => {
      clearTimeout(timer);
      win.removeListener('blur', onBlur);
      disarmWatch = undefined;
    };
    win.once('blur', onBlur);
    disarmWatch = disarm;
  };

  const begin = (): void => {
    if (inFlight === 0) {
      // An armed watch means the previous run had the window active; a blur
      // inside this new print may be a legitimate dialog, so stop watching.
      const watching = disarmWatch !== undefined;
      disarmWatch?.();
      const win = config.getWindow();
      hadFocus = watching || (usable(win) && win.isFocused());
    }
    inFlight += 1;
  };

  const end = (): void => {
    inFlight -= 1;
    if (inFlight > 0 || !hadFocus) return;
    hadFocus = false;
    const win = config.getWindow();
    if (!usable(win)) return;
    if (!win.isFocused()) reactivate(win, 'settle');
    armWatch(win);
  };

  return function refocusingPrint(html, callback): void {
    begin();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      end();
    };
    try {
      print(html, (success, failureReason) => {
        finish();
        callback(success, failureReason);
      });
    } catch (err) {
      finish();
      throw err;
    }
  };
}
