/**
 * RT-1339 (RT-286 S7) — the till's holder of the Offer Pack and its trusted time
 * (spec 048 §7, OD-8; `posGetOfferPack`).
 *
 * "Now" is never the workstation wall clock. It is the server time of the last
 * successful read (the body's `issuedAt` on a 200, `X-Server-Time` on a 304) plus
 * the time elapsed since that read began, on a MONOTONIC clock. The monotonic
 * reading is taken when the request STARTS, before the server stamped its time, so
 * the elapsed time is never under-counted: an offer ends on time (never late), and
 * may start at most one round trip early.
 *
 * The wall clock is never used to APPLY an offer. It is used once, to REFUSE: if it
 * has moved on by far more than the monotonic clock since the last read (a clock
 * that stops while the machine sleeps), the Pack is `stale`, so a till that slept
 * overnight cannot go on applying offers past their end. A clock moved backwards
 * changes nothing.
 *
 * A server time that is earlier than the trusted "now" by more than a small
 * tolerance (a replayed or cached body) is refused like an off-contract Pack.
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

/** A server time this far behind the trusted "now" is a replay, not a fresh read. */
const SERVER_TIME_REGRESSION_TOLERANCE_MS = 5 * 60 * 1_000;

/** The wall clock may move this far ahead of the monotonic clock before the Pack is `stale`. */
const WALL_CLOCK_JUMP_TOLERANCE_MS = 10 * 60 * 1_000;

/**
 * A strong entity-tag (RFC 9110 section 8.8.3): the only `If-None-Match` the till ever sends. A
 * stored or served ETag that is not one is never sent (the server would answer 400 to every poll).
 */
const ENTITY_TAG = /^"[\x21\x23-\x7e]+"$/;

function isEntityTag(value: string | null): value is string {
  return value !== null && ENTITY_TAG.test(value);
}

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
  /** The wall clock (`Date.now`), read only to refuse a Pack after a sleep; default `Date.now`. */
  readonly wallMs?: () => number;
  readonly store: OfferPackStore;
}

interface Anchor {
  readonly serverMs: number;
  /** The monotonic reading at the request start: freshness and "now" count from here. */
  readonly monoMs: number;
  /** Both clocks when the answer was applied: the wall-clock sanity check counts from here. */
  readonly monoAtApplyMs: number;
  readonly wallAtApplyMs: number;
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
  /**
   * Drop the held and the stored Pack: the server has no Pack for this till (404), or the till can
   * no longer send its device token (revoked). No offer applies until a new 200.
   */
  forget(): void;
  view(): OfferPackView;
}

export function createOfferPackService(deps: OfferPackServiceDeps): OfferPackService {
  let pack: OfferPack | null = null;
  let etag: string | null = null;
  let anchor: Anchor | null = null;
  /**
   * The last anchor's server time and monotonic reading, kept when the anchor is dropped: trusted
   * time keeps moving on from it, so a replay is still refused while the Pack is unproven or gone.
   */
  let floor: Pick<Anchor, 'serverMs' | 'monoMs'> | null = null;
  const wallMs = deps.wallMs ?? ((): number => Date.now());

  function anchorAt(serverMs: number, monoMs: number): Anchor {
    return { serverMs, monoMs, monoAtApplyMs: deps.monotonicMs(), wallAtApplyMs: wallMs() };
  }

  /**
   * The latest server time this process can vouch for: the server time of the held anchor (fresh or
   * stale alike), or of the dropped one, plus the monotonic time since; null before any read.
   */
  function trustedFloorMs(): number | null {
    const from = anchor ?? floor;
    return from === null ? null : from.serverMs + Math.max(0, deps.monotonicMs() - from.monoMs);
  }

  /** True when `serverMs` is a replay: earlier than the trusted floor by more than the tolerance. */
  function isReplay(serverMs: number): boolean {
    const trusted = trustedFloorMs();
    return trusted !== null && serverMs < trusted - SERVER_TIME_REGRESSION_TOLERANCE_MS;
  }

  /** Drop the anchor, keeping it as the replay floor. */
  function dropAnchor(): void {
    if (anchor !== null) floor = { serverMs: anchor.serverMs, monoMs: anchor.monoMs };
    anchor = null;
  }

  /** A refused answer: the held Pack can no longer be proven current, so it is `unproven`. */
  function demote(): false {
    dropAnchor();
    return false;
  }

  function currentView(): OfferPackView {
    if (pack === null) return { kind: 'none' };
    if (anchor === null) return { kind: 'unproven', pack };
    const elapsed = deps.monotonicMs() - anchor.monoMs;
    const wallAhead = wallMs() - anchor.wallAtApplyMs - (deps.monotonicMs() - anchor.monoAtApplyMs);
    if (
      elapsed < 0 ||
      elapsed >= pack.freshnessWindowHours * 3_600_000 ||
      wallAhead > WALL_CLOCK_JUMP_TOLERANCE_MS
    ) {
      return { kind: 'stale', pack };
    }
    return {
      kind: 'fresh',
      pack,
      nowMs: anchor.serverMs + elapsed,
      onlineProven: elapsed <= ONLINE_PROOF_MS,
    };
  }

  return {
    restore(tenantId) {
      // A (re)start of the worker begins from nothing: no Pack, ETag or anchor of an earlier pairing.
      pack = null;
      etag = null;
      anchor = null;
      floor = null;
      const stored = deps.store.load();
      if (stored === null) return;
      const readable =
        stored.tenantId === tenantId && isEntityTag(stored.etag)
          ? readOfferPack(stored.body)
          : null;
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
      // The contract says `X-Server-Time` equals the body's `issuedAt`: both are required, and equal.
      // A refused 200 means the server has moved on from what is held: it is no longer proven current.
      if (read === null || !isEntityTag(nextEtag) || headerMs !== read.issuedAtMs) return demote();
      if (isReplay(read.issuedAtMs)) return demote();
      pack = read;
      etag = nextEtag;
      anchor = anchorAt(read.issuedAtMs, monoAtStartMs);
      deps.store.save({ tenantId, etag: nextEtag, body });
      return true;
    },

    applyNotModified({ serverTime, monoAtStartMs }) {
      const serverMs = serverTime === null ? null : instantMsOf(serverTime);
      if (pack === null || serverMs === null) return false;
      if (isReplay(serverMs)) return demote();
      anchor = anchorAt(serverMs, monoAtStartMs);
      return true;
    },

    forget() {
      dropAnchor();
      pack = null;
      etag = null;
      deps.store.clear();
    },

    view: currentView,
  };
}
