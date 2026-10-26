import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllWindows } = vi.hoisted(() => ({ getAllWindows: vi.fn() }));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows } }));

import { broadcastToWindows, getCurrentPrinters, resolveRendererOrigin } from '../window.js';

/**
 * RT-893 extraction 1 — the window helpers moved verbatim out of `main/index.ts`.
 * `index.ts` cannot be imported under vitest, so the moved helpers are pinned here directly.
 */
interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: {
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
    getPrintersAsync: ReturnType<typeof vi.fn>;
  };
}

function fakeWindow(opts: { destroyed?: boolean; contentsDestroyed?: boolean } = {}): FakeWindow {
  return {
    isDestroyed: () => opts.destroyed === true,
    webContents: {
      isDestroyed: () => opts.contentsDestroyed === true,
      send: vi.fn(),
      getPrintersAsync: vi.fn(),
    },
  };
}

beforeEach(() => {
  getAllWindows.mockReset();
});

describe('broadcastToWindows', () => {
  it('sends the payload to every open window', () => {
    const a = fakeWindow();
    const b = fakeWindow();
    getAllWindows.mockReturnValue([a, b]);

    broadcastToWindows('chan', { n: 1 });

    expect(a.webContents.send).toHaveBeenCalledWith('chan', { n: 1 });
    expect(b.webContents.send).toHaveBeenCalledWith('chan', { n: 1 });
  });

  it('skips destroyed windows and destroyed web contents', () => {
    const gone = fakeWindow({ destroyed: true });
    const noContents = fakeWindow({ contentsDestroyed: true });
    const live = fakeWindow();
    getAllWindows.mockReturnValue([gone, noContents, live]);

    broadcastToWindows('chan', 1);

    expect(gone.webContents.send).not.toHaveBeenCalled();
    expect(noContents.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('a window that throws on send never starves the others', () => {
    const closing = fakeWindow();
    closing.webContents.send.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const live = fakeWindow();
    getAllWindows.mockReturnValue([closing, live]);

    expect(() => {
      broadcastToWindows('chan', 1);
    }).not.toThrow();
    expect(live.webContents.send).toHaveBeenCalledWith('chan', 1);
  });
});

describe('resolveRendererOrigin', () => {
  it('is the Vite dev server in dev', () => {
    expect(resolveRendererOrigin(true, '/app/main')).toBe('http://localhost:5173');
  });

  it('is the packaged renderer dir as a file:// URL otherwise, relative to the main dir', () => {
    const mainDir = path.join(path.sep, 'app', 'main');
    expect(resolveRendererOrigin(false, mainDir)).toBe(
      pathToFileURL(path.join(mainDir, '../renderer/')).toString(),
    );
  });
});

describe('getCurrentPrinters', () => {
  it('returns [] when no window is available yet', async () => {
    getAllWindows.mockReturnValue([]);
    await expect(getCurrentPrinters()).resolves.toEqual([]);
  });

  it('returns [] when every window is destroyed', async () => {
    getAllWindows.mockReturnValue([fakeWindow({ destroyed: true })]);
    await expect(getCurrentPrinters()).resolves.toEqual([]);
  });

  it('maps the system printers without inferring a default', async () => {
    const win = fakeWindow();
    win.webContents.getPrintersAsync.mockResolvedValue([{ name: 'EPSON TM-T20' }, { name: 'PDF' }]);
    getAllWindows.mockReturnValue([fakeWindow({ destroyed: true }), win]);

    await expect(getCurrentPrinters()).resolves.toEqual([
      { name: 'EPSON TM-T20', isDefault: false },
      { name: 'PDF', isDefault: false },
    ]);
  });

  it('never throws into the print path when discovery fails', async () => {
    const win = fakeWindow();
    win.webContents.getPrintersAsync.mockRejectedValue(new Error('spooler down'));
    getAllWindows.mockReturnValue([win]);

    await expect(getCurrentPrinters()).resolves.toEqual([]);
  });
});
