import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';

import { pushBrandingSnapshot, registerBrandingHandlers } from '../branding.js';
import {
  BRANDING_INVALID,
  BRANDING_IPC_CHANNELS,
  BRANDING_NONE,
  type BrandingSnapshot,
} from '../../../shared/branding/types.js';

/** RT-475 §A4 — the `branding:get` handler and the change push. */

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)?.({}, ...args));
  return { ipcMain, handlers, invoke };
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const image = { width: 100, height: 25, src1x: PNG, src2x: PNG };
const LOGO: BrandingSnapshot = {
  v: 1,
  kind: 'logo',
  displayName: 'صيدلية النور',
  card: true,
  slots: { boot: image, pairing: image, sign_in: image, lock: image },
};

describe('RT-475 — branding:get', () => {
  it('registers exactly one invoke channel', () => {
    const fake = fakeIpcMain();
    registerBrandingHandlers(fake.ipcMain, { snapshot: () => Promise.resolve(LOGO) });
    expect([...fake.handlers.keys()]).toEqual([BRANDING_IPC_CHANNELS.GET]);
  });

  it('answers the snapshot for exactly {}', async () => {
    const fake = fakeIpcMain();
    registerBrandingHandlers(fake.ipcMain, { snapshot: () => Promise.resolve(LOGO) });
    await expect(fake.invoke(BRANDING_IPC_CHANNELS.GET, {})).resolves.toEqual(LOGO);
  });

  it.each([[[]], [[{ tenant_id: 'x' }]], [[null]], [[{}, {}]], [['boot']]])(
    'refuses %j without reading the cache (INP-1)',
    async (args) => {
      const fake = fakeIpcMain();
      const snapshot = vi.fn(() => Promise.resolve(LOGO));
      registerBrandingHandlers(fake.ipcMain, { snapshot });
      await expect(fake.invoke(BRANDING_IPC_CHANNELS.GET, ...args)).resolves.toEqual(
        BRANDING_INVALID,
      );
      expect(snapshot).not.toHaveBeenCalled();
    },
  );

  it('never lets a path, URL or extra field out: an off-shape snapshot reads as none', async () => {
    const fake = fakeIpcMain();
    const leaky = {
      ...LOGO,
      slots: { ...LOGO.slots, boot: { ...image, src1x: 'file:///C:/cache/logo.png' } },
    };
    registerBrandingHandlers(fake.ipcMain, {
      snapshot: () => Promise.resolve(leaky as BrandingSnapshot),
    });
    await expect(fake.invoke(BRANDING_IPC_CHANNELS.GET, {})).resolves.toEqual(BRANDING_NONE);
  });

  it('drops unknown fields from a valid snapshot', async () => {
    const fake = fakeIpcMain();
    registerBrandingHandlers(fake.ipcMain, {
      snapshot: () => Promise.resolve({ ...LOGO, tenant_id: 't-1' } as BrandingSnapshot),
    });
    const answer = (await fake.invoke(BRANDING_IPC_CHANNELS.GET, {})) as Record<string, unknown>;
    expect(answer.tenant_id).toBeUndefined();
  });
});

describe('RT-475 — branding:changed push', () => {
  it('sends the sanitized snapshot', async () => {
    const send = vi.fn();
    await pushBrandingSnapshot({ snapshot: () => Promise.resolve(LOGO), send });
    expect(send).toHaveBeenCalledWith(LOGO);
  });

  it('a throwing send never reaches the caller', async () => {
    const onError = vi.fn();
    await expect(
      pushBrandingSnapshot({
        snapshot: () => Promise.resolve(LOGO),
        send: () => {
          throw new Error('window closed');
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
