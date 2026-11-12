/**
 * RT-1338 offers (RT-286 S6): access rules, lifecycle gating and display helpers. Pure: no React, no
 * client. The Console is a control surface only: it evaluates no offer, resolves no category or brand
 * rule and computes no eligible set. Every number it shows (eligible count, conflicts, simulation)
 * comes from Backend-Core.
 *
 * Roles (OD-12, mirrored from the contract to show or hide controls; Backend-Core stays the authority
 * and answers a 403 or a non-disclosing 404 otherwise):
 *   - owner, tenant_admin: manage (draft, preview, end, archive), publish (publish, resume) and pause.
 *   - store_manager: read, and pause for their OWN stores only: never a whole-offer pause.
 *   - a role never widens a membership (RT-131): an owner or tenant_admin whose membership names
 *     specific stores is bounded like a store_manager for pauses, and authors no all-stores offer.
 * A store_manager's reads are filtered to their own stores by the server, so the UI never presents
 * `storeScope.storeIds` or `pausedStores` as the complete lists.
 *
 * Helpers return catalog message keys, never copy (RT-399).
 */
import type { MessageKey } from "@/i18n";
import type { Offer, OfferSchedule, OfferState } from "@/lib/offer-queries";

export const OFFER_STATES: readonly OfferState[] = [
  "draft",
  "scheduled",
  "active",
  "paused",
  "ended",
  "archived",
];

const STATE_KEYS: Record<OfferState, MessageKey> = {
  draft: "offers.state.draft",
  scheduled: "offers.state.scheduled",
  active: "offers.state.active",
  paused: "offers.state.paused",
  ended: "offers.state.ended",
  archived: "offers.state.archived",
};

/** The label key for a derived state; a state this build does not know reads as unknown. */
export function offerStateKey(state: string): MessageKey {
  return Object.hasOwn(STATE_KEYS, state)
    ? STATE_KEYS[state as OfferState]
    : "offers.state.unknown";
}

/** Status is data, not decoration (UX-10.29): live is success, paused warns, the rest stay quiet. */
export function offerStateBadgeClass(state: string): string {
  if (state === "active") return "badge badge--success";
  if (state === "paused") return "badge badge--warning";
  if (!Object.hasOwn(STATE_KEYS, state)) return "badge badge--danger";
  return "badge";
}

// --- Access ------------------------------------------------------------------------------------

const READ_ROLES = ["owner", "tenant_admin", "store_manager"] as const;
const MANAGE_ROLES = ["owner", "tenant_admin"] as const;

export function canReadOffers(role: string | null | undefined): boolean {
  return (READ_ROLES as readonly string[]).includes(role ?? "");
}

export interface OfferAccess {
  canRead: boolean;
  /** Create and edit drafts, preview, end, archive (`offers.manage`). */
  canManage: boolean;
  /** Publish and resume (`offers.publish`). */
  canPublish: boolean;
  /** Pause (`offers.pause`): own stores for a store_manager. */
  canPause: boolean;
  /** Pause a whole offer: owner or tenant_admin with tenant-wide stores. */
  canPauseWhole: boolean;
  /** False when the membership names specific stores: no all-stores offer and no whole pause. */
  tenantWide: boolean;
}

export function offerAccess(
  role: string | null | undefined,
  storeAccessKind: "all" | "specific" | undefined,
): OfferAccess {
  const canRead = canReadOffers(role);
  const manages = (MANAGE_ROLES as readonly string[]).includes(role ?? "");
  const tenantWide = storeAccessKind !== "specific";
  return {
    canRead,
    canManage: manages,
    canPublish: manages,
    canPause: canRead,
    canPauseWhole: manages && tenantWide,
    tenantWide,
  };
}

// --- Lifecycle gating --------------------------------------------------------------------------

export interface OfferActions {
  /** Edit the draft, or start the next draft of a published offer. */
  edit: boolean;
  preview: boolean;
  publish: boolean;
  pause: boolean;
  resume: boolean;
  end: boolean;
  archive: boolean;
}

