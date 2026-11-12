/**
 * The tenant's LIVE offers and the Pack plan derived from them (spec 048 §7,
 * OD-6, OD-7; Jira RT-1337).
 *
 * LIVE offer: a published offer that is not ended, not archived, and whose
 * window has not closed, in at least one store of its scope (`scheduled`,
 * `active` or `paused`). Its CURRENT version is the one that counts.
 *
 * THE PACK INVARIANT (OD-7 clarification; enforced in SQL by the 0101 EXCLUDE
 * constraint): in one store, a product is in at most ONE offer. The offer
 * published EARLIEST keeps it (tie: the lower `offerId`), whatever the
 * windows, and a paused offer still keeps what it would hold, so a resume can
 * never create an overlap. The offers that lose a product are reported as
 * re-materialisation conflicts. Rows are materialised only for offers that are
 * not paused in the store.
 */
import type { PoolClient } from "pg";

import { ELIGIBLE_SET_LIMIT, eligibleProductIds, ruleSetsOf } from "./offer-eligibility";
import { deriveState, resolveWindow, windowClosed, windowEmpty, type ResolvedWindow } from "./offer-schedule";
import {
  loadLiveStores,
  loadOfferHeaders,
  loadOpenPauses,
  loadVersions,
  type OfferHeader,
  type OfferVersionRecord,
  type OpenPause,
  type StoreFact,
} from "./offers.repository";

export interface LiveOffer {
  readonly offerId: string;
  readonly version: number;
  readonly record: OfferVersionRecord;
  /** The first publish of the offer (OD-7: the earliest keeps a contested product). */
  readonly firstPublishedAt: Date;
  readonly pausedWhole: boolean;
  readonly pausedStores: ReadonlySet<string>;
  /** The stores of its scope whose window has not closed. */
  readonly holdingStores: ReadonlyArray<string>;
  /** Per store, the resolved window. */
  readonly windows: ReadonlyMap<string, ResolvedWindow>;
  /** The eligible product ids (ascending); `null` when the set is above the Pack bound. */
  readonly eligible: ReadonlyArray<string> | null;
}

export interface LoadedTenantOffers {
  readonly now: Date;
  readonly stores: ReadonlyArray<StoreFact>;
  readonly headers: ReadonlyArray<OfferHeader>;
  readonly versions: ReadonlyMap<string, OfferVersionRecord>;
  readonly pauses: ReadonlyArray<OpenPause>;
}

/** The tenant's offer headers, current versions and open pauses, with the clock of this read. */
export async function loadTenantOffers(client: PoolClient, tenantId: string, now: Date): Promise<LoadedTenantOffers> {
  // sequential: the reads share one PoolClient (pg runs its queries one at a time).
  const stores = await loadLiveStores(client, tenantId);
  const headers = await loadOfferHeaders(client, tenantId);
  const versions = await loadVersions(client, tenantId, null, { currentOnly: true });
  const pauses = await loadOpenPauses(client, tenantId, null);
  return { now, stores, headers, versions: new Map(versions.map((v) => [v.offerId, v])), pauses };
}

/** The stores of a version's scope that exist (an explicit list may name a store deleted since). */
export function scopeStores(record: OfferVersionRecord, stores: ReadonlyArray<StoreFact>): StoreFact[] {
  const s = record.definition.storeScope;
  return "allStores" in s ? [...stores] : stores.filter((x) => s.storeIds.includes(x.id));
}

/** The derived state of one offer (contract `OfferState`) at `now`. */
export function stateOf(loaded: LoadedTenantOffers, header: OfferHeader): ReturnType<typeof deriveState> {
  const record = loaded.versions.get(header.id);
  const wholePause = loaded.pauses.some((p) => p.offerId === header.id && p.storeId === null);
  const windows =
    record === undefined
      ? []
      : (() => {
          const scoped = scopeStores(record, loaded.stores);
          return scoped.length === 0
            ? [resolveWindow(record.definition.schedule, "UTC")]
            : scoped.map((s) => resolveWindow(record.definition.schedule, s.timezone));
        })();
  return deriveState({
    hasVersion: record !== undefined,
    archived: header.archivedAt !== null,
    endedExplicitly: header.endedAt !== null,
    wholeOfferPaused: wholePause,
    windows,
    now: loaded.now,
  });
}

/**
 * The live offers of the tenant with their eligible sets resolved from the
 * current catalog. `excludeOfferId` omits one offer (used by a publish that
 * replaces it); sets above the Pack bound come back with `eligible: null`.
 */
