/**
 * Validate → Preview → Publish checks of an offer definition (spec 048 §5.2,
 * §10, OD-7; `offers.openapi.yaml` `consolePreviewOffer`, `consolePublishOffer`;
 * Jira RT-1337).
 *
 * `checkDefinition` reports every issue a publish would refuse for, so a
 * preview with no issue and no conflict is publishable at that moment:
 * `offer_reference_invalid`, `offer_schedule_elapsed`, `offer_eligible_set_empty`,
 * `offer_eligible_set_too_large`, `offer_store_offer_limit_exceeded`; and the
 * OD-7 conflicts with other live offers.
 *
 * OD-7 reading (stricter than the contract's "overlapping windows", and the one
 * the 0101 Pack invariant forces): two live offers cannot cover the same
 * product in the same store, whatever their windows, because a Pack holds a
 * product in at most one offer per store (the EXCLUDE constraint). A "live"
 * offer is scheduled, active or paused, and a store is "held" by an offer
 * until its window has closed there.
 */
import type { PoolClient } from "pg";

import { ELIGIBLE_SET_LIMIT, eligibleProductIds, findInvalidReferences, ruleSetsOf } from "./offer-eligibility";
import { stateOf, type LiveOffer, type LoadedTenantOffers } from "./offer-live";
import { resolveWindow, windowClosed, windowEmpty } from "./offer-schedule";
import type { OfferConflictBody } from "./offer-errors";
import type { OfferDefinition } from "./offers.dto";

/** A store holds at most this many live offers (`OfferPack.offers`). */
export const STORE_OFFER_LIMIT = 200;
const SAMPLE = 20;
const CONFLICT_LIMIT = 50;

export type PreviewIssueCode =
  | "offer_reference_invalid"
  | "offer_schedule_elapsed"
  | "offer_eligible_set_empty"
  | "offer_eligible_set_too_large"
  | "offer_store_offer_limit_exceeded";

interface PreviewIssue {
  readonly code: PreviewIssueCode;
  readonly field: string | null;
  readonly message: string;
}

export interface DefinitionCheck {
  readonly issues: ReadonlyArray<PreviewIssue>;
  /** The eligible ids, ascending; at most `ELIGIBLE_SET_LIMIT + 1` (the extra one marks "too large"). */
  readonly eligible: ReadonlyArray<string>;
  /** The stores of the definition's scope whose window is not closed (where the offer would hold products). */
  readonly holdingStores: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<OfferConflictBody>;
}

/** The first issue in the contract's refusal order (publish answers with one code). */
export const ISSUE_ORDER: ReadonlyArray<PreviewIssueCode> = [
  "offer_reference_invalid",
  "offer_schedule_elapsed",
  "offer_eligible_set_empty",
  "offer_eligible_set_too_large",
  "offer_store_offer_limit_exceeded",
];

/** Conflicts of a candidate's eligible ids with the other live offers (OD-7), most shared first. */
export async function findConflicts(
  client: PoolClient,
  tenantId: string,
  loaded: LoadedTenantOffers,
  others: ReadonlyArray<LiveOffer>,
  candidate: { readonly eligible: ReadonlyArray<string>; readonly stores: ReadonlySet<string> },
): Promise<OfferConflictBody[]> {
  const out: OfferConflictBody[] = [];
  const mine = new Set(candidate.eligible);
  for (const o of others) {
    if (!o.holdingStores.some((s) => candidate.stores.has(s))) continue;
    const shared =
      o.eligible !== null
        ? o.eligible.filter((id) => mine.has(id))
        : await eligibleProductIds(client, tenantId, ruleSetsOf(o.record.definition), { among: candidate.eligible });
    if (shared.length === 0) continue;
    const header = loaded.headers.find((h) => h.id === o.offerId)!;
    const state = stateOf(loaded, header);
    out.push({
      offerId: o.offerId,
      offerVersion: o.version,
      nameAr: o.record.definition.nameAr,
      state: state === "paused" ? "paused" : state === "active" ? "active" : "scheduled",
      sharedProductCount: shared.length,
      sharedProductSample: shared.slice(0, SAMPLE),
    });
  }
  return out.sort((a, b) => b.sharedProductCount - a.sharedProductCount || (a.offerId < b.offerId ? -1 : 1)).slice(0, CONFLICT_LIMIT);
}

/** The stores of a definition's scope (live stores only), with their zones. */
function definitionScopeStores(
  definition: OfferDefinition,
  stores: LoadedTenantOffers["stores"],
): LoadedTenantOffers["stores"] {
  const s = definition.storeScope;
  return "allStores" in s ? stores : stores.filter((x) => s.storeIds.includes(x.id));
}

export async function checkDefinition(
  client: PoolClient,
  tenantId: string,
  loaded: LoadedTenantOffers,
  others: ReadonlyArray<LiveOffer>,
  definition: OfferDefinition,
): Promise<DefinitionCheck> {
  const issues: PreviewIssue[] = [];
  for (const ref of await findInvalidReferences(client, tenantId, definition)) {
    issues.push({ code: "offer_reference_invalid", field: ref.field, message: "This reference is not available." });
  }

  const scoped = definitionScopeStores(definition, loaded.stores);
  const windows = scoped.map((s) => ({ id: s.id, window: resolveWindow(definition.schedule, s.timezone) }));
  // A window whose end does not come after its start in the store's zone (two local times in one DST gap resolve to the
  // same instant) is never open: it holds nothing, so an offer empty in every store is refused as elapsed.
  const holding = windows
    .filter((w) => !windowClosed(w.window, loaded.now) && !windowEmpty(w.window))
    .map((w) => w.id);
  if (scoped.length > 0 && holding.length === 0) {
    issues.push({ code: "offer_schedule_elapsed", field: "/schedule/endsAt", message: "The offer has already ended in every store of its scope." });
  }

  const eligible = await eligibleProductIds(client, tenantId, ruleSetsOf(definition));
  if (eligible.length === 0) {
    issues.push({ code: "offer_eligible_set_empty", field: "/eligibility", message: "The rules match no product." });
  } else if (eligible.length > ELIGIBLE_SET_LIMIT) {
    issues.push({ code: "offer_eligible_set_too_large", field: "/eligibility", message: `The rules match more than ${ELIGIBLE_SET_LIMIT} products.` });
  }

  const liveCount = new Map<string, number>();
  for (const o of others) for (const s of o.holdingStores) liveCount.set(s, (liveCount.get(s) ?? 0) + 1);
  if (holding.some((s) => (liveCount.get(s) ?? 0) + 1 > STORE_OFFER_LIMIT)) {
    issues.push({
      code: "offer_store_offer_limit_exceeded",
      field: "/storeScope",
      message: `A store of the scope would hold more than ${STORE_OFFER_LIMIT} live offers.`,
    });
  }

  const conflicts =
    eligible.length > 0 && eligible.length <= ELIGIBLE_SET_LIMIT
      ? await findConflicts(client, tenantId, loaded, others, { eligible, stores: new Set(holding) })
      : [];
  return { issues, eligible, holdingStores: holding, conflicts };
}
