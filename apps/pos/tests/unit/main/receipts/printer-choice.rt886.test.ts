/**
 * RT-886 (RT-839 S1) — the chosen printer on the OS-print path.
 *
 *   - The transport reads the choice on EVERY print, so a change applies
 *     without a restart (AC2: receipt, return slip and reprint share it).
 *   - Chosen → that exact queue; «Windows default» / no choice → no deviceName.
 *   - A chosen printer that is not installed fails loudly and creates no print
 *     window: it never falls back to another printer (AC4).
 *   - `sale.receipt.printed` carries `printer_source` (chosen | os_default).
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebContentsPrintOptions } from 'electron';

import {
  createOsPrintTransport,
  isNamedPrinterMissing,
  type PrintWindow,
  type PrinterInfoLike,
} from '../../../../src/main/receipts/os-print-transport.js';
import { createOsPrintAdapter } from '../../../../src/main/receipts/os-print-adapter.js';
import { createPrintPipeline } from '../../../../src/main/receipts/print-pipeline.js';
import type {
  PrintAdapterResult,
  PrintPipeline,
} from '../../../../src/main/receipts/print-pipeline.js';
import { createPrintDispatcher } from '../../../../src/main/receipts/print-dispatcher.js';
import type { PrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import type { SaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import type { ReceiptPayload } from '../../../../src/shared/receipts/types.js';

const PRINTERS: PrinterInfoLike[] = [
  { name: 'HP LaserJet', isDefault: false },
  { name: 'BIXOLON SRP-330II', isDefault: false },
];

function recordingWindows(): {
  create: () => PrintWindow;
  options: WebContentsPrintOptions[];
} {
  const options: WebContentsPrintOptions[] = [];
  return {
    options,
    create: () => ({
      loadHtml: () => Promise.resolve(),
      print: (opts, cb) => {
        options.push(opts);
        cb(true, '');
      },
      destroy: () => undefined,
    }),
  };
}

function printOnce(print: ReturnType<typeof createOsPrintTransport>): Promise<[boolean, string?]> {
  return new Promise((resolve) => {
    print('<div class="receipt">x</div>', (success, reason) => {
      resolve([success, reason]);
    });
  });
}

describe('RT-886 — isNamedPrinterMissing', () => {
  it('is true only for a named printer absent from a non-empty list', () => {
    expect(isNamedPrinterMissing(PRINTERS, 'Gone')).toBe(true);
    expect(isNamedPrinterMissing(PRINTERS, 'HP LaserJet')).toBe(false);
    expect(isNamedPrinterMissing(PRINTERS, '')).toBe(false);
    // An empty list proves nothing: Electron refuses an unknown device itself.
    expect(isNamedPrinterMissing([], 'Gone')).toBe(false);
  });
});

describe('RT-886 — the transport resolves the printer on every print', () => {
  it('prints to the chosen queue, and a change applies to the next print', async () => {
    let chosen: string | undefined = 'BIXOLON SRP-330II';
    const windows = recordingWindows();
    const print = createOsPrintTransport({
      createPrintWindow: windows.create,
      listPrinters: () => Promise.resolve(PRINTERS),
      resolveDeviceName: () => chosen,
    });
    expect(await printOnce(print)).toEqual([true, undefined]);
    chosen = 'HP LaserJet';
    await printOnce(print);
    chosen = undefined; // «Windows default»
    await printOnce(print);
    expect(windows.options.map((o) => o.deviceName)).toEqual([
      'BIXOLON SRP-330II',
      'HP LaserJet',
      undefined,
    ]);
  });

  it('the choice wins over a static deviceName', async () => {
    const windows = recordingWindows();
    const print = createOsPrintTransport({
      createPrintWindow: windows.create,
      listPrinters: () => Promise.resolve(PRINTERS),
      deviceName: 'HP LaserJet',
      resolveDeviceName: () => 'BIXOLON SRP-330II',
    });
    await printOnce(print);
    expect(windows.options[0]?.deviceName).toBe('BIXOLON SRP-330II');
  });

  it('a missing chosen printer fails loudly and opens no print window (no silent fallback)', async () => {
    const create = vi.fn();
    const warn = vi.fn();
    const print = createOsPrintTransport({
      createPrintWindow: create,
      listPrinters: () => Promise.resolve(PRINTERS),
      resolveDeviceName: () => 'Unplugged XP-80C',
      logger: { info: vi.fn(), warn },
    });
    expect(await printOnce(print)).toEqual([false, 'os_print_printer_missing']);
    expect(create).not.toHaveBeenCalled();
    // Structural log only: never the printer name.
    expect(warn).toHaveBeenCalledWith({
      msg: 'os_print:failure',
      failure_reason: 'os_print_printer_missing',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('XP-80C');
  });

  it('with no discovered printers the name still goes to Electron, never dropped', async () => {
    const windows = recordingWindows();
    const print = createOsPrintTransport({
      createPrintWindow: windows.create,
      listPrinters: () => Promise.reject(new Error('no window yet')),
      resolveDeviceName: () => 'XP-80C',
    });
    await printOnce(print);
    expect(windows.options[0]?.deviceName).toBe('XP-80C');
  });

  it('a choice that cannot be read fails the print loudly', async () => {
    const create = vi.fn();
    const print = createOsPrintTransport({
      createPrintWindow: create,
      listPrinters: () => Promise.resolve(PRINTERS),
      resolveDeviceName: () => {
        throw new Error('db closed');
      },
    });
    expect(await printOnce(print)).toEqual([false, 'os_print_error']);
    expect(create).not.toHaveBeenCalled();
  });

  it('through the adapter and pipeline, a missing printer is a recorded failure', async () => {
    const pipeline = createPrintPipeline({
      escposAdapter: { render_path: 'escpos_direct', print: vi.fn() },
      osPrintAdapter: createOsPrintAdapter({
        print: createOsPrintTransport({
          createPrintWindow: vi.fn(),
          listPrinters: () => Promise.resolve(PRINTERS),
          resolveDeviceName: () => 'Gone',
        }),
      }),
      probeEscposSupport: () => Promise.resolve(false),
    });
    expect(await pipeline.printRendered({ escpos: new Uint8Array(), html: '<p/>' })).toEqual({
      ok: false,
      render_path: 'os_print',
      failure_reason: 'os_print_error',
    });
  });
});

describe('RT-886 — printer_source on sale.receipt.printed', () => {
  const PAYLOAD = {} as ReceiptPayload;
  const CTX = {
    sale_id: 'sale-1',
    tenant_id: 't-1',
    branch_id: 'b-1',
    terminal_id: 'term-1',
    session_id: 'sess-1',
    attribution_operator_id: 'user_cashier',
  };

  function dispatcher(
    result: PrintAdapterResult,
    printerSource?: () => 'chosen' | 'os_default',
  ): {
    emitted: { action_category: string; payload: Record<string, unknown> }[];
    d: ReturnType<typeof createPrintDispatcher>;
    rows: unknown[];
    warn: ReturnType<typeof vi.fn>;
  } {
    const warn = vi.fn();
    const emitted: { action_category: string; payload: Record<string, unknown> }[] = [];
    const rows: unknown[] = [];
    const pipeline: PrintPipeline = {
      render: () => Promise.resolve(result),
      printRendered: () => Promise.resolve(result),
    };
    const d = createPrintDispatcher({
      pipeline,
      printEventsRepo: { insert: (row) => rows.push(row) } as unknown as PrintEventsRepository,
      auditEmitter: {
        emitRaw: (e: { action_category: string; payload: Record<string, unknown> }) => {
          emitted.push(e);
        },
      } as unknown as SaleAuditEmitter,
      now: () => '2026-10-26T10:00:00.000Z',
      newPrintEventId: () => 'pe-1',
      logger: { info: vi.fn(), warn },
      ...(printerSource === undefined ? {} : { printerSource }),
    });
    return { emitted, d, rows, warn };
  }

  it('stamps the chosen printer source on a first print', async () => {
    const { emitted, d } = dispatcher({ ok: true, render_path: 'os_print' }, () => 'chosen');
    await d.dispatchFirstPrint(PAYLOAD, CTX);
    expect(emitted[0]).toMatchObject({
      action_category: 'sale.receipt.printed',
      payload: { sale_id: 'sale-1', render_path: 'os_print', printer_source: 'chosen' },
    });
  });

  it('stamps os_default when no printer was chosen', async () => {
    const { emitted, d } = dispatcher({ ok: true, render_path: 'os_print' }, () => 'os_default');
    await d.dispatchFirstPrint(PAYLOAD, CTX);
    expect(emitted[0]?.payload['printer_source']).toBe('os_default');
  });

  it('writes no printer_source without the port, on the ESC/POS path, or on other categories', async () => {
    const none = dispatcher({ ok: true, render_path: 'os_print' });
    await none.d.dispatchFirstPrint(PAYLOAD, CTX);
    expect(none.emitted[0]?.payload).not.toHaveProperty('printer_source');

    const escpos = dispatcher({ ok: true, render_path: 'escpos_direct' }, () => 'chosen');
    await escpos.d.dispatchFirstPrint(PAYLOAD, CTX);
    expect(escpos.emitted[0]?.payload).not.toHaveProperty('printer_source');

    const source = vi.fn(() => 'chosen' as const);
    const reprint = dispatcher({ ok: true, render_path: 'os_print' }, source);
    await reprint.d.dispatchReprint(PAYLOAD, CTX, {
      duplicateCopySequenceNumber: 1,
      sellingOperatorId: 'user_cashier',
    });
    await reprint.d.dispatchRetryPrint(PAYLOAD, CTX, ['pe-0']);
    expect(reprint.emitted).toHaveLength(2);
    expect(reprint.emitted.some((e) => 'printer_source' in e.payload)).toBe(false);
    expect(source).not.toHaveBeenCalled();
  });

  it('a printer_source read that throws never costs the print its row or success audit', async () => {
    const { emitted, d, rows, warn } = dispatcher({ ok: true, render_path: 'os_print' }, () => {
      throw new RangeError('db closed');
    });
    const out = await d.dispatchFirstPrint(PAYLOAD, CTX);
    expect(out.result.ok).toBe(true);
    expect(rows).toEqual([expect.objectContaining({ outcome: 'success' })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.action_category).toBe('sale.receipt.printed');
    // Omitted, never guessed as os_default.
    expect(emitted[0]?.payload).not.toHaveProperty('printer_source');
    expect(warn).toHaveBeenCalledWith({
      msg: 'receipt.printer_source_unavailable',
      sale_id: 'sale-1',
      print_event_id: 'pe-1',
      err_name: 'RangeError',
    });
  });

  it('reads printer_source only after a successful OS print', async () => {
    const source = vi.fn(() => 'chosen' as const);
    const failed = dispatcher(
      { ok: false, render_path: 'os_print', failure_reason: 'os_print_error' },
      source,
    );
    await failed.d.dispatchFirstPrint(PAYLOAD, CTX);
    const escpos = dispatcher({ ok: true, render_path: 'escpos_direct' }, source);
    await escpos.d.dispatchFirstPrint(PAYLOAD, CTX);
    expect(source).not.toHaveBeenCalled();
  });

  it('a failed print (e.g. the chosen printer is missing) records a failure row and print_failed', async () => {
    const { emitted, d, rows } = dispatcher(
      { ok: false, render_path: 'os_print', failure_reason: 'os_print_error' },
      () => 'chosen',
    );
    const out = await d.dispatchFirstPrint(PAYLOAD, CTX);
    expect(out.result.ok).toBe(false);
    expect(rows).toEqual([expect.objectContaining({ outcome: 'failure' })]);
    expect(emitted[0]?.action_category).toBe('sale.receipt.print_failed');
  });
});
