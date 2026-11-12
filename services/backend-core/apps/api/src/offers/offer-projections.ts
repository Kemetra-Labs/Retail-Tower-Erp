/**
 * Console projections of the offers surface (`offers.openapi.yaml` `Offer`,
 * `OfferSummary`, `OfferVersion`, `OfferDraft`; Jira RT-1337).
 *
 * Store-manager filtering (contract "Roles and capabilities"): for a caller
 * bounded to their own stores, every `storeScope.storeIds` and every
 * `pausedStores` list is filtered to those stores, so another store's id, pause
 * reason and pausing user are never returned; an all-stores offer reads
 * `allStores: true`.
 */
import type { StoreScope } from "../context/store-scope";
import { stateOf, type LoadedTenantOffers, type PackPlan } from "./offer-live";
import type { OfferHeader, OfferVersionRecord, OpenPause } from "./offers.repository";
import type { OfferDefinition } from "./offers.dto";

export interface Viewer {
  /** Null: not store-bounded (owner, tenant_admin). */
  readonly ownStoreIds: ReadonlySet<string> | null;
}

export function viewerOf(scope: StoreScope, bounded: boolean): Viewer {
  return { ownStoreIds: bounded ? new Set(scope.kind === "tenant" ? [] : scope.storeIds.map((s) => s.toLowerCase())) : null };
}

/** The definition as the viewer may see it, or null when a bounded viewer's stores are not in an explicit scope. */
function visibleDefinition(def: OfferDefinition, viewer: Viewer): OfferDefinition | null {
  if (viewer.ownStoreIds === null || "allStores" in def.storeScope) return def;
  const mine = def.storeScope.storeIds.filter((s) => viewer.ownStoreIds!.has(s));
  return mine.length === 0 ? null : { ...def, storeScope: { storeIds: mine } };
}

/** The scope that decides whether a bounded viewer sees the offer: the current version's, else the draft's. */
export function isVisible(header: OfferHeader, record: OfferVersionRecord | undefined, viewer: Viewer): boolean {
  const def = record?.definition ?? header.draft?.definition;
  if (def === undefined) return false;
  return visibleDefinition(def, viewer) !== null;
}

const iso = (d: Date): string => d.toISOString();

export interface ConflictNames {
  readonly nameOf: (offerId: string) => string;
}

export function toOfferBody(args: {
  readonly loaded: LoadedTenantOffers;
  readonly header: OfferHeader;
  readonly viewer: Viewer;
  readonly plan: PackPlan | null;
  readonly names: ConflictNames;
}) {
  const { loaded, header, viewer, plan, names } = args;
  const record = loaded.versions.get(header.id);
  const mine = loaded.pauses.filter((p) => p.offerId === header.id);
  const whole = mine.find((p) => p.storeId === null) ?? null;
  const draftDef = header.draft === null ? null : visibleDefinition(header.draft.definition, viewer);
  const currentDef = record === undefined ? null : visibleDefinition(record.definition, viewer);
  const conflicts = visibleConflicts(loaded, plan, header.id, viewer);
  return {
    offerId: header.id,
    state: stateOf(loaded, header),
    draft:
      header.draft === null || draftDef === null
        ? null
        : {
            draftRevision: header.draftRevision,
            definition: draftDef,
            updatedAt: iso(header.draft.updatedAt),
            updatedByUserId: header.draft.updatedByUserId,
          },
    currentVersion:
      record === undefined || currentDef === null
        ? null
        : {
            version: record.version,
            definition: currentDef,
            publishedAt: iso(record.publishedAt),
            publishedByUserId: record.publishedByUserId,
            eligibleSetCount: record.eligibleSetCount,
          },
    pause: whole === null ? null : { pausedAt: iso(whole.pausedAt), pausedByUserId: whole.pausedByUserId, reason: whole.reason },
    pausedStores: mine
      .filter((p): p is OpenPause & { storeId: string } => p.storeId !== null)
      .filter((p) => viewer.ownStoreIds === null || viewer.ownStoreIds.has(p.storeId))
      .map((p) => ({ storeId: p.storeId, pausedAt: iso(p.pausedAt), pausedByUserId: p.pausedByUserId, reason: p.reason })),
    createdAt: iso(header.createdAt),
    updatedAt: iso(header.updatedAt),
    endedAt: header.endedAt === null ? null : iso(header.endedAt),
    archivedAt: header.archivedAt === null ? null : iso(header.archivedAt),
    rematerialisationConflicts: conflicts.slice(0, 50).map((c) => ({
      offerId: c.winnerOfferId,
      offerVersion: c.winnerVersion,
      nameAr: names.nameOf(c.winnerOfferId),
      removedProductCount: c.removedProductIds.size,
      removedProductSample: [...c.removedProductIds].sort().slice(0, 20),
    })),
  };
}

/** The conflicts whose winning offer the viewer may see: a hidden offer's identity stays hidden (OD-12). */
function visibleConflicts(loaded: LoadedTenantOffers, plan: PackPlan | null, offerId: string, viewer: Viewer) {
  return (plan?.conflicts.get(offerId) ?? []).filter((c) => {
    const winner = loaded.headers.find((h) => h.id === c.winnerOfferId);
    return winner !== undefined && isVisible(winner, loaded.versions.get(c.winnerOfferId), viewer);
  });
}

export function toSummary(args: {
  readonly loaded: LoadedTenantOffers;
  readonly header: OfferHeader;
  readonly viewer: Viewer;
  readonly plan: PackPlan | null;
}) {
  const { loaded, header, viewer, plan } = args;
  const record = loaded.versions.get(header.id);
  const def = (record?.definition ?? header.draft?.definition)!;
  const shown = visibleDefinition(def, viewer)!; // a visible offer: the caller checked `isVisible`
  return {
    offerId: header.id,
    state: stateOf(loaded, header),
    nameAr: shown.nameAr,
    nameEn: shown.nameEn,
    currentVersion: record?.version ?? null,
    hasDraft: header.draft !== null && visibleDefinition(header.draft.definition, viewer) !== null,
    schedule: shown.schedule,
    storeScope: shown.storeScope,
    updatedAt: iso(header.updatedAt),
    rematerialisationConflictCount: Math.min(50, visibleConflicts(loaded, plan, header.id, viewer).length),
  };
}

/** A version as the viewer may see it; null for a bounded viewer when the version's scope names none of their stores. */
export function toVersionBody(record: OfferVersionRecord, viewer: Viewer) {
  const definition = visibleDefinition(record.definition, viewer);
  if (definition === null) return null;
  return {
    version: record.version,
    definition,
    publishedAt: iso(record.publishedAt),
    publishedByUserId: record.publishedByUserId,
    eligibleSetCount: record.eligibleSetCount,
  };
}
