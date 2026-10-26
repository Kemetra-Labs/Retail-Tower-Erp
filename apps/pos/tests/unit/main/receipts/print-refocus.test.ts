/**
 * RT-847 — the cashier window gets its OS activation back after a receipt print.
 *
 * A printer driver that opens its own window (the lab's HP "Printer Status")
 * takes the foreground, and the cashier's next Enter goes there instead of to
 * «بيع جديد». `withPrintRefocus` wraps the OS-print transport and re-activates
 * the cashier window once the print is over: on success, on failure and on the
 * transport's timeout, plus once more on the first blur inside a short grace
 * period (the driver window can appear after the job is spooled).
 *
 * It must not steal focus while a print is still in flight (a legitimate print
 * dialog lives inside the call), when the cashier had switched away before the
 * print, or when the window is minimized, hidden, destroyed or not built yet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OsPrintFn } from '../../../../src/main/receipts/os-print-adapter.js';
import {
  withPrintRefocus,
  PRINT_REFOCUS_GRACE_MS,
  type RefocusWindow,
} from '../../../../src/main/receipts/print-refocus.js';

const HTML = '<div class="receipt">نقدًا — Cash 12.00</div>';

interface FakeWindow extends RefocusWindow {
  focused: boolean;
  minimized: boolean;
  visible: boolean;
  destroyed: boolean;
  focusCalls: number;
  /** Simulate another window taking the foreground. */
  loseFocus(): void;
  blurListeners(): number;
}

function fakeWindow(initial: Partial<Pick<FakeWindow, 'focused'>> = {}): FakeWindow {
  const listeners = new Set<() => void>();
  const win: FakeWindow = {
    focused: initial.focused ?? true,
    minimized: false,
    visible: true,
    destroyed: false,
    focusCalls: 0,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    isFocused: () => win.focused,
    focus: () => {
      win.focusCalls += 1;
      win.focused = true;
    },
    once: (_event, listener) => {
      listeners.add(listener);
      return win;
    },
    removeListener: (_event, listener) => {
      listeners.delete(listener);
      return win;
    },
    loseFocus: () => {
      win.focused = false;
      const pending = [...listeners];
      listeners.clear();
      for (const l of pending) l();
    },
    blurListeners: () => listeners.size,
  };
  return win;
}

/** An inner print whose callback the test fires by hand. */
function manualPrint(): {
  print: OsPrintFn;
  complete: (success: boolean, reason?: string) => void;
} {
  const pending: ((success: boolean, reason?: string) => void)[] = [];
  return {
    print: (_html, cb) => {
      pending.push(cb);
    },
    complete: (success, reason) => {
      pending.shift()?.(success, reason);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RT-847 withPrintRefocus — re-activation after the print', () => {
  it('passes the HTML through and reports the inner outcome unchanged', () => {
    const inner = vi.fn<OsPrintFn>((_html, cb) => {
      cb(false, 'os_print_timeout');
    });
    const callback = vi.fn();
    const win = fakeWindow();

    withPrintRefocus(inner, { getWindow: () => win })(HTML, callback);

    expect(inner).toHaveBeenCalledWith(HTML, expect.any(Function));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(false, 'os_print_timeout');
  });

  it.each([
    ['success', true, undefined],
    ['failure', false, 'printer offline'],
    ['timeout', false, 'os_print_timeout'],
  ])(
    're-activates the window when the print took the foreground (%s)',
    (_label, success, reason) => {
      const win = fakeWindow();
      const inner = manualPrint();
      const logger = { info: vi.fn() };
      const callback = vi.fn();

      withPrintRefocus(inner.print, { getWindow: () => win, logger })(HTML, callback);
      win.loseFocus(); // the driver window opens while the job is in flight
      expect(win.focusCalls).toBe(0); // never during the print
      inner.complete(success, reason);

      expect(win.focusCalls).toBe(1);
      expect(win.focused).toBe(true);
      expect(callback).toHaveBeenCalledWith(success, reason);
      expect(logger.info).toHaveBeenCalledWith({ msg: 'os_print:refocus', trigger: 'settle' });
    },
  );

  it('does not call focus when the window kept its activation', () => {
    const win = fakeWindow();
    const inner = manualPrint();

    withPrintRefocus(inner.print, { getWindow: () => win })(HTML, vi.fn());
    inner.complete(true);

    expect(win.focusCalls).toBe(0);
  });

  it('re-activates once on a blur inside the grace period (driver window after spooling)', async () => {
    const win = fakeWindow();
    const inner = manualPrint();
    const logger = { info: vi.fn() };

    withPrintRefocus(inner.print, { getWindow: () => win, logger })(HTML, vi.fn());
    inner.complete(true);
    await vi.advanceTimersByTimeAsync(470);
    win.loseFocus();
    expect(win.focusCalls).toBe(0); // deferred until Windows finishes the switch
    await vi.advanceTimersByTimeAsync(0);

    expect(win.focusCalls).toBe(1);
    expect(logger.info).toHaveBeenCalledWith({ msg: 'os_print:refocus', trigger: 'blur' });

    // One-shot: a later switch is the cashier's own.
    win.loseFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.focusCalls).toBe(1);
  });

  it('stops watching once the grace period ends', async () => {
    const win = fakeWindow();
    const inner = manualPrint();

    withPrintRefocus(inner.print, { getWindow: () => win })(HTML, vi.fn());
    inner.complete(true);
    expect(win.blurListeners()).toBe(1);
    await vi.advanceTimersByTimeAsync(PRINT_REFOCUS_GRACE_MS);

    expect(win.blurListeners()).toBe(0);
    win.loseFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.focusCalls).toBe(0);
  });

  it('honours a configured grace period', async () => {
    const win = fakeWindow();
    const inner = manualPrint();

    withPrintRefocus(inner.print, { getWindow: () => win, graceMs: 100 })(HTML, vi.fn());
    inner.complete(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(win.blurListeners()).toBe(0);
  });

  it('does not re-activate on a grace blur if the window is gone by then', async () => {
    const win = fakeWindow();
    const inner = manualPrint();

    withPrintRefocus(inner.print, { getWindow: () => win })(HTML, vi.fn());
    inner.complete(true);
    win.loseFocus();
    win.minimized = true;
    await vi.advanceTimersByTimeAsync(0);

    expect(win.focusCalls).toBe(0);
  });

  it('does not re-activate on a grace blur when the window regained focus by itself', async () => {
    const win = fakeWindow();
    const inner = manualPrint();

    withPrintRefocus(inner.print, { getWindow: () => win })(HTML, vi.fn());
    inner.complete(true);
    win.loseFocus();
    win.focused = true;
    await vi.advanceTimersByTimeAsync(0);

    expect(win.focusCalls).toBe(0);
  });
});