const EDITABLE: readonly OfferState[] = ["draft", "scheduled", "active", "paused"];
const LIVE: readonly OfferState[] = ["scheduled", "active", "paused"];

/** Which lifecycle controls an offer offers this caller. The server re-checks every one. */
export function offerActions(offer: Offer, access: OfferAccess): OfferActions {
  const { state } = offer;
  const hasDraft = offer.draft !== null;
  return {
    edit: access.canManage && EDITABLE.includes(state),
    preview: access.canManage && hasDraft && EDITABLE.includes(state),
    publish: access.canPublish && hasDraft && EDITABLE.includes(state),
    pause: access.canPause && (state === "scheduled" || state === "active" || state === "paused"),
    resume: access.canPublish && (state === "paused" || offer.pausedStores.length > 0),
    end: access.canManage && LIVE.includes(state),
    archive: access.canManage && state === "ended",
  };
}

// --- Pause -------------------------------------------------------------------------------------

export const REASON_MAX = 500;

export type PauseScope = "whole" | "stores";

export interface PauseDraft {
  reason: string;
  scope: PauseScope;
  storeIds: readonly string[];
}

export type PauseErrors = Partial<Record<"reason" | "storeIds", MessageKey>>;

export type PauseResult =
  | { ok: true; body: { reason: string; storeIds?: string[] } }
  | { ok: false; errors: PauseErrors };

/** A required reason (1 to 500 characters, trimmed) and, for a store pause, at least one store. */
export function buildPauseBody(draft: PauseDraft, access: OfferAccess): PauseResult {
  const reason = draft.reason.trim();
  const errors: PauseErrors = {};
  if (reason === "") errors.reason = "offers.pause.error.reasonRequired";
  else if (reason.length > REASON_MAX) errors.reason = "offers.pause.error.reasonTooLong";
  const whole = draft.scope === "whole" && access.canPauseWhole;
  if (!whole && draft.storeIds.length === 0) errors.storeIds = "offers.pause.error.storesRequired";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: whole ? { reason } : { reason, storeIds: [...draft.storeIds] } };
}

type Store = { id: string; name?: string };

/**
 * The stores a pause can name: the caller's own roster, narrowed to the offer's published scope and
 * minus the stores already paused. The roster is the caller's own (a store_manager's server read is
 * filtered the same way), so this never offers a store the caller cannot pause.
 */
export function pausableStores(offer: Offer, roster: readonly Store[]): Store[] {
  const scope = offer.currentVersion?.definition.storeScope;
  const paused = new Set(offer.pausedStores.map((p) => p.storeId));
  return roster.filter((store) => {
    if (paused.has(store.id)) return false;
    if (!scope || "allStores" in scope) return true;
    return scope.storeIds.includes(store.id);
  });
}

// --- Display -----------------------------------------------------------------------------------

/** `2026-11-20T09:00` → `2026-11-20 09:00`: a store-local time is shown as written, never converted. */
function localTimeText(value: string): string {
  return value.replace("T", " ").slice(0, 16);
}

export interface ScheduleText {
  start: string;
  /** Null when the offer has no end. */
  end: string | null;
  /** Times are store-local (shown as written); false for an absolute instant. */
  storeLocal: boolean;
}

export function scheduleText(schedule: OfferSchedule): ScheduleText {
  return {
    start: localTimeText(schedule.startsAt),
    end: schedule.endsAt ? localTimeText(schedule.endsAt) : null,
    storeLocal: schedule.timeBasis === "store_local",
  };
}

/** Keyset paging: "no more" is a null cursor. */
export function nextOfferCursor(page: { nextCursor: string | null }): string | undefined {
  return page.nextCursor ?? undefined;
}

/** One row per offer across pages, where it first appeared (a keyset walk is not a snapshot). */
export function dedupeById<T extends { offerId: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.offerId)) return false;
    seen.add(row.offerId);
    return true;
  });
}