export async function loadLiveOffers(
  client: PoolClient,
  tenantId: string,
  loaded: LoadedTenantOffers,
  opts: { readonly excludeOfferId?: string } = {},
): Promise<LiveOffer[]> {
  const firstPublished = await client.query<{ offer_id: string; first_published_at: Date }>(
    `SELECT offer_id::text AS offer_id, min(published_at) AS first_published_at
       FROM offer_versions WHERE tenant_id = $1::uuid GROUP BY offer_id`,
    [tenantId],
  );
  const first = new Map(firstPublished.rows.map((r) => [r.offer_id, r.first_published_at]));
  const live: LiveOffer[] = [];
  for (const header of loaded.headers) {
    if (header.id === opts.excludeOfferId) continue;
    const record = loaded.versions.get(header.id);
    if (record === undefined || header.archivedAt !== null || header.endedAt !== null) continue;
    const scoped = scopeStores(record, loaded.stores);
    const windows = new Map(scoped.map((s) => [s.id, resolveWindow(record.definition.schedule, s.timezone)]));
    const holding = scoped.filter((s) => !windowClosed(windows.get(s.id)!, loaded.now) && !windowEmpty(windows.get(s.id)!)).map((s) => s.id);
    if (holding.length === 0) continue;
    const mine = loaded.pauses.filter((p) => p.offerId === header.id);
    const ids = await eligibleProductIds(client, tenantId, ruleSetsOf(record.definition));
    live.push({
      offerId: header.id,
      version: record.version,
      record,
      firstPublishedAt: first.get(header.id) ?? record.publishedAt,
      pausedWhole: mine.some((p) => p.storeId === null),
      pausedStores: new Set(mine.filter((p) => p.storeId !== null).map((p) => p.storeId!)),
      holdingStores: holding,
      windows,
      eligible: ids.length > ELIGIBLE_SET_LIMIT ? null : ids,
    });
  }
  return live;
}

interface RowKey {
  readonly storeId: string;
  readonly productId: string;
}

export interface PlannedRow extends RowKey {
  readonly offerId: string;
  readonly version: number;
}

interface RematerialisationConflict {
  readonly winnerOfferId: string;
  readonly winnerVersion: number;
  readonly removedProductIds: ReadonlySet<string>;
}

export interface PackPlan {
  /** The rows the Pack must hold now (offers not paused in the store, owners of their products). */
  readonly rows: ReadonlyArray<PlannedRow>;
  /** Per loser offer, the earlier offers that kept products it also matches. */
  readonly conflicts: ReadonlyMap<string, ReadonlyArray<RematerialisationConflict>>;
}

const earlier = (a: LiveOffer, b: LiveOffer): number =>
  a.firstPublishedAt.getTime() - b.firstPublishedAt.getTime() || (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0);

/** The ownership plan (see the header): pure over the loaded live offers. */
export function planPack(live: ReadonlyArray<LiveOffer>): PackPlan {
  const ordered = [...live].filter((o) => o.eligible !== null).sort(earlier);
  const byStore = new Map<string, LiveOffer[]>();
  for (const o of ordered) for (const s of o.holdingStores) byStore.set(s, [...(byStore.get(s) ?? []), o]);

  const rows: PlannedRow[] = [];
  const lost = new Map<string, Map<string, Set<string>>>(); // loser -> winner -> products
  const winners = new Map<string, LiveOffer>();
  for (const [storeId, holders] of byStore) {
    const owner = new Map<string, LiveOffer>();
    for (const h of holders) {
      for (const productId of h.eligible!) {
        const w = owner.get(productId);
        if (w === undefined) {
          owner.set(productId, h);
        } else {
          const perWinner = lost.get(h.offerId) ?? new Map<string, Set<string>>();
          perWinner.set(w.offerId, (perWinner.get(w.offerId) ?? new Set()).add(productId));
          lost.set(h.offerId, perWinner);
          winners.set(w.offerId, w);
        }
      }
    }
    for (const [productId, o] of owner) {
      if (o.pausedWhole || o.pausedStores.has(storeId)) continue;
      rows.push({ storeId, productId, offerId: o.offerId, version: o.version });
    }
  }
  const conflicts = new Map<string, RematerialisationConflict[]>();
  for (const [loser, perWinner] of lost) {
    conflicts.set(
      loser,
      [...perWinner.entries()]
        .map(([winnerId, products]) => ({
          winnerOfferId: winnerId,
          winnerVersion: winners.get(winnerId)!.version,
          removedProductIds: products,
        }))
        .sort((a, b) => (a.winnerOfferId < b.winnerOfferId ? -1 : 1)),
    );
  }
  return { rows, conflicts };
}
