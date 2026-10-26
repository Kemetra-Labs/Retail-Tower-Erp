import { BrowserWindow } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PrinterInfoLike } from '../receipts/os-print-transport.js';

/** Sends one payload to every open app window; a closing one never starves the others. */
export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Skip it; the next change reaches the windows still open.
    }
  }
}

/**
 * The trusted renderer origin allow-list. Dev = the Vite server; prod = the
 * packaged renderer dir on disk (`pathToFileURL` → a normalized `file://` URL,
 * forward slashes on Windows). SINGLE SOURCE OF TRUTH (#370): consumed by BOTH
 * the `will-navigate` block in `createWindow` AND the IPC `createSenderGuardedIpcMain`
 * wiring in `whenReady`, so the navigation check and the IPC sender check can
 * never drift apart.
 */
export function resolveRendererOrigin(isDev: boolean, mainDir: string): string {
  return isDev
    ? 'http://localhost:5173'
    : pathToFileURL(path.join(mainDir, '../renderer/')).toString();
}

/**
 * Enumerate the system printers via a live window's webContents
 * (`getPrintersAsync` is a webContents method). Returns `[]` if no window is
 * available yet — the OS-print transport then resolves an empty device name and
 * Electron falls back to the system default printer. Wrapped so a discovery
 * failure never throws into the print path (the print still attempts the
 * default printer; a real fault surfaces as a recorded failure + banner).
 */
export async function getCurrentPrinters(): Promise<PrinterInfoLike[]> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win === undefined) return [];
  try {
    const printers = await win.webContents.getPrintersAsync();
    // Electron 40's PrinterInfo carries no portable `isDefault` flag (the
    // default lives in platform-specific `options`). We do NOT try to infer it
    // here: when no device is configured, the transport resolves an empty
    // deviceName and Electron's silent-print path picks the system default
    // itself. The list is surfaced only so a CONFIGURED exact name can be
    // honored / logged.
    return printers.map((p) => ({ name: p.name, isDefault: false }));
  } catch {
    return [];
  }
}