describe('RT-847 withPrintRefocus — never steals focus', () => {
  it('waits for every print in flight: a dialog inside a second print is not interrupted', () => {
    const win = fakeWindow();
    const inner = manualPrint();
    const refocusing = withPrintRefocus(inner.print, { getWindow: () => win });

    refocusing(HTML, vi.fn());
    refocusing(HTML, vi.fn());
    win.loseFocus(); // e.g. a print-to-file save box for one of them
    inner.complete(true);
    expect(win.focusCalls).toBe(0);

    inner.complete(true);
    expect(win.focusCalls).toBe(1);
  });

  it('a print starting inside the grace period cancels the blur watch until it ends', async () => {
    const win = fakeWindow();
    const inner = manualPrint();
    const refocusing = withPrintRefocus(inner.print, { getWindow: () => win });

    refocusing(HTML, vi.fn());
    inner.complete(true);
    refocusing(HTML, vi.fn()); // the next print begins while the watch is armed
    expect(win.blurListeners()).toBe(0);
    win.loseFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.focusCalls).toBe(0);

    inner.complete(true); // the run began with the window active, so restore it
    expect(win.focusCalls).toBe(1);
  });

  it('a blur that lands just before a new print starts does not refocus during that print', async () => {
    const win = fakeWindow();
    const inner = manualPrint();
    const refocusing = withPrintRefocus(inner.print, { getWindow: () => win });

    refocusing(HTML, vi.fn());
    inner.complete(true);
    win.loseFocus(); // deferred re-activation queued
    refocusing(HTML, vi.fn()); // a print starts before it runs
    await vi.advanceTimersByTimeAsync(0);

    expect(win.focusCalls).toBe(0);
  });

  it('leaves the window alone when the cashier had switched away before the print', () => {
    const win = fakeWindow({ focused: false });
    const inner = manualPrint();

    withPrintRefocus(inner.print, { getWindow: () => win })(HTML, vi.fn());
    inner.complete(true);

    expect(win.focusCalls).toBe(0);
    expect(win.blurListeners()).toBe(0);
  });

  it.each([
    ['minimized', (w: FakeWindow) => (w.minimized = true)],
    ['hidden', (w: FakeWindow) => (w.visible = false)],
    ['destroyed', (w: FakeWindow) => (w.destroyed = true)],
  ])('leaves a %s window alone', (_label, mutate) => {
    const win = fakeWindow();
    const inner = manualPrint();

    withPrintRefocus(inner.print, { getWindow: () => win })(HTML, vi.fn());
    win.loseFocus();
    mutate(win);
    inner.complete(false, 'os_print_timeout');

    expect(win.focusCalls).toBe(0);
    expect(win.blurListeners()).toBe(0);
  });

  it('does nothing before the cashier window exists', () => {
    const inner = manualPrint();
    const callback = vi.fn();

    withPrintRefocus(inner.print, { getWindow: () => undefined })(HTML, callback);
    inner.complete(true);

    expect(callback).toHaveBeenCalledWith(true, undefined);
  });

  it('settles its bookkeeping and rethrows when the inner print throws', () => {
    const win = fakeWindow();
    const inner = manualPrint();
    let calls = 0;
    const refocusing = withPrintRefocus(
      (html, cb) => {
        calls += 1;
        if (calls === 1) throw new Error('no webContents');
        inner.print(html, cb);
      },
      { getWindow: () => win },
    );

    expect(() => {
      refocusing(HTML, vi.fn());
    }).toThrow('no webContents');

    // The failed print is no longer in flight: the next one still re-activates.
    refocusing(HTML, vi.fn());
    win.loseFocus();
    inner.complete(true);
    expect(win.focusCalls).toBe(1);
  });

  it('counts a print once even if the inner print calls back twice', () => {
    const win = fakeWindow();
    const callback = vi.fn();
    const inner = manualPrint();
    let captured: ((success: boolean, reason?: string) => void) | undefined;
    let calls = 0;
    const refocusing = withPrintRefocus(
      (html, cb) => {
        calls += 1;
        if (calls === 1) captured = cb;
        else inner.print(html, cb);
      },
      { getWindow: () => win },
    );

    refocusing(HTML, callback);
    captured?.(true);
    captured?.(true);

    // Two prints in flight; the first finishing must not refocus over the second.
    refocusing(HTML, vi.fn());
    refocusing(HTML, vi.fn());
    win.loseFocus();
    inner.complete(true);
    expect(win.focusCalls).toBe(0);
    inner.complete(true);
    expect(win.focusCalls).toBe(1);
  });
});
