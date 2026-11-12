/**
 * RT-455 data layer: typed wrappers over the generated `apiClient` for the
 * tracked-inventory safety reads and the four governed commands the Console's
 * holds screen and identity detail use (`inventory/inventory.yaml` 1.10.0-draft, RT-449 and RT-1081;
 * `catalog/tracking-profile.yaml`, RT-1081):
 *
 *   - `getTenantTrackingSummary`: whether the tenant has tracked products (the
 *     section is hidden while it is false, TR-6, OD-5).
 *   - `listInventorySafetyFindings`: the computed findings (not paged).
 *   - `listTrackingHolds`, `getTrackingHold`: holds, active or released.
 *   - `listInventoryRecalls`, `getInventoryRecall`: recall summaries, one recall.
 *   - `getTrackingIdentity`, `getTrackingIdentityPositions`,
 *     `listTrackingIdentityExpiryCorrections`: one batch or serial.
 *   - Commands (owner approval, RT-455 comment 15245): `placeQualityHold`,
 *     `releaseTrackingHold` (owner only), `createInventoryRecall`,
 *     `correctTrackingIdentityExpiry`, each with `SafetyReasonCodeInput`. Until
 *     RT-453 writes identities they answer 404; the caller shows the refusal.
 *
 *   - RT-455 part 2 (RT-451 S3 and S5 runtime on main): `listTrackingResolutionQueue`
 *     (owner / tenant_admin read the sales; a store_manager gets the count only, OD-9),
 *     `bindTrackingResolution` (owner only, high sensitivity, reason and note required)
 *     and `listSaleLineFindings` (keyset-paged, OD-2).
 *   - `tenantAdminGetTrackingProfile`: a product's tracking profile, read only.
 *
 * Same `{ status, data?, error?, retryAfter? }` shape as `inventory-queries.ts`.
 */
import { apiClient } from "@/generated/client";
import type { InventorySchema, TrackingProfileSchema } from "@/generated/schema";
import type { PageQuery } from "@/lib/inventory-queries";
import { classifyRateLimit } from "@/lib/rate-limit";

type Schemas = InventorySchema.components["schemas"];

// --- Generated projections (no hand-typed shapes) -----------------------------

export type TenantTrackingSummary =
  TrackingProfileSchema.components["schemas"]["TenantTrackingSummary"];
export type SafetyFindingList = Schemas["InventorySafetyFindingList"];
export type SafetyFinding = Schemas["InventorySafetyFinding"];
export type ActiveHoldFinding = Schemas["ActiveTrackingHoldFinding"];
export type ExpiredSellableFinding = Schemas["ExpiredLotSellableFinding"];
export type ConsistencyFinding = Schemas["TrackingConsistencyFinding"];
export type TrackingHold = Schemas["TrackingHold"];
export type TrackingHoldList = Schemas["TrackingHoldList"];
export type RecallSummary = Schemas["InventoryRecallSummary"];
export type RecallSummaryList = Schemas["InventoryRecallSummaryList"];
export type InventoryRecall = Schemas["InventoryRecall"];
export type TrackingIdentityPositions = Schemas["TrackingIdentityPositions"];
export type IdentityStorePosition = Schemas["TrackingIdentityStorePosition"];
export type ExpiryCorrection = Schemas["TrackingIdentityExpiryCorrection"];
export type ExpiryCorrectionList = Schemas["TrackingIdentityExpiryCorrectionList"];
export type SafetyReasonCodeInput = Schemas["SafetyReasonCodeInput"];
export type PlaceQualityHoldCommand = Schemas["PlaceQualityHoldCommand"];
export type ReleaseTrackingHoldCommand = Schemas["ReleaseTrackingHoldCommand"];
export type CreateInventoryRecallCommand = Schemas["CreateInventoryRecallCommand"];
export type CorrectExpiryCommand = Schemas["CorrectTrackingIdentityExpiryCommand"];
export type ResolutionQueue = Schemas["TrackingResolutionQueue"];
export type ResolutionQueueItem = Schemas["TrackingResolutionQueueItem"];
export type UnresolvedLine = Schemas["UnresolvedTrackedLine"];
export type BindResolutionCommand = Schemas["BindTrackingResolutionCommand"];
export type SaleLineFindingList = Schemas["SaleLineFindingList"];
export type SaleLineFinding = Schemas["SaleLineFinding"];
export type SaleLineFindingKind = Schemas["SaleLineFindingKind"];

/** A 429's wait in seconds via the shared RT-621 classifier (30 s fallback, [1, 3600]). */
function retryAfterOf(response: Response): number | undefined {
  return classifyRateLimit({
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
  })?.retryAfterSeconds;
}

function resultOf<D, E>(res: { data?: D; error?: E; response: Response }) {
  return {
    status: res.response.status,
    data: res.data,
    error: res.error,
    retryAfter: retryAfterOf(res.response),
  };
}

