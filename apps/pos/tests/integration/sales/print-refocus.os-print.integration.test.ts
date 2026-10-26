/**
 * RT-847 — integration: the OS-print path re-activates the cashier window.
 *
 * Wires the production pieces as `index.ts` does — `createPrintPipeline` →
 * `createOsPrintAdapter` → `withPrintRefocus` → `createOsPrintTransport` —
 * with only the Electron leaves faked (the offscreen print window, the printer
 * list and the cashier window). A driver window takes the foreground while the
 * job is in flight; once the print succeeds, fails or times out, the cashier
 * window is active again, the print outcome is unchanged, and the offscreen
 * print window is destroyed first (no dialog of the print outlives it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOsPrintAdapter } from '../../../src/main/receipts/os-print-adapter.js';
import {
  createOsPrintTransport,
  type PrintWindow,
} from '../../../src/main/receipts/os-print-transport.js';
import { createPrintPipeline } from '../../../src/main/receipts/print-pipeline.js';
import { createEscposAdapter } from '../../../src/main/receipts/escpos-adapter.js';
import { withPrintRefocus, type RefocusWindow } from '../../../src/main/receipts/print-refocus.js';

const RENDERED = { escpos: new Uint8Array([0x1b, 0x40]), html: '<div class="receipt">x</div>' };

/** How the faked `webContents.print` answers. */
type PrintBehaviour = 'success' | 'failure' | 'never';

function harness(behaviour: PrintBehaviour) {
  const events: string[] = [];
  let focused = true;
  const blurListeners = new Set<() => void>();
  const cashierWindow: RefocusWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => focused,
    focus: () => {
      events.push('cashier:focus');
      focused = true;
    },
    once: (_e, l) => blurListeners.add(l),
    removeListener: (_e, l) => blurListeners.delete(l),
  };

  const printWindow: PrintWindow = {
    loadHtml: () => Promise.resolve(),
    print: (_options, callback) => {
      // The driver's status window takes the foreground while the job spools.
      focused = false;
      events.push('driver-window:foreground');
      if (behaviour === 'success') callback(true, '');
      if (behaviour === 'failure') callback(false, 'Printer is offline');
    },
    destroy: () => {
      events.push('print-window:destroy');
    },
  };

  const pipeline = createPrintPipeline({
    escposAdapter: createEscposAdapter({
      transport: {
        write: () => Promise.resolve(),
        pollStatus: () => Promise.resolve('offline' as const),
      },
      statusTimeoutMs: 100,
    }),
    osPrintAdapter: createOsPrintAdapter({
      print: withPrintRefocus(
        createOsPrintTransport({
          createPrintWindow: () => printWindow,
          listPrinters: () => Promise.resolve([]),
          timeoutMs: 500,
        }),
        { getWindow: () => cashierWindow },
      ),
      timeoutMs: 2_000,
    }),
    probeEscposSupport: () => Promise.resolve(false),
  });

  return { pipeline, events, isFocused: () => focused };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RT-847 OS-print path re-activates the cashier window', () => {
  it('after a successful print', async () => {
    const h = harness('success');

    const result = await h.pipeline.printRendered(RENDERED);

    expect(result).toEqual({ ok: true, render_path: 'os_print' });
    expect(h.isFocused()).toBe(true);
    expect(h.events).toEqual(['driver-window:foreground', 'print-window:destroy', 'cashier:focus']);
  });

  it('after a failed print', async () => {
    const h = harness('failure');

    const result = await h.pipeline.printRendered(RENDERED);

    expect(result).toEqual({
      ok: false,
      render_path: 'os_print',
      failure_reason: 'os_print_error',
    });
    expect(h.isFocused()).toBe(true);
    expect(h.events).toEqual(['driver-window:foreground', 'print-window:destroy', 'cashier:focus']);
  });

  it('after a print that times out, and not before', async () => {
    const h = harness('never');

    const pending = h.pipeline.printRendered(RENDERED);
    await vi.advanceTimersByTimeAsync(499);
    // Still in flight: the driver window keeps the foreground.
    expect(h.isFocused()).toBe(false);
    expect(h.events).toEqual(['driver-window:foreground']);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      render_path: 'os_print',
      failure_reason: 'os_print_error',
    });
    expect(h.isFocused()).toBe(true);
    expect(h.events).toEqual(['driver-window:foreground', 'print-window:destroy', 'cashier:focus']);
  });
});
