/**
 * RT-1338 offers data layer (RT-286 S6): typed wrappers over the generated `apiClient` for the ten
 * Console operations of `offers.openapi.yaml` (RT-1335 contract, RT-1337 runtime). The POS read in
 * the same document (`posGetOfferPack`) is composed, not called. Consume-only: all rules, the
 * eligible set, conflicts and the simulation are Backend-Core's; the Console only sends and shows.
 *
 *   reads    consoleListOffers, consoleGetOffer, consoleListOfferVersions
 *   preview  consolePreviewOffer (changes nothing)
 *   writes   consoleCreateOfferDraft, consoleUpdateOfferDraft, consolePublishOffer,
 *            consolePauseOffer, consoleResumeOffer, consoleEndOffer, consoleArchiveOffer
 *
 * Every write except the preview takes an Idempotency-Key and is replayable under it. Same
 * `{ status, data?, error? }` shape as the rest of `src/lib`; cookie transport is on the client.
 */
import { apiClient } from "@/generated/client";
import type { OffersSchema } from "@/generated/schema";

type Schemas = OffersSchema.components["schemas"];

export type Offer = Schemas["Offer"];
export type OfferSummary = Schemas["OfferSummary"];
export type OfferPage = Schemas["OfferPage"];
export type OfferVersion = Schemas["OfferVersion"];
export type OfferState = Schemas["OfferState"];
export type OfferDefinition = Schemas["OfferDefinition"];
export type OfferStoreScope = Schemas["StoreScope"];
export type OfferSchedule = Schemas["OfferSchedule"];
export type OfferOfflinePolicy = Schemas["OfflinePolicy"];
export type OfferPreview = Schemas["OfferPreview"];
export type OfferConflict = Schemas["OfferConflict"];
export type OfferSimulationRequest = Schemas["OfferSimulationRequest"];
export type OfferSimulationResult = Schemas["OfferSimulationResult"];
export type OfferError = Schemas["OfferError"];

export interface OfferListQuery {
  state?: OfferState;
  store_id?: string;
  cursor?: string;
  page_size?: number;
}

/** GET /api/v1/offers: keyset page, newest first. A store_manager sees own-store offers only. */
export async function consoleListOffers(query: OfferListQuery = {}) {
  const { data, error, response } = await apiClient.GET("/api/v1/offers", {
    params: { query },
  });
  return { status: response.status, data, error };
}

/** GET /api/v1/offers/{offer_id}: state, draft, current version, pauses. */
export async function consoleGetOffer(offerId: string) {
  const { data, error, response } = await apiClient.GET("/api/v1/offers/{offer_id}", {
    params: { path: { offer_id: offerId } },
  });
  return { status: response.status, data, error };
}

/** GET /api/v1/offers/{offer_id}/versions: immutable published versions, newest first. */
export async function consoleListOfferVersions(offerId: string, cursor?: string) {
  const { data, error, response } = await apiClient.GET("/api/v1/offers/{offer_id}/versions", {
    params: { path: { offer_id: offerId }, query: { cursor } },
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/offers: creates the offer with its first draft (`draftRevision` 1). */
export async function consoleCreateOfferDraft(definition: OfferDefinition, idempotencyKey: string) {
  const { data, error, response } = await apiClient.POST("/api/v1/offers", {
    params: { header: { "Idempotency-Key": idempotencyKey } },
    body: { definition },
  });
  return { status: response.status, data, error };
}

/** PUT /api/v1/offers/{offer_id}/draft: `expectedDraftRevision` is null to start the next draft. */
export async function consoleUpdateOfferDraft(
  offerId: string,
  expectedDraftRevision: number | null,
  definition: OfferDefinition,
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.PUT("/api/v1/offers/{offer_id}/draft", {
    params: { path: { offer_id: offerId }, header: { "Idempotency-Key": idempotencyKey } },
    body: { expectedDraftRevision, definition },
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/offers/{offer_id}/preview: validates the SAVED draft; writes nothing. */
export async function consolePreviewOffer(
  offerId: string,
  expectedDraftRevision: number,
  simulation?: OfferSimulationRequest,
) {
  const { data, error, response } = await apiClient.POST("/api/v1/offers/{offer_id}/preview", {
    params: { path: { offer_id: offerId } },
    body: { expectedDraftRevision, ...(simulation ? { simulation } : {}) },
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/offers/{offer_id}/publish: the named draft becomes the next immutable version. */
export async function consolePublishOffer(
  offerId: string,
  expectedDraftRevision: number,
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.POST("/api/v1/offers/{offer_id}/publish", {
    params: { path: { offer_id: offerId }, header: { "Idempotency-Key": idempotencyKey } },
    body: { expectedDraftRevision },
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/offers/{offer_id}/pause: `reason` is required; `storeIds` absent pauses the whole offer. */
export async function consolePauseOffer(
  offerId: string,
  body: { reason: string; storeIds?: string[] },
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.POST("/api/v1/offers/{offer_id}/pause", {
    params: { path: { offer_id: offerId }, header: { "Idempotency-Key": idempotencyKey } },
    body,
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/offers/{offer_id}/resume: `storeIds` absent lifts the whole pause and every store pause. */
export async function consoleResumeOffer(
  offerId: string,
  body: { storeIds?: string[] },
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.POST("/api/v1/offers/{offer_id}/resume", {
    params: { path: { offer_id: offerId }, header: { "Idempotency-Key": idempotencyKey } },
    body,
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/offers/{offer_id}/end: ends a scheduled, active or paused offer now. */
export async function consoleEndOffer(offerId: string, idempotencyKey: string) {
  const { data, error, response } = await apiClient.POST("/api/v1/offers/{offer_id}/end", {
    params: { path: { offer_id: offerId }, header: { "Idempotency-Key": idempotencyKey } },
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/offers/{offer_id}/archive: only an ended offer; keeps every version. */
export async function consoleArchiveOffer(offerId: string, idempotencyKey: string) {
  const { data, error, response } = await apiClient.POST("/api/v1/offers/{offer_id}/archive", {
    params: { path: { offer_id: offerId }, header: { "Idempotency-Key": idempotencyKey } },
  });
  return { status: response.status, data, error };
}
