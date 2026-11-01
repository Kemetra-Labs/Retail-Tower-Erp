/**
 * RT-475 — `branding:get` IPC registration and the `branding:changed` push
 * (spec 039 FR-33; §A4 record `docs/security-review/RT-475/`).
 *
 * One read-only invoke. It accepts exactly `{}` (INP-1); anything else gets
 * `INVALID` and never reaches the service. Registered on the guarded ipcMain
 * (sender guard) and allowlisted while the session is locked (the lock screen
 * shows the logo). Not session-gated: the sign-in and pairing screens run with
 * no session. The scope comes from the pairing store in main, never from the
 * renderer.
 *
 * What leaves main is rebuilt by `parseBrandingSnapshot`: a closed kind, a
 * bounded display name, bounded sizes and `data:image/png;base64` URIs only.
 */
import type { IpcMain } from 'electron';

import {
  BRANDING_INVALID,
  BRANDING_IPC_CHANNELS,
  BRANDING_NONE,
  parseBrandingSnapshot,
  type BrandingInvalid,
  type BrandingSnapshot,
} from '../../shared/branding/types.js';

export interface BrandingHandlerDeps {
  snapshot: () => Promise<BrandingSnapshot>;
}

/** A plain object with no own keys — nothing else is a valid request. */
function isEmptyObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).length === 0;
}

/** The snapshot as the renderer may see it; anything off-shape reads as `none`. */
async function safeSnapshot(deps: BrandingHandlerDeps): Promise<BrandingSnapshot> {
  return parseBrandingSnapshot(await deps.snapshot()) ?? BRANDING_NONE;
}

export function registerBrandingHandlers(ipcMain: IpcMain, deps: BrandingHandlerDeps): void {
  ipcMain.handle(
    BRANDING_IPC_CHANNELS.GET,
    (_event, ...args: unknown[]): Promise<BrandingSnapshot | BrandingInvalid> =>
      args.length === 1 && isEmptyObject(args[0])
        ? safeSnapshot(deps)
        : Promise.resolve(BRANDING_INVALID),
  );
}

export interface BrandingPushDeps extends BrandingHandlerDeps {
  send: (snapshot: BrandingSnapshot) => void;
  onError?: (err: unknown) => void;
}

/**
 * Pushes the current snapshot to the windows (after the worker replaced the
 * cache). A send that throws (a window closing) never reaches the worker.
 */
export async function pushBrandingSnapshot(deps: BrandingPushDeps): Promise<void> {
  try {
    deps.send(await safeSnapshot(deps));
  } catch (err) {
    deps.onError?.(err);
  }
}
