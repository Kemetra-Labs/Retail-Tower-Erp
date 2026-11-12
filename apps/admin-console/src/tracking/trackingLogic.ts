/**
 * RT-455 pure helpers for the tracking holds screen and the identity detail. No
 * React, no fetch.
 *
 * Truth rules (as `inventory/inventoryLogic.ts`): quantities are the API's
 * exact-decimal strings, rendered as sent and never summed here; a value the
 * API did not send, or a read that failed, is Unknown, never zero. Every rule
 * (who may release, what a hold moves) stays in Backend-Core: these helpers only
 * mirror the contract's roles so the screen does not offer what the API refuses.
 *
 * RT-399: helpers return catalog message keys, never copy.
 */
import type { MessageKey } from "@/i18n";
import type {
  ActiveHoldFinding,
  ConsistencyFinding,
  ExpiredSellableFinding,
  SafetyFinding,
} from "@/lib/tracking-queries";

// --- Roles --------------------------------------------------------------------

/** `getTenantTrackingSummary` and `listInventorySafetyFindings`: owner, tenant_admin, store_manager. */
const FINDING_ROLES = ["owner", "tenant_admin", "store_manager"] as const;

/** Holds, recalls and identity reads: owner or tenant_admin (403 or 404 otherwise). */
const HOLD_ROLES = ["owner", "tenant_admin"] as const;

function hasRole(roles: readonly string[], role: string | null | undefined): boolean {
  return roles.includes(role ?? "");
}

/** The holds screen opens for a role that can read the findings. */
export function canOpenTracking(role: string | null | undefined): boolean {
  return hasRole(FINDING_ROLES, role);
}

/** Holds, recalls, the hold drawer and the identity detail. */
export function canReadHolds(role: string | null | undefined): boolean {
  return hasRole(HOLD_ROLES, role);
}

/** `releaseTrackingHold` is owner only (965, H1). */
export function canReleaseHold(role: string | null | undefined): boolean {
  return role === "owner";
}

/** `bindTrackingResolution` is owner only (high sensitivity, as the release). */
export function canBindResolution(role: string | null | undefined): boolean {
  return role === "owner";
}

/**
 * The queue's sales are for owner and tenant_admin; a store_manager gets the
 * count only (OD-9), so it never sees a row.
 */
export function canReadQueue(role: string | null | undefined): boolean {
  return hasRole(HOLD_ROLES, role);
}

/**
 * The nav entry (TR-1, TR-6): listed only for a role that can open the screen
 * AND once the summary has answered that the tenant has tracked products AND
 * (RT-455 part 1, OD-T4) once the tenant's tracked-selling switch has answered
 * that it is on. Loading, failed, the gate's 404 or false all hide it
 * (decisions 967, 968).
 */
export function showTrackingNav(
  role: string | null | undefined,
  hasTrackedProducts: boolean | undefined,
  trackedSellingOn: boolean | undefined,
): boolean {
  return canOpenTracking(role) && hasTrackedProducts === true && trackedSellingOn === true;
}

// --- Codes --------------------------------------------------------------------

function keyOf(map: Record<string, MessageKey>, code: string): MessageKey | undefined {
  return Object.hasOwn(map, code) ? map[code] : undefined;
}

/** The fixed command list (`SafetyReasonCodeInput`, TR-5); reads keep a pattern. */
export const REASON_CODES = [
  "supplier_notice",
  "authority_notice",
  "label_misprint",
  "other",
] as const;

const REASON_KEYS: Record<string, MessageKey> = {
  supplier_notice: "tracking.reason.supplier_notice",
  authority_notice: "tracking.reason.authority_notice",
  label_misprint: "tracking.reason.label_misprint",
  other: "tracking.reason.other",
};

/**
 * A stored reason code's label. Reads carry the `SafetyReasonCode` pattern, not
 * the list, so a code outside it has no label: the caller shows the code as sent.
 */
export function reasonKey(code: string): MessageKey | undefined {
  return keyOf(REASON_KEYS, code);
}

const HOLD_KIND_KEYS: Record<string, MessageKey> = {
  quality_hold: "tracking.holdKind.quality_hold",
  recall_hold: "tracking.holdKind.recall_hold",
};

export function holdKindKey(code: string): MessageKey {
  return keyOf(HOLD_KIND_KEYS, code) ?? "inventory.value.unknown";
}

const CHECK_KEYS: Record<string, MessageKey> = {
  identity_without_edge_map: "tracking.check.identity_without_edge_map",
  untracked_effect_on_tracked_product: "tracking.check.untracked_effect_on_tracked_product",
  serial_position_out_of_range: "tracking.check.serial_position_out_of_range",
  profile_erp_flag_mismatch: "tracking.check.profile_erp_flag_mismatch",
};

export function checkKey(code: string): MessageKey {
  return keyOf(CHECK_KEYS, code) ?? "inventory.value.unknown";
}

const FINDING_KIND_KEYS: Record<string, MessageKey> = {
  unvalidated_tracked_line: "tracking.saleLines.kind.unvalidated_tracked_line",
  sold_under_hold: "tracking.saleLines.kind.sold_under_hold",
  erp_intent_held: "tracking.saleLines.kind.erp_intent_held",
};

export const SALE_LINE_KINDS = [
  "unvalidated_tracked_line",
  "sold_under_hold",
  "erp_intent_held",
] as const;

