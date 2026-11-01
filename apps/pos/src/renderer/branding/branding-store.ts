import { useSyncExternalStore } from 'react';

import type { BrandingBridgeAPI, PairingBridgeAPI } from '../../shared/bridge-api';
import type { BrandingSnapshot } from '../../shared/branding/types';

/**
 * RT-475 — the renderer's copy of the tenant branding (spec 039 FR-33/FR-36).
 *
 * Started once before React mounts, so the boot screen usually has the
 * snapshot for its first paint; the read is the local cache in main and never
 * waits on the network. Nothing ever waits on it: routing does not read it,
 * and a screen with no snapshot yet renders exactly today's screen.
 *
 * Kept current by the `branding:changed` push (the worker replaced the cache)
 * and re-read on every pairing change. A pairing change clears it first, so a
 * re-pair can never show the previous tenant's logo while the read is pending.
 */

type Listener = () => void;

let current: BrandingSnapshot | undefined;
let generation = 0;
const listeners = new Set<Listener>();

function set(next: BrandingSnapshot | undefined): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): BrandingSnapshot | undefined {
  return current;
}

/** The current snapshot; undefined until the first read answers. */
export function useBranding(): BrandingSnapshot | undefined {
  return useSyncExternalStore(subscribe, read, read);
}

function refresh(branding: BrandingBridgeAPI): void {
  generation += 1;
  const mine = generation;
  branding
    .get()
    .then((snapshot) => {
      if (mine === generation) set(snapshot);
    })
    .catch(() => {
      // Decorative: a failed read leaves today's screens.
      if (mine === generation) set(undefined);
    });
}

/**
 * Starts the feed; returns the stop. A missing bridge (an older preload, a
 * test) leaves every screen as it is today.
 */
export function startBrandingFeed(
  branding: BrandingBridgeAPI | undefined,
  pairing?: Pick<PairingBridgeAPI, 'onStatusChanged'>,
): () => void {
  if (branding === undefined) return () => undefined;
  refresh(branding);
  const offChanged = branding.onChanged((snapshot) => {
    generation += 1;
    set(snapshot);
  });
  const offPairing = pairing?.onStatusChanged?.(() => {
    set(undefined);
    refresh(branding);
  });
  return () => {
    offChanged();
    offPairing?.();
  };
}

/** Test-only: drop the snapshot and pending reads. */
export function resetBrandingForTests(snapshot?: BrandingSnapshot): void {
  generation += 1;
  set(snapshot);
}
