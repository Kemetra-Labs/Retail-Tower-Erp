/** RT-886 — the `printer.*` preload members invoke their channels. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRINTER_IPC_CHANNELS } from '../../shared/printer/types.js';

const ipcRendererInvoke = vi.fn(() => Promise.resolve({ kind: 'ok' }));
const exposeInMainWorld = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: { invoke: ipcRendererInvoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  contextBridge: { exposeInMainWorld },
}));

beforeEach(() => {
  ipcRendererInvoke.mockClear();
});

describe('preload printer bridge', () => {
  it('each member invokes its channel; only set carries a request', async () => {
    const { printer } = await import('../printer');
    await printer.list();
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(PRINTER_IPC_CHANNELS.LIST);
    await printer.get();
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(PRINTER_IPC_CHANNELS.GET);
    await printer.set({ choice: { source: 'os_default' } });
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(PRINTER_IPC_CHANNELS.SET, {
      choice: { source: 'os_default' },
    });
    await printer.testPrint();
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(PRINTER_IPC_CHANNELS.TEST_PRINT);
  });

  it('is exposed on window.api.printer', async () => {
    vi.resetModules();
    await import('../index');
    const api = exposeInMainWorld.mock.calls.at(-1)?.[1] as {
      printer?: Record<string, unknown>;
    };
    expect(Object.keys(api.printer ?? {}).sort()).toEqual(['get', 'list', 'set', 'testPrint']);
  });
});
