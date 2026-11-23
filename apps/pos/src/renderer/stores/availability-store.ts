import { create } from 'zustand';

import type {
  AvailabilityBridgeAPI,
  AvailabilityFreshness,
  AvailabilityRowState,
} from '../../shared/availability/types';
import type { PreloadBridgeAPI } from '../../shared/bridge-api';

/**
 * RT-1578 (RT-1511 S3, spec 013) — what the renderer knows about store availability: the cache freshness and
 * the display state of the products on screen (search results, cart lines), all read from main's local cache.
 *
 * Display only. Nothing here is consulted by the cart, checkout or any add path (FR-5), and the bridge it
 * reads has no reservation or stock call (FR-6). A product with no answer yet has no badge at all; main
 * answers «unknown» for a product it has no record of, so a badge never says "in stock" by default.
 *
 * Lookups are batched: every badge that mounts calls `track(id)`, and one microtask later a single `bands`
 * call asks about all new ids (at most `BATCH` per call).
 */

const BATCH = 200;

interface AvailabilityStoreState {
  /** Null until main has answered once (or when its bridge is unavailable): no status text, no badges. */
  readonly freshness: AvailabilityFreshness | null;
  readonly states: Readonly<Record<string, AvailabilityRowState>>;
  readonly refreshing: boolean;
  track: (productId: string) => void;
  /** Re-read the freshness and the state of every tracked product (also when the stale window passes). */
  reload: () => Promise<void>;
  /** The manual «تحديث التوفر»: one out-of-cycle pull, then a re-read. */
  refresh: () => Promise<void>;
  reset: () => void;
}

function bridge(): AvailabilityBridgeAPI | null {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  return api?.availability ?? null;
}

let tracked: string[] = [];
let queued: string[] = [];
let flushScheduled = false;

export const useAvailabilityStore = create<AvailabilityStoreState>((set, get) => {
  /** Ask main about `ids`; a refusal or a fault leaves what is shown as it was. */
  async function load(ids: readonly string[]): Promise<void> {
    const api = bridge();
    if (api === null || ids.length === 0) return;
    try {
      const answer = await api.bands({ product_ids: ids.slice(0, BATCH) });
      if (answer.kind !== 'ok') return;
      set((s) => ({
        freshness: { state: answer.state, as_of: answer.as_of },
        states: { ...s.states, ...answer.states },
      }));
    } catch {
      // Display only: a failed read changes nothing on screen.
    }
  }

  function flush(): void {
    flushScheduled = false;
    const ids = queued;
    queued = [];
    void load(ids);
  }

  async function readStatus(): Promise<void> {
    const api = bridge();
    if (api === null) return;
    try {
      const answer = await api.status({});
      if (answer.kind === 'ok') set({ freshness: { state: answer.state, as_of: answer.as_of } });
    } catch {
      // see `load`
    }
  }

  return {
    freshness: null,
    states: {},
    refreshing: false,
    track(productId) {
      if (tracked.includes(productId)) return;
      tracked = [...tracked, productId].slice(-BATCH);
      queued = [...queued, productId];
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
    async reload() {
      await readStatus();
      await load(tracked);
    },
    async refresh() {
      if (get().refreshing) return;
      set({ refreshing: true });
      try {
        await bridge()?.refresh({});
      } catch {
        // The outcome is read back from the cache itself, which stays as it was on a failure.
      }
      await get().reload();
      set({ refreshing: false });
    },
    reset() {
      tracked = [];
      queued = [];
      set({ freshness: null, states: {}, refreshing: false });
    },
  };
});

/** How often the status line re-reads the freshness, so the stale state appears without any event. */
export const AVAILABILITY_REREAD_INTERVAL_MS = 60_000;
