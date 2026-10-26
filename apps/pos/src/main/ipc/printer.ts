/**
 * RT-886 — `printer:*` IPC.
 *
 * Registered on the guarded `ipcMain` (sender-origin guard + locked-session
 * guard: none of these channels is on the locked allowlist, so a locked session
 * is refused before any handler runs). Every handler then reaches the service,
 * whose first step is the live-session check (any role).
 *
 * Closed shapes: `list`, `get` and `testPrint` take no argument; `set` takes
 * `{ choice }` and nothing else. Anything else answers `invalid_input` and
 * reaches nothing. An unexpected failure is logged by its error name only and
 * answers `printer_unavailable`.
 */
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import {
  PRINTER_IPC_CHANNELS,
  PRINTER_NAME_MAX_LENGTH,
  type PrinterChoice,
  type PrinterRefused,
  type PrinterSetRequest,
} from '../../shared/printer/types.js';
import type { PrinterService } from '../printer/printer-service.js';

const INVALID: PrinterRefused = { kind: 'refused', reason: 'invalid_input' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

/** A queue name: non-empty, bounded, no control characters. */
export function isPrinterName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PRINTER_NAME_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function readChoice(value: unknown): PrinterChoice | null {
  if (closed(value, ['source']) && value['source'] === 'os_default') {
    return { source: 'os_default' };
  }
  if (closed(value, ['source', 'printer_name']) && value['source'] === 'chosen') {
    const name = value['printer_name'];
    return isPrinterName(name) ? { source: 'chosen', printer_name: name } : null;
  }
  return null;
}

export function readSetRequest(value: unknown): PrinterSetRequest | null {
  if (!closed(value, ['choice'])) return null;
  const choice = readChoice(value['choice']);
  return choice === null ? null : { choice };
}

export interface PrinterIpcDeps {
  service: PrinterService;
  logger: Pick<Logger, 'warn'>;
}

export function registerPrinterHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: PrinterIpcDeps,
): void {
  const { service, logger } = deps;
  const run = async <T>(op: string, fn: () => Promise<T>): Promise<T | PrinterRefused> => {
    try {
      return await fn();
    } catch (error) {
      logger.warn(
        { op, error: error instanceof Error ? error.name : typeof error },
        'printer:failed',
      );
      return { kind: 'refused', reason: 'printer_unavailable' };
    }
  };

  ipcMain.handle(PRINTER_IPC_CHANNELS.LIST, (_event, request: unknown) =>
    request === undefined ? run('list', () => service.list()) : INVALID,
  );
  ipcMain.handle(PRINTER_IPC_CHANNELS.GET, (_event, request: unknown) =>
    request === undefined ? run('get', () => service.get()) : INVALID,
  );
  ipcMain.handle(PRINTER_IPC_CHANNELS.SET, (_event, request: unknown) => {
    const req = readSetRequest(request);
    return req === null ? INVALID : run('set', () => service.set(req));
  });
  ipcMain.handle(PRINTER_IPC_CHANNELS.TEST_PRINT, (_event, request: unknown) =>
    request === undefined ? run('testPrint', () => service.testPrint()) : INVALID,
  );
}
