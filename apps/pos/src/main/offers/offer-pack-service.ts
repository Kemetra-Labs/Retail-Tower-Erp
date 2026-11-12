/**
 * RT-1339 (RT-286 S7) — the till's holder of the Offer Pack and its trusted time
 * (spec 048 §7, OD-8; `posGetOfferPack`).
 *
 * "Now" is never the workstation wall clock. It is the server time of the last
 * successful read (the body's `issuedAt` on a 200, `X-Server-Time` on a 304) plus
 * the time elapsed since that read began, on a MONOTONIC clock. The monotonic
 * reading is taken when the request STARTS, so network latency can only make "now"
 * earlier, which ends an offer early and never extends it.
 *
 * The anchor lives in memory only. A restart loses the monotonic clock, so until
 * the next successful read the till can neither compute "now" nor prove the Pack
 * fresh: the loaded Pack is `unproven` and applies no offer (the customer pays the
 * regular price, and the cashier sees «العرض غير متاح بدون اتصال»).
 *
 * Freshness: a Pack is `fresh` for `freshnessWindowHours` after the last
 * successful read. Past it the Pack is `stale`: no offer applies. An `online_only`
 * offer additionally needs a successful read within `ONLINE_PROOF_MS`: the till
 * polls every few minutes, so two missed polls mean it cannot prove it reaches
 * Backend-Core, and the offer is skipped (fail safe).
 *
 * Pure with injected clocks and store; never throws.
 */
import { readOfferPack, instantMsOf, type OfferPack } from './offer-pack.js';

/** A successful read within this long counts as "online" for an `online_only` offer. */
export const ONLINE_PROOF_MS = 10 * 60 * 1_000;

export type OfferPackView =
  /** Never read, nothing stored: no offer is known. */
  | { readonly kind: 'none' }
  /** A Pack is held but its age cannot be proven (restart, or a read failed since boot). */
  | { readonly kind: 'unproven'; readonly pack: OfferPack }
  /** The freshness window elapsed since the last successful read. */
  | { readonly kind: 'stale'; readonly pack: OfferPack }
  | {
      readonly kind: 'fresh';
      readonly pack: OfferPack;
      /** Trusted "now" (epoch ms): `issuedAt` + monotonic elapsed. */
      readonly nowMs: number;
      /** A successful read within `ONLINE_PROOF_MS`. */
      readonly onlineProven: boolean;
    };

/** What survives a restart: the Pack and its ETag, so a 304 can confirm it. Never a time anchor. */
export interface StoredOfferPack {
  readonly tenantId: string;
  readonly etag: string;
  readonly body: unknown;
}

export interface OfferPackStore {
  load(): StoredOfferPack | null;
  save(entry: StoredOfferPack): void;
  clear(): void;
}

export interface OfferPackServiceDeps {
  /** A monotonic millisecond clock (`performance.now()`), never the wall clock. */
  readonly monotonicMs: () => number;
  readonly store: OfferPackStore;
}

interface Anchor {
  readonly serverMs: number;
  readonly monoMs: number;
}

export interface OfferPackService {
  /** Load the stored Pack for this tenant (once, at start). A Pack of another tenant is dropped. */
  restore(tenantId: string): void;
  /** The ETag to send in `If-None-Match`, only while a readable Pack is held. */
  conditionalEtag(): string | null;
  /** Record a 200. `monoAtStartMs` is the monotonic reading taken before the request. */
  applyOk(input: {
    tenantId: string;
    body: unknown;
    etag: string | null;
    serverTime: string | null;
    monoAtStartMs: number;
  }): boolean;
  /** Record a 304 (the held Pack is current). False when the header is unreadable or no Pack is held. */
  applyNotModified(input: { serverTime: string | null; monoAtStartMs: number }): boolean;
  view(): OfferPackView;
}

export function createOfferPackService(deps: OfferPackServiceDeps): OfferPackService {
  let pack: OfferPack | null = null;
  let etag: string | null = null;
  let anchor: Anchor | null = null;

  return {
    restore(tenantId) {
      const stored = deps.store.load();
      if (stored === null) return;
      const readable = stored.tenantId === tenantId ? readOfferPack(stored.body) : null;
      if (readable === null) {
        deps.store.clear();
        return;
      }
      pack = readable;
      etag = stored.etag;
      anchor = null;
    },

    conditionalEtag() {
      return pack === null ? null : etag;
    },

    applyOk({ tenantId, body, etag: nextEtag, serverTime, monoAtStartMs }) {
      const read = readOfferPack(body);
      const headerMs = serverTime === null ? null : instantMsOf(serverTime);
      // The contract says the header equals the body's `issuedAt`; a missing one is tolerated, a different one is not.
      if (
        read === null ||
        nextEtag === null ||
        (headerMs !== null && headerMs !== read.issuedAtMs)
      ) {
        return false;
      }
      pack = read;
      etag = nextEtag;
      anchor = { serverMs: read.issuedAtMs, monoMs: monoAtStartMs };
      deps.store.save({ tenantId, etag: nextEtag, body });
      return true;
    },

    applyNotModified({ serverTime, monoAtStartMs }) {
      const serverMs = serverTime === null ? null : instantMsOf(serverTime);
      if (pack === null || serverMs === null) return false;
      anchor = { serverMs, monoMs: monoAtStartMs };
      return true;
    },

    view() {
      if (pack === null) return { kind: 'none' };
      if (anchor === null) return { kind: 'unproven', pack };
      const elapsed = deps.monotonicMs() - anchor.monoMs;
      if (elapsed < 0 || elapsed >= pack.freshnessWindowHours * 3_600_000) {
        return { kind: 'stale', pack };
      }
      return {
        kind: 'fresh',
        pack,
        nowMs: anchor.serverMs + elapsed,
        onlineProven: elapsed <= ONLINE_PROOF_MS,
      };
    },
  };
}
