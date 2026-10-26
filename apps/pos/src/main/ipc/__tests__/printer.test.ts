/**
 * RT-886 — `printer:*` IPC: closed shapes, the live-session gate for any role
 * (a signed-out caller is refused, a cashier is served), the locked-session
 * guard in front of every channel, and a generic refusal on an unexpected
 * failure (logged by error name only).
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { PRINTER_IPC_CHANNELS } from '../../../shared/printer/types.js';
import type { PrinterChoice } from '../../../shared/printer/types.js';
import { createPrinterService, type PrinterOperatorScope } from '../../printer/printer-service.js';
import type { PrinterService } from '../../printer/printer-service.js';
import { isPrinterName, readSetRequest, registerPrinterHandlers } from '../printer.js';
import { createSessionLockGuardedIpcMain, SessionLockedError } from '../session-lock-guard.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpc(): { ipc: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, listener: Handler) => {
      handlers.set(channel, listener);
    },
    on: vi.fn(),
  } as unknown as IpcMain;
  return { ipc, handlers };
}

const EVENT = {} as IpcMainInvokeEvent;

const CASHIER: PrinterOperatorScope = {
  operator_id: 'user_cashier',
  operator_session_id: 'sess-1',
  tenant_id: 't-1',
  branch_id: 'b-1',
  terminal_id: 'term-1',
};

function realService(session: () => PrinterOperatorScope | null): {
  service: PrinterService;
  audit: ReturnType<typeof vi.fn>;
  printed: ReturnType<typeof vi.fn>;
} {
  let saved: PrinterChoice | null = null;
  const audit = vi.fn();
  const printed = vi.fn(() =>
    Promise.resolve({ ok: true as const, render_path: 'os_print' as const }),
  );
  const service = createPrinterService({
    getSession: session,
    isSessionLocked: () => false,
    repo: {
      get: () => saved,
      set: (choice) => {
        saved = choice;
      },
    },
    listPrinters: () => Promise.resolve([{ name: 'XP-80C' }]),
    printer: { printRendered: printed },
    audit: { emit: audit },
    transaction: (fn) => {
      fn();
    },
    now: () => '2026-10-26T10:00:00.000Z',
    newEventId: () => 'evt-1',
  });
  return { service, audit, printed };
}

describe('printer IPC validators', () => {
  it('set: a closed choice, nothing else', () => {
    expect(readSetRequest({ choice: { source: 'os_default' } })).toEqual({
      choice: { source: 'os_default' },
    });
    expect(readSetRequest({ choice: { source: 'chosen', printer_name: 'XP-80C' } })).toEqual({
      choice: { source: 'chosen', printer_name: 'XP-80C' },
    });
    for (const bad of [
      undefined,
      null,
      [],
      {},
      { choice: null },
      { choice: { source: 'os_default', printer_name: 'XP-80C' } },
      { choice: { source: 'chosen' } },
      { choice: { source: 'chosen', printer_name: '' } },
      { choice: { source: 'chosen', printer_name: 7 } },
      { choice: { source: 'escpos', printer_name: 'XP' } },
      { choice: { source: 'os_default' }, operator_id: 'forged' },
    ]) {
      expect(readSetRequest(bad)).toBeNull();
    }
  });

  it('a printer name is bounded and has no control characters', () => {
    expect(isPrinterName('BIXOLON SRP-330II (Copy 1)')).toBe(true);
    expect(isPrinterName('\\\\server\\XP-80C')).toBe(true);
    expect(isPrinterName('x'.repeat(256))).toBe(true);
    expect(isPrinterName('x'.repeat(257))).toBe(false);
    expect(isPrinterName('bad\nname')).toBe(false);
    expect(isPrinterName('bad\u0000')).toBe(false);
  });
});

describe('printer IPC handlers — session gate (any role)', () => {
  it('refuses a signed-out caller on every channel and prints nothing', async () => {
    const { ipc, handlers } = fakeIpc();
    const { service, audit, printed } = realService(() => null);
    registerPrinterHandlers(ipc, { service, logger: { warn: vi.fn() } });
    const refusal = { kind: 'refused', reason: 'not_signed_in' };
    expect(await handlers.get(PRINTER_IPC_CHANNELS.LIST)?.(EVENT)).toEqual(refusal);
    expect(await handlers.get(PRINTER_IPC_CHANNELS.GET)?.(EVENT)).toEqual(refusal);
    expect(
      await handlers.get(PRINTER_IPC_CHANNELS.SET)?.(EVENT, { choice: { source: 'os_default' } }),
    ).toEqual(refusal);
    expect(await handlers.get(PRINTER_IPC_CHANNELS.TEST_PRINT)?.(EVENT)).toEqual(refusal);
    expect(printed).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('serves a cashier: list, choose and test print (AC1)', async () => {
    const { ipc, handlers } = fakeIpc();
    const { service, audit, printed } = realService(() => CASHIER);
    registerPrinterHandlers(ipc, { service, logger: { warn: vi.fn() } });
    expect(await handlers.get(PRINTER_IPC_CHANNELS.LIST)?.(EVENT)).toEqual({
      kind: 'ok',
      printers: [{ name: 'XP-80C' }],
    });
    const choice = { source: 'chosen', printer_name: 'XP-80C' };
    expect(await handlers.get(PRINTER_IPC_CHANNELS.SET)?.(EVENT, { choice })).toEqual({
      kind: 'ok',
      choice,
    });
    expect(await handlers.get(PRINTER_IPC_CHANNELS.GET)?.(EVENT)).toEqual({ kind: 'ok', choice });
    expect(await handlers.get(PRINTER_IPC_CHANNELS.TEST_PRINT)?.(EVENT)).toEqual({
      kind: 'accepted',
      choice,
    });
    expect(printed).toHaveBeenCalledTimes(1);
    expect(
      audit.mock.calls.map(([e]) => (e as { action_category: string }).action_category),
    ).toEqual(['terminal.printer.selected', 'terminal.printer.test_printed']);
  });

  it('refuses a locked session before any printer handler runs', async () => {
    const { ipc, handlers } = fakeIpc();
    const set = vi.fn();
    const testPrint = vi.fn();
    const service: PrinterService = { list: vi.fn(), get: vi.fn(), set, testPrint };
    registerPrinterHandlers(
      createSessionLockGuardedIpcMain(ipc, () => true),
      {
        service,
        logger: { warn: vi.fn() },
      },
    );
    for (const channel of Object.values(PRINTER_IPC_CHANNELS)) {
      await expect(handlers.get(channel)?.(EVENT)).rejects.toBeInstanceOf(SessionLockedError);
    }
    expect(testPrint).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('printer IPC handlers — shapes and failures', () => {
  function register(service: Partial<PrinterService> = {}) {
    const { ipc, handlers } = fakeIpc();
    const spies = {
      list: vi.fn(() => Promise.resolve({ kind: 'ok' as const, printers: [] })),
      get: vi.fn(() => Promise.resolve({ kind: 'ok' as const, choice: null })),
      set: vi.fn(),
      testPrint: vi.fn(),
    };
    const warn = vi.fn();
    registerPrinterHandlers(ipc, { service: { ...spies, ...service }, logger: { warn } });
    return { handlers, spies, warn };
  }

  it('answers invalid_input for any argument where none is taken, or a bad set', async () => {
    const { handlers, spies } = register();
    const invalid = { kind: 'refused', reason: 'invalid_input' };
    expect(await handlers.get(PRINTER_IPC_CHANNELS.LIST)?.(EVENT, {})).toEqual(invalid);
    expect(await handlers.get(PRINTER_IPC_CHANNELS.GET)?.(EVENT, 'x')).toEqual(invalid);
    expect(await handlers.get(PRINTER_IPC_CHANNELS.TEST_PRINT)?.(EVENT, { printer: 'x' })).toEqual(
      invalid,
    );
    expect(await handlers.get(PRINTER_IPC_CHANNELS.SET)?.(EVENT, { choice: {} })).toEqual(invalid);
    expect(spies.list).not.toHaveBeenCalled();
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.testPrint).not.toHaveBeenCalled();
  });

  it('maps a thrown failure to printer_unavailable and logs its name only', async () => {
    const { handlers, warn } = register({
      testPrint: () => Promise.reject(new RangeError('XP-80C exploded')),
      // A non-Error rejection is logged by its type only.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      get: () => Promise.reject('string failure'),
    });
    expect(await handlers.get(PRINTER_IPC_CHANNELS.TEST_PRINT)?.(EVENT)).toEqual({
      kind: 'refused',
      reason: 'printer_unavailable',
    });
    expect(await handlers.get(PRINTER_IPC_CHANNELS.GET)?.(EVENT)).toEqual({
      kind: 'refused',
      reason: 'printer_unavailable',
    });
    expect(warn).toHaveBeenCalledWith({ op: 'testPrint', error: 'RangeError' }, 'printer:failed');
    expect(warn).toHaveBeenCalledWith({ op: 'get', error: 'string' }, 'printer:failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('XP-80C');
  });
});