export type HoldStatusFilter = "active" | "released" | "all";

export type ResolutionStatusFilter = "unresolved" | "resolved" | "all";

export interface ResolutionQuery extends PageQuery {
  status?: ResolutionStatusFilter;
  storeId?: string;
}

export interface SaleLineFindingQuery extends PageQuery {
  kind?: SaleLineFindingKind;
  storeId?: string;
}

export interface HoldQuery extends PageQuery {
  status?: HoldStatusFilter;
  trackingIdentityId?: string;
  productId?: string;
}

// --- Typed operation wrappers -------------------------------------------------

/** GET /api/v1/catalog/tracking-summary */
export async function getTenantTrackingSummary() {
  return resultOf(await apiClient.GET("/api/v1/catalog/tracking-summary"));
}

/** GET /api/inventory/v1/safety/findings */
export async function listSafetyFindings() {
  return resultOf(await apiClient.GET("/api/inventory/v1/safety/findings"));
}

/** GET /api/inventory/v1/tracking-holds */
export async function listTrackingHolds(query: HoldQuery = {}) {
  return resultOf(await apiClient.GET("/api/inventory/v1/tracking-holds", { params: { query } }));
}

/** GET /api/inventory/v1/tracking-holds/{holdId} */
export async function getTrackingHold(holdId: string) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/tracking-holds/{holdId}", {
      params: { path: { holdId } },
    }),
  );
}

/** GET /api/inventory/v1/recalls */
export async function listInventoryRecalls(query: PageQuery = {}) {
  return resultOf(await apiClient.GET("/api/inventory/v1/recalls", { params: { query } }));
}

/** GET /api/inventory/v1/recalls/{recallId} */
export async function getInventoryRecall(recallId: string) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/recalls/{recallId}", {
      params: { path: { recallId } },
    }),
  );
}

/** GET /api/inventory/v1/tracking-identities/{identityId} */
export async function getTrackingIdentity(identityId: string) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/tracking-identities/{identityId}", {
      params: { path: { identityId } },
    }),
  );
}

/** GET /api/inventory/v1/tracking-identities/{identityId}/positions */
export async function getTrackingIdentityPositions(identityId: string) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/tracking-identities/{identityId}/positions", {
      params: { path: { identityId } },
    }),
  );
}

/** GET /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections */
export async function listExpiryCorrections(identityId: string, query: PageQuery = {}) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/tracking-identities/{identityId}/expiry-corrections", {
      params: { path: { identityId }, query },
    }),
  );
}

// --- Commands (RT-449; RT-1081 reason list) ----------------------------------

/** POST /api/inventory/v1/tracking-holds — Idempotency-Key required. */
export async function placeQualityHold(
  command: PlaceQualityHoldCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/tracking-holds", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}

/** POST /api/inventory/v1/tracking-holds/{holdId}/release — final; a repeat answers the recorded release. */
export async function releaseTrackingHold(
  holdId: string,
  command: ReleaseTrackingHoldCommand,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/tracking-holds/{holdId}/release", {
      params: { path: { holdId } },
      body: command,
      signal,
    }),
  );
}

/** POST /api/inventory/v1/recalls — Idempotency-Key required. */
export async function createInventoryRecall(
  command: CreateInventoryRecallCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/recalls", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}

/** POST /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections — Idempotency-Key required. */
export async function correctTrackingIdentityExpiry(
  identityId: string,
  command: CorrectExpiryCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/tracking-identities/{identityId}/expiry-corrections", {
      params: { path: { identityId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}

// --- RT-451 Tracking Resolution and sale-line findings (RT-455 part 2) -----------

/** GET /api/inventory/v1/tracking-resolutions — items for owner / tenant_admin; the count only for a store_manager. */
export async function listTrackingResolutionQueue(query: ResolutionQuery = {}) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/tracking-resolutions", { params: { query } }),
  );
}

/** POST /api/inventory/v1/tracking-resolutions/{saleId}/bind — owner only; Idempotency-Key required. */
export async function bindTrackingResolution(
  saleId: string,
  command: BindResolutionCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/tracking-resolutions/{saleId}/bind", {
      params: { path: { saleId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
      signal,
    }),
  );
}

/** GET /api/inventory/v1/safety/sale-line-findings — keyset-paged, newest first. */
export async function listSaleLineFindings(query: SaleLineFindingQuery = {}) {
  return resultOf(
    await apiClient.GET("/api/inventory/v1/safety/sale-line-findings", { params: { query } }),
  );
}

/** GET /api/v1/catalog/products/{productId}/tracking-profile — read only here. */
export async function getTrackingProfile(productId: string) {
  return resultOf(
    await apiClient.GET("/api/v1/catalog/products/{productId}/tracking-profile", {
      params: { path: { productId } },
    }),
  );
}
