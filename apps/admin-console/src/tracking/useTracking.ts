/**
 * RT-455 query hooks for the tracking holds screen and the identity detail.
 * Reads only. Built on the inventory read helpers (`useInventoryRead`,
 * `useInventoryPages`): typed errors, no read retries on its own, a 429 carries
 * the server's wait, keys carry the active tenant and store.
 *
 * Names are conveniences, never dependencies (TR-7, OD-3): product names come
 * from the catalog detail read, store names from the store list, actor names
 * from `listMembers`. While one loads or fails, the screen shows the id or a
 * fallback label.
 */
import { consoleGetCatalogProduct } from "@/lib/catalog-queries";
import {
  type TrackingIdentity,
  type TrackingIdentityList,
  listTrackingIdentities,
} from "@/lib/inventory-queries";
import {
  type ExpiryCorrection,
  type ExpiryCorrectionList,
  type HoldStatusFilter,
  type InventoryRecall,
  type RecallSummary,
  type RecallSummaryList,
  type ResolutionQueue,
  type ResolutionQueueItem,
  type ResolutionStatusFilter,
  type SafetyFindingList,
  type SaleLineFinding,
  type SaleLineFindingKind,
  type SaleLineFindingList,
  type TrackingHold,
  type TrackingHoldList,
  type TrackingIdentityPositions,
  getInventoryRecall,
  getTenantTrackingSummary,
  getTrackingHold,
  getTrackingIdentity,
  getTrackingIdentityPositions,
  listExpiryCorrections,
  listInventoryRecalls,
  listSafetyFindings,
  listSaleLineFindings,
  listTrackingHolds,
  listTrackingResolutionQueue,
} from "@/lib/tracking-queries";
import { useMembers } from "@/operators/useMembers";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  type InventoryScope,
  type PagedState,
  type ReadState,
  useInventoryPages,
  useInventoryRead,
} from "../inventory/useInventory";
import { type MemberName, canOpenTracking } from "./trackingLogic";

function scopeKey(scope: InventoryScope) {
  return ["tracking", scope.tenantId, scope.activeStoreId] as const;
}

export const trackingQueryKeys = {
  summary: (tenantId: string | null) => ["tracking", tenantId, "summary"] as const,
  findings: (s: InventoryScope) => [...scopeKey(s), "findings"] as const,
  holds: (s: InventoryScope, status: HoldStatusFilter, identityId?: string) =>
    [...scopeKey(s), "holds", status, identityId ?? null] as const,
  hold: (s: InventoryScope, holdId: string) => [...scopeKey(s), "hold", holdId] as const,
  recalls: (s: InventoryScope) => [...scopeKey(s), "recalls"] as const,
  recall: (s: InventoryScope, recallId: string) => [...scopeKey(s), "recall", recallId] as const,
  identity: (s: InventoryScope, id: string) => [...scopeKey(s), "identity", id] as const,
  positions: (s: InventoryScope, id: string) => [...scopeKey(s), "positions", id] as const,
  corrections: (s: InventoryScope, id: string) => [...scopeKey(s), "corrections", id] as const,
  productIdentities: (s: InventoryScope, productId: string) =>
    [...scopeKey(s), "product-identities", productId] as const,
  resolutionCount: (s: InventoryScope) => [...scopeKey(s), "resolution-count"] as const,
  resolutions: (s: InventoryScope, status: ResolutionStatusFilter) =>
    [...scopeKey(s), "resolutions", status] as const,
  saleLineFindings: (s: InventoryScope, kind: SaleLineFindingKind | undefined) =>
    [...scopeKey(s), "sale-line-findings", kind ?? "all"] as const,
  productName: (tenantId: string | null, productId: string) =>
    ["tracking", tenantId, "product-name", productId] as const,
};

/**
 * `hasTrackedProducts` once the summary has answered; undefined while it loads,
 * when it failed, or for a role that may not ask (TR-6: all of these hide the
 * section). Read once per tenant and kept for five minutes.
 */
export function useTrackingSummary(
  tenantId: string | null,
  role: string | null | undefined,
  enabled = true,
): boolean | undefined {
  return useTrackingSummaryQuery(tenantId, role, enabled).data;
}

