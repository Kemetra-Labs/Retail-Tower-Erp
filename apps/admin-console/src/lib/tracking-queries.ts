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
 * Boundary: the RT-451 Step 0 operations (`listTrackingResolutionQueue`,
 * `bindTrackingResolution`, `listSaleLineFindings`) are contract-only (no route
 * yet) and are NOT wrapped or called: their tabs render a «قريبًا» frame.
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
export async function placeQualityHold(command: PlaceQualityHoldCommand, idempotencyKey: string) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/tracking-holds", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body: command,
    }),
  );
}

/** POST /api/inventory/v1/tracking-holds/{holdId}/release — final; a repeat answers the recorded release. */
export async function releaseTrackingHold(holdId: string, command: ReleaseTrackingHoldCommand) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/tracking-holds/{holdId}/release", {
      params: { path: { holdId } },
      body: command,
    }),
  );
}

/** POST /api/inventory/v1/recalls — Idempotency-Key required. */
export async function createInventoryRecall(
  command: CreateInventoryRecallCommand,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/recalls", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body: command,
    }),
  );
}

/** POST /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections — Idempotency-Key required. */
export async function correctTrackingIdentityExpiry(
  identityId: string,
  command: CorrectExpiryCommand,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST("/api/inventory/v1/tracking-identities/{identityId}/expiry-corrections", {
      params: { path: { identityId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
    }),
  );
}
