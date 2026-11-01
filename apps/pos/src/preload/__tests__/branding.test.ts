import { describe, expect, it, vi } from 'vitest';

import { createBrandingBridge } from '../branding.js';
import { BRANDING_IPC_CHANNELS, parseBrandingSnapshot } from '../../shared/branding/types.js';

/** RT-475 §A4 — the preload validates every branding payload before the renderer sees it. */

type Listener = (event: unknown, payload: unknown) => void;

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const image = { width: 100, height: 25, src1x: PNG, src2x: PNG };
const logo = {
  v: 1,
  kind: 'logo',
  displayName: 'Al Nour',
  card: false,
  slots: { boot: image, pairing: image, sign_in: image, lock: image },
};

function fakeRenderer(answer: unknown) {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    invoke: vi.fn(() => Promise.resolve(answer)),
    on: (channel: string, listener: Listener) => listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
  };
}

describe('RT-475 — parseBrandingSnapshot', () => {
  it('accepts the three kinds', () => {
    expect(parseBrandingSnapshot({ v: 1, kind: 'none' })).toEqual({ v: 1, kind: 'none' });
    expect(parseBrandingSnapshot({ v: 1, kind: 'name', displayName: 'X' })).toEqual({
      v: 1,
      kind: 'name',
      displayName: 'X',
    });
    expect(parseBrandingSnapshot(logo)).toEqual(logo);
  });

  it.each([
    ['a file path', { ...image, src1x: 'file:///C:/logo.png' }],
    ['a network URL', { ...image, src2x: 'https://bc.test/logo.png' }],
    ['an SVG data URI', { ...image, src1x: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    ['a size over the box', { ...image, width: 129 }],
    ['a zero size', { ...image, height: 0 }],
  ])('refuses %s', (_label, signIn) => {
    expect(parseBrandingSnapshot({ ...logo, slots: { ...logo.slots, sign_in: signIn } })).toBe(
      null,
    );
  });

  it('refuses an unknown kind, a missing slot, an empty or over-long name', () => {
    expect(parseBrandingSnapshot({ v: 1, kind: 'splash' })).toBeNull();
    expect(parseBrandingSnapshot({ ...logo, slots: { boot: image } })).toBeNull();
    expect(parseBrandingSnapshot({ v: 1, kind: 'name', displayName: '' })).toBeNull();
    expect(parseBrandingSnapshot({ v: 1, kind: 'name', displayName: 'x'.repeat(81) })).toBeNull();
    expect(parseBrandingSnapshot({ v: 2, kind: 'none' })).toBeNull();
  });
});

describe('RT-475 — branding preload bridge', () => {
  it('get() invokes branding:get with {} and returns the validated snapshot', async () => {
    const renderer = fakeRenderer(logo);
    await expect(createBrandingBridge(renderer).get()).resolves.toEqual(logo);
    expect(renderer.invoke).toHaveBeenCalledWith(BRANDING_IPC_CHANNELS.GET, {});
  });

  it('get() rejects a refusal or a malformed answer with a fixed message', async () => {
    const renderer = fakeRenderer({ kind: 'refused', reason: 'invalid_input' });
    await expect(createBrandingBridge(renderer).get()).rejects.toThrow('branding_unavailable');
  });

  it('onChanged delivers valid pushes only and unsubscribes', () => {
    const renderer = fakeRenderer(null);
    const cb = vi.fn();
    const off = createBrandingBridge(renderer).onChanged(cb);
    const listener = renderer.listeners.get(BRANDING_IPC_CHANNELS.CHANGED);
    listener?.({ sender: 'x' }, { v: 1, kind: 'bogus' });
    listener?.({ sender: 'x' }, logo);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(logo);
    off();
    expect(renderer.listeners.has(BRANDING_IPC_CHANNELS.CHANGED)).toBe(false);
  });
});
