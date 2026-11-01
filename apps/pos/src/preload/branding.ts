import type { BrandingBridgeAPI } from '../shared/bridge-api.js';
import { BRANDING_IPC_CHANNELS, parseBrandingSnapshot } from '../shared/branding/types.js';

/**
 * RT-475 — preload side of the tenant branding bridge: `get()` over
 * `branding:get` and `onChanged(cb)` over the `branding:changed` push.
 * Read-only: there is no write, refresh or path channel.
 *
 * Every payload is rebuilt by `parseBrandingSnapshot` (known fields only, PNG
 * data URIs only). A payload that fails is never coerced: `get()` rejects with
 * a fixed message, and a push is dropped with no callback. Electron's
 * `IpcRendererEvent` is never passed to the renderer.
 */

type Listener = (event: unknown, payload: unknown) => void;

interface RendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
}

export function createBrandingBridge(renderer: RendererLike): BrandingBridgeAPI {
  return {
    async get() {
      const snapshot = parseBrandingSnapshot(await renderer.invoke(BRANDING_IPC_CHANNELS.GET, {}));
      if (snapshot === null) throw new Error('branding_unavailable');
      return snapshot;
    },
    onChanged(cb) {
      const listener: Listener = (_event, payload) => {
        const snapshot = parseBrandingSnapshot(payload);
        if (snapshot !== null) cb(snapshot);
      };
      renderer.on(BRANDING_IPC_CHANNELS.CHANGED, listener);
      return () => {
        renderer.removeListener(BRANDING_IPC_CHANNELS.CHANGED, listener);
      };
    },
  };
}