/** The summary query itself, for the page that must tell loading from failed. */
export function useTrackingSummaryQuery(
  tenantId: string | null,
  role: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: trackingQueryKeys.summary(tenantId),
    enabled: enabled && Boolean(tenantId) && canOpenTracking(role),
    queryFn: async () => {
      const res = await getTenantTrackingSummary();
      if (res.status !== 200 || !res.data) throw new Error(`tracking summary ${res.status}`);
      return res.data.hasTrackedProducts === true;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useSafetyFindings(scope: InventoryScope): ReadState<SafetyFindingList> {
  return useInventoryRead({
    queryKey: trackingQueryKeys.findings(scope),
    scope,
    load: listSafetyFindings,
  });
}

/** Holds newest first; `identityId` narrows to one identity's history (II-3). */
export function useTrackingHolds(
  scope: InventoryScope,
  status: HoldStatusFilter,
  identityId?: string,
): PagedState<TrackingHold> {
  return useInventoryPages<TrackingHold, TrackingHoldList>({
    queryKey: trackingQueryKeys.holds(scope, status, identityId),
    scope,
    fetchPage: (page) => listTrackingHolds({ ...page, status, trackingIdentityId: identityId }),
  });
}

export function useRecalls(scope: InventoryScope): PagedState<RecallSummary> {
  return useInventoryPages<RecallSummary, RecallSummaryList>({
    queryKey: trackingQueryKeys.recalls(scope),
    scope,
    fetchPage: listInventoryRecalls,
  });
}

/**
 * RT-455 part 2 (OD-9): the unresolved-sale count in the caller's scope. Every
 * role that opens the screen may ask; a store_manager gets only this number
 * (its `items` are always empty). One item is enough to read it. Unknown while
 * loading or failed: never zero.
 */
export function useUnresolvedCount(scope: InventoryScope): ReadState<number> {
  return useInventoryRead({
    queryKey: trackingQueryKeys.resolutionCount(scope),
    scope,
    load: async () => {
      const res = await listTrackingResolutionQueue({ status: "unresolved", limit: 1 });
      return { ...res, data: res.data ? res.data.unresolvedCount : undefined };
    },
  });
}

/** The queue's sales, newest capture first (owner / tenant_admin only; never mounted for others). */
export function useResolutionQueue(
  scope: InventoryScope,
  status: ResolutionStatusFilter,
): PagedState<ResolutionQueueItem> {
  return useInventoryPages<ResolutionQueueItem, ResolutionQueue>({
    queryKey: trackingQueryKeys.resolutions(scope, status),
    scope,
    fetchPage: (page) => listTrackingResolutionQueue({ ...page, status }),
  });
}

/** A product's batches and serials, for the bind's identity picker (owner / tenant_admin). */
export function useProductIdentities(
  scope: InventoryScope,
  productId: string,
): PagedState<TrackingIdentity> {
  return useInventoryPages<TrackingIdentity, TrackingIdentityList>({
    queryKey: trackingQueryKeys.productIdentities(scope, productId),
    scope,
    fetchPage: (page) => listTrackingIdentities(productId, page),
  });
}

/** Recorded sale-line findings, newest first, optionally of one kind (OD-2). */
export function useSaleLineFindings(
  scope: InventoryScope,
  kind: SaleLineFindingKind | undefined,
): PagedState<SaleLineFinding> {
  return useInventoryPages<SaleLineFinding, SaleLineFindingList>({
    queryKey: trackingQueryKeys.saleLineFindings(scope, kind),
    scope,
    fetchPage: (page) => listSaleLineFindings({ ...page, kind }),
  });
}

export function useTrackingHold(scope: InventoryScope, holdId: string): ReadState<TrackingHold> {
  return useInventoryRead({
    queryKey: trackingQueryKeys.hold(scope, holdId),
    scope,
    load: () => getTrackingHold(holdId),
  });
}

export function useRecall(scope: InventoryScope, recallId: string): ReadState<InventoryRecall> {
  return useInventoryRead({
    queryKey: trackingQueryKeys.recall(scope, recallId),
    scope,
    load: () => getInventoryRecall(recallId),
  });
}

export function useTrackingIdentity(
  scope: InventoryScope,
  identityId: string,
): ReadState<TrackingIdentity> {
  return useInventoryRead({
    queryKey: trackingQueryKeys.identity(scope, identityId),
    scope,
    load: () => getTrackingIdentity(identityId),
  });
}

export function useIdentityPositions(
  scope: InventoryScope,
  identityId: string,
): ReadState<TrackingIdentityPositions> {
  return useInventoryRead({
    queryKey: trackingQueryKeys.positions(scope, identityId),
    scope,
    load: () => getTrackingIdentityPositions(identityId),
  });
}

export function useExpiryCorrections(
  scope: InventoryScope,
  identityId: string,
): PagedState<ExpiryCorrection> {
  return useInventoryPages<ExpiryCorrection, ExpiryCorrectionList>({
    queryKey: trackingQueryKeys.corrections(scope, identityId),
    scope,
    fetchPage: (page) => listExpiryCorrections(identityId, page),
  });
}

/**
 * Product names for the ids a screen shows (TR-7), one catalog detail read per
 * distinct product, cached for five minutes. A product whose read fails or is
 * still loading has no name: the caller shows its id.
 */
export function useProductNames(
  tenantId: string | null,
  productIds: readonly string[],
): ReadonlyMap<string, string> {
  const results = useQueries({
    queries: productIds.map((productId) => ({
      queryKey: trackingQueryKeys.productName(tenantId, productId),
      enabled: Boolean(tenantId),
      queryFn: async () => {
        const res = await consoleGetCatalogProduct(productId);
        if (res.status !== 200 || !res.data) throw new Error(`product ${res.status}`);
        return res.data.summary.name;
      },
      retry: false,
      staleTime: 5 * 60_000,
    })),
  });
  const names = new Map<string, string>();
  results.forEach((result, i) => {
    if (result.data) names.set(productIds[i], result.data);
  });
  return names;
}

/** The tenant's members as names (OD-3), for owner / tenant_admin; undefined until listed. */
export function useMemberNames(
  tenantId: string | null,
  enabled: boolean,
): readonly MemberName[] | undefined {
  const { result } = useMembers(enabled ? tenantId : null);
  return useMemo(
    () =>
      result?.kind === "rows"
        ? result.rows.map(({ userId, displayName, email }) => ({ userId, displayName, email }))
        : undefined,
    [result],
  );
}
