/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the lead-time rule of `validate` (spec 042 §7, decision 637;
 * RT-1484 comment 17875, decision 2). Pure: the lead time is a parameter.
 *
 * `pricing.min_lead_time` is a hard-coded v1 default of 0 (no lead time; there is no settings
 * table, RT-1151 plan D5). A `standard` set violates it when one of its effective instants that is
 * not already in the past falls inside `[now, now + lead time)`; an instant before now is the
 * `past_dated` finding, not a lead-time violation. Emergency and rollback sets are exempt (§7: the
 * rule names standard sets; emergency may skip lead time).
 */

/** v1: no minimum lead time (spec 042 §7 "default none in v1"). */
export const DEFAULT_MIN_LEAD_TIME_MS = 0;

export interface LeadTimeInput {
  readonly kind: "standard" | "emergency" | "rollback" | "legacy_import";
  readonly nowMs: number;
  readonly minLeadTimeMs: number;
  /** Every effective instant of the set's lines (per Store), in ms. */
  readonly effectiveMs: readonly number[];
}

/** True when the set must be refused with `422 lead_time_violation`. */
export function violatesLeadTime(input: LeadTimeInput): boolean {
  if (input.kind !== "standard" || !(input.minLeadTimeMs > 0)) return false;
  const limit = input.nowMs + input.minLeadTimeMs;
  return input.effectiveMs.some((ms) => ms >= input.nowMs && ms < limit);
}
