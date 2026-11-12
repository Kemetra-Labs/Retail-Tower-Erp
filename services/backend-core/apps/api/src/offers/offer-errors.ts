/**
 * The closed refusal set of the offers surface (`OfferErrorCode` in
 * `offers.openapi.yaml`), as one exception type the controller maps to the
 * contract's status. The messages are non-disclosing (never another tenant's
 * data). Platform codes (`origin_rejected`, `rate_limited`, the idempotency
 * codes) come from their own guards and interceptors.
 */

export type OfferRefusalCode =
  | "validation_error"
  | "forbidden"
  | "offer_not_found"
  | "store_not_found"
  | "offer_state_invalid"
  | "offer_draft_changed_concurrently"
  | "offer_conflict"
  | "offer_reference_invalid"
  | "offer_schedule_elapsed"
  | "offer_eligible_set_empty"
  | "offer_eligible_set_too_large"
  | "offer_store_offer_limit_exceeded"
  | "offer_store_not_in_scope";

export const OFFER_REFUSAL_STATUS: Readonly<Record<OfferRefusalCode, 400 | 403 | 404 | 409 | 422>> = {
  validation_error: 400,
  forbidden: 403,
  offer_not_found: 404,
  store_not_found: 404,
  offer_state_invalid: 409,
  offer_draft_changed_concurrently: 409,
  offer_conflict: 409,
  offer_reference_invalid: 422,
  offer_schedule_elapsed: 422,
  offer_eligible_set_empty: 422,
  offer_eligible_set_too_large: 422,
  offer_store_offer_limit_exceeded: 422,
  offer_store_not_in_scope: 422,
};

export const OFFER_REFUSAL_MESSAGES: Readonly<Record<OfferRefusalCode, string>> = {
  validation_error: "The request is not valid.",
  forbidden: "Your role cannot do this.",
  offer_not_found: "Offer not found.",
  store_not_found: "A store was not found.",
  offer_state_invalid: "The offer is not in a state that allows this.",
  offer_draft_changed_concurrently: "The draft changed since it was read. Reload and retry.",
  offer_conflict: "Another offer already covers some of these products in a shared store.",
  offer_reference_invalid: "The offer names a product, category, brand or store that is not available.",
  offer_schedule_elapsed: "The offer ends before it can start.",
  offer_eligible_set_empty: "The offer matches no product.",
  offer_eligible_set_too_large: "The offer matches more products than a Pack can carry.",
  offer_store_offer_limit_exceeded: "A store would have more live offers than a Pack can carry.",
  offer_store_not_in_scope: "A named store is not in the offer's scope for this action.",
};

export interface OfferConflictBody {
  readonly offerId: string;
  readonly offerVersion: number;
  readonly nameAr: string;
  readonly state: "scheduled" | "active" | "paused";
  readonly sharedProductCount: number;
  readonly sharedProductSample: ReadonlyArray<string>;
}

export class OfferRefusedError extends Error {
  constructor(
    readonly code: OfferRefusalCode,
    readonly conflicts?: ReadonlyArray<OfferConflictBody>,
  ) {
    super(code);
    this.name = "OfferRefusedError";
  }
}