export function saleLineKindKey(code: string): MessageKey {
  return keyOf(FINDING_KIND_KEYS, code) ?? "inventory.value.unknown";
}

const FINDING_CAUSE_KEYS: Record<string, MessageKey> = {
  validation_missing: "tracking.saleLines.cause.validation_missing",
  validation_mismatch: "tracking.saleLines.cause.validation_mismatch",
  quality_hold: "tracking.saleLines.cause.quality_hold",
  recall_hold: "tracking.saleLines.cause.recall_hold",
  expired: "tracking.saleLines.cause.expired",
  edge_map_missing: "tracking.saleLines.cause.edge_map_missing",
};

export function saleLineCauseKey(code: string): MessageKey {
  return keyOf(FINDING_CAUSE_KEYS, code) ?? "inventory.value.unknown";
}

const LINE_REASON_KEYS: Record<string, MessageKey> = {
  tracking_missing: "tracking.resolution.lineReason.tracking_missing",
  identity_unknown: "tracking.resolution.lineReason.identity_unknown",
  identity_other_product: "tracking.resolution.lineReason.identity_other_product",
};

/** Why a sale line is unresolved, as the contract names it. */
export function lineReasonKey(code: string): MessageKey {
  return keyOf(LINE_REASON_KEYS, code) ?? "inventory.value.unknown";
}

// --- Findings -----------------------------------------------------------------

export interface FindingGroups {
  holds: ActiveHoldFinding[];
  expired: ExpiredSellableFinding[];
  consistency: ConsistencyFinding[];
}

/**
 * The findings split by kind, in the server's order. `expiring_lot` is reserved
 * and never emitted (RT-50 B1): it has no group, so it can never read as zero.
 */
export function groupFindings(findings: readonly SafetyFinding[]): FindingGroups {
  const groups: FindingGroups = { holds: [], expired: [], consistency: [] };
  for (const finding of findings) {
    if (finding.kind === "active_tracking_hold") groups.holds.push(finding);
    else if (finding.kind === "expired_lot_sellable") groups.expired.push(finding);
    else if (finding.kind === "tracking_consistency") groups.consistency.push(finding);
  }
  return groups;
}

/** Distinct ids, in first-seen order, without blanks. */
export function distinct(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Every product a set of findings names (TR-7: names come from the catalog). */
export function findingProductIds(groups: FindingGroups): string[] {
  return distinct([
    ...groups.holds.map((f) => f.tenantProductRef),
    ...groups.expired.map((f) => f.tenantProductRef),
    ...groups.consistency.map((f) => f.tenantProductRef),
  ]);
}

// --- Tabs ---------------------------------------------------------------------

export type TrackingTab =
  | "active"
  | "expired"
  | "expiring"
  | "released"
  | "recalls"
  | "resolution"
  | "saleLines";

const HOLD_TABS: readonly TrackingTab[] = ["released", "recalls"];

const ALL_TABS: readonly TrackingTab[] = [
  "active",
  "expired",
  "expiring",
  "released",
  "recalls",
  "resolution",
  "saleLines",
];

/** The tabs a role sees: the hold and recall lists are owner / tenant_admin only. */
export function tabsFor(role: string | null | undefined): TrackingTab[] {
  const holds = canReadHolds(role);
  return ALL_TABS.filter((tab) => holds || !HOLD_TABS.includes(tab));
}

/** The tab named in the URL when the role has it; else the first. */
export function tabFromSearch(search: URLSearchParams, tabs: readonly TrackingTab[]): TrackingTab {
  const named = search.get("tab");
  return tabs.find((tab) => tab === named) ?? tabs[0];
}

/** The tab an arrow, Home or End key moves to, or undefined for another key. */
export function tabForKey(
  key: string,
  current: TrackingTab,
  tabs: readonly TrackingTab[],
  rtl: boolean,
): TrackingTab | undefined {
  const at = tabs.indexOf(current);
  const step = (offset: number) => tabs[(at + offset + tabs.length) % tabs.length];
  // In RTL the visual "next" tab is to the left.
  const next = rtl ? "ArrowLeft" : "ArrowRight";
  const previous = rtl ? "ArrowRight" : "ArrowLeft";
  const targets: Record<string, TrackingTab> = {
    [next]: step(1),
    [previous]: step(-1),
    Home: tabs[0],
    End: tabs[tabs.length - 1],
  };
  return targets[key];
}

// --- Actors (OD-3) -------------------------------------------------------------

export interface MemberName {
  userId: string;
  displayName: string | null;
  email: string;
}

/**
 * A user id's label from the tenant's members (`listMembers`, OD-3: no name
 * API). The display name, else the email; undefined when the id is not a member
 * (a former member, or a list that did not load): the caller shows the fallback.
 */
export function actorLabel(
  members: readonly MemberName[] | undefined,
  userId: string,
): string | undefined {
  const id = userId.toLowerCase();
  const found = members?.find((m) => m.userId.toLowerCase() === id);
  if (!found) return undefined;
  return found.displayName?.trim() || found.email;
}

// --- Identity -----------------------------------------------------------------

/** The active hold of each kind among an identity's holds (at most one each, H2). */
export function activeHolds<T extends { kind: string; active: boolean }>(holds: readonly T[]): T[] {
  return holds.filter((hold) => hold.active);
}
