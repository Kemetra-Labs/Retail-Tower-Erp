import { useSyncExternalStore } from 'react';

import type { BrandingBridgeAPI, PairingBridgeAPI } from '../../shared/bridge-api';
import type { BrandingSnapshot } from '../../shared/branding/types';

/**
 * RT-475 — the renderer's copy of the tenant branding (spec 039 FR-33/FR-36).
 *
 * Started once just before React mounts. The read is answered from main's
 * memoized copy of the local cache and never waits on the network. Nothing
 * ever waits on it: routing does not read it, and a screen with no snapshot
 * yet renders exactly today's screen. If it answers after the boot screen's
 * first paint, the boot logo appears then (a known residual, see the PR).
 *
 * Kept current by the `branding:changed` push (the worker replaced the cache)
 * and re-read on every pairing change. A pairing change clears it first, so a
 * re-pair can never show the previous tenant's logo while the read is pending.
 */

type Listener = () => void;

let current: BrandingSnapshot | undefined;
let generation = 0;
/** True between a pairing change and the re-read's answer: pushes are ignored. */
let rescoping = false;
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
      if (mine !== generation) return;
      rescoping = false;
      set(snapshot);
    })
    .catch(() => {
      // Decorative: a failed read leaves today's screens.
      if (mine !== generation) return;
      rescoping = false;
      set(undefined);
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
    // A push built before a pairing change may carry the previous scope.
    if (rescoping) return;
    generation += 1;
    set(snapshot);
  });
  const offPairing = pairing?.onStatusChanged?.(() => {
    rescoping = true;
    set(undefined);
    refresh(branding);
  });
  return () => {
    offChanged();
    offPairing?.();
  };
}

/**
 * A rendition of `snapshot` failed to decode: show today's screens until the
 * next push or pairing change. Ignored when the snapshot was already replaced.
 */
export function dropUndecodableBranding(snapshot: BrandingSnapshot): void {
  if (current === snapshot) set({ v: 1, kind: 'none' });
}

/** Test-only: drop the snapshot and pending reads. */
export function resetBrandingForTests(snapshot?: BrandingSnapshot): void {
  generation += 1;
  rescoping = false;
  set(snapshot);
}
