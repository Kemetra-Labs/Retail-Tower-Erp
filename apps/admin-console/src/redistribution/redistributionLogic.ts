/**
 * RT-1601 redistribution proposals: access rules, state gating and display keys. Pure: no React, no
 * client. The Console decides nothing about stock: every line, quantity, exclusion, warning and
 * accept outcome comes from Backend-Core (RT-1600), which re-checks everything again at accept.
 *
 * Roles (mirrored from the RT-1599 contract to show or hide controls; Backend-Core stays the
 * authority and answers the non-disclosing 404 otherwise): owner and tenant_admin whose store access
 * covers every store of the tenant. A store-scoped membership, every other role, and a tenant with
 * the feature off all get the same "not available" view; the screen never says which.
 *
 * Helpers return catalog message keys, never copy (RT-399). Open-string codes (exclusions, warnings,
 * drop reasons) that this build does not know read as a generic label, never as the raw code alone.
 */
import type { MessageKey } from "@/i18n";
import type {
  RedistributionProposal,
  RedistributionProposalLine,
  RedistributionProposalState,
} from "@/lib/redistribution-queries";

const ROLES = ["owner", "tenant_admin"] as const;

/** The sidebar entry: role only (the store scope is checked on the page). */
export function canReadRedistribution(role: string | null | undefined): boolean {
  return (ROLES as readonly string[]).includes(role ?? "");
}

/** Owner or tenant_admin with tenant-wide store access: a proposal reads and moves every store. */
export function canUseRedistribution(
  role: string | null | undefined,
  storeAccessKind: "all" | "specific" | undefined,
): boolean {
  return canReadRedistribution(role) && storeAccessKind !== "specific";
}

// --- States ------------------------------------------------------------------------------------

const STATE_KEYS: Record<RedistributionProposalState, MessageKey> = {
  open: "redistribution.state.open",
  reviewed: "redistribution.state.reviewed",
  partially_accepted: "redistribution.state.partially_accepted",
  accepted: "redistribution.state.accepted",
  rejected: "redistribution.state.rejected",
  expired: "redistribution.state.expired",
  superseded: "redistribution.state.superseded",
};

export function stateKey(state: string): MessageKey {
  return Object.hasOwn(STATE_KEYS, state)
    ? STATE_KEYS[state as RedistributionProposalState]
    : "redistribution.state.unknown";
}

/** Status is data (UX-10.29): waiting on a decision warns, accepted succeeds, the rest stay quiet. */
export function stateBadgeClass(state: string): string {
  if (state === "open" || state === "reviewed" || state === "partially_accepted") {
    return "badge badge--warning";
  }
  if (state === "accepted") return "badge badge--success";
  if (!Object.hasOwn(STATE_KEYS, state)) return "badge badge--danger";
  return "badge";
}

const DECIDABLE: readonly string[] = ["open", "reviewed", "partially_accepted"];

/** Review, accept and reject are allowed only while the proposal waits on a decision. */
export function isDecidable(state: string): boolean {
  return DECIDABLE.includes(state);
}

// --- Lines -------------------------------------------------------------------------------------

export interface LineActions {
  /** Record "would accept" / "would reject" (both phases). */
  review: boolean;
  /** Select the line for accept (live phase only). */
  accept: boolean;
}

/** A line can be reviewed or accepted while the proposal is decidable and it has no outcome yet. */
export function lineActions(
  proposal: Pick<RedistributionProposal, "state" | "acceptEnabled">,
  line: Pick<RedistributionProposalLine, "acceptOutcome">,
): LineActions {
  const open = isDecidable(proposal.state) && line.acceptOutcome === null;
  return { review: open, accept: open && proposal.acceptEnabled };
}

/** The lines still open for accept, in proposal order. */
export function acceptableLineIds(proposal: RedistributionProposal): string[] {
  return proposal.lines.filter((line) => lineActions(proposal, line).accept).map((l) => l.id);
}

/** The created draft transfers, once each, in the order their lines appear. */
export function createdTransferIds(proposal: RedistributionProposal): string[] {
  const ids: string[] = [];
  for (const line of proposal.lines) {
    const id = line.acceptOutcome?.transferId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// --- Open-string codes -------------------------------------------------------------------------

function keyed(map: Record<string, MessageKey>, code: string, fallback: MessageKey): MessageKey {
  return Object.hasOwn(map, code) ? (map[code] as MessageKey) : fallback;
}

const EXCLUSIONS: Record<string, MessageKey> = {
  pos_queue_unknown: "redistribution.exclusion.pos_queue_unknown",
  pos_queue_dead_letter_or_held: "redistribution.exclusion.pos_queue_dead_letter_or_held",
  device_heartbeat_stale: "redistribution.exclusion.device_heartbeat_stale",
  inactive: "redistribution.exclusion.inactive",
};

export function exclusionKey(code: string): MessageKey {
  return keyed(EXCLUSIONS, code, "redistribution.exclusion.unknown");
}

const WARNINGS: Record<string, MessageKey> = {
  store_excluded_as_source: "redistribution.warning.store_excluded_as_source",
  negative_available_to_sell: "redistribution.warning.negative_available_to_sell",
  reorder_level_missing: "redistribution.warning.reorder_level_missing",
  tracked_product_skipped: "redistribution.warning.tracked_product_skipped",
  stocking_unit_mismatch: "redistribution.warning.stocking_unit_mismatch",
  source_near_reorder_level: "redistribution.warning.source_near_reorder_level",
};

export function warningKey(code: string): MessageKey {
  return keyed(WARNINGS, code, "redistribution.warning.unknown");
}

const DROP_REASONS: Record<string, MessageKey> = {
  source_not_fresh: "redistribution.reason.source_not_fresh",
  source_available_insufficient: "redistribution.reason.source_available_insufficient",
  destination_gap_closed: "redistribution.reason.destination_gap_closed",
  product_not_sellable: "redistribution.reason.product_not_sellable",
  stocking_unit_changed: "redistribution.reason.stocking_unit_changed",
  transfer_rule_refused: "redistribution.reason.transfer_rule_refused",
};

export function dropReasonKey(code: string): MessageKey {
  return keyed(DROP_REASONS, code, "redistribution.reason.unknown");
}

// --- Lists -------------------------------------------------------------------------------------

export function nextCursor(page: { nextCursor: string | null }): string | undefined {
  return page.nextCursor ?? undefined;
}

/** One row per proposal across pages, where it first appeared (a keyset walk is not a snapshot). */
export function dedupeById<T extends { id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
