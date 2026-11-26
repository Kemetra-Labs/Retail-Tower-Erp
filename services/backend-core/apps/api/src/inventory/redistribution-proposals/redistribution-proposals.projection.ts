/**
 * RT-1600 — the wire bodies of `inventory/redistribution-proposals.yaml` (RT-1599) from the stored rows. A stored
 * proposal always passed the independent validator (a result that is not `proposed` is never stored), so its report is
 * the constant `{ passed: true, violations: [] }`.
 */
import { effectiveState, type LineRow, type ProposalRow } from './redistribution-proposals.store';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function reviewDecisionOf(l: LineRow): Record<string, unknown> | null {
  if (l.review_decision === null) return null;
  return { decision: l.review_decision, note: l.review_note, decidedAt: iso(l.reviewed_at), decidedBy: l.reviewed_by };
}

/** The contract `RedistributionAcceptOutcome` of a line, or null when it has none. */
export function acceptOutcomeOf(l: LineRow): Record<string, unknown> | null {
  if (l.accept_outcome === null) return null;
  return {
    outcome: l.accept_outcome,
    proposedQuantity: l.quantity,
    createdQuantity: l.accept_created_quantity,
    transferId: l.accept_transfer_id,
    reason: l.accept_reason,
    decidedAt: iso(l.accepted_at),
    decidedBy: l.accepted_by,
  };
}

function lineBody(l: LineRow): Record<string, unknown> {
  return {
    id: l.id,
    productId: l.product_id,
    sourceStoreId: l.source_store_id,
    destinationStoreId: l.destination_store_id,
    quantity: l.quantity,
    stockingUnit: l.stocking_unit,
    warnings: l.warnings,
    reviewDecision: reviewDecisionOf(l),
    acceptOutcome: acceptOutcomeOf(l),
  };
}

const objectiveOf = (p: ProposalRow): Record<string, unknown> => ({
  deficitBefore: p.deficit_before,
  deficitAfter: p.deficit_after,
  storePairs: p.store_pairs,
  lines: p.line_count,
});

/** Contract `RedistributionProposal`. `acceptEnabled` is the tenant's phase when the response is produced. */
export function proposalBody(p: ProposalRow, lines: readonly LineRow[], nowMs: number, acceptEnabled: boolean): Record<string, unknown> {
  return {
    id: p.id,
    state: effectiveState(p, nowMs),
    acceptEnabled,
    createdAt: iso(p.created_at),
    createdBy: p.created_by,
    expiresAt: iso(p.expires_at),
    decidedAt: iso(p.decided_at),
    supersededBy: p.superseded_by,
    rejectReason: p.reject_reason,
    rule: { name: p.rule_name, version: p.rule_version },
    computedAt: iso(p.computed_at),
    limits: p.limits,
    buffer: p.buffer,
    stores: p.stores,
    objective: objectiveOf(p),
    validator: { passed: true, violations: [] },
    warnings: p.warnings,
    lines: lines.map(lineBody),
  };
}

/** Contract `RedistributionProposalSummary`. */
export function proposalSummary(p: ProposalRow, nowMs: number, acceptEnabled: boolean): Record<string, unknown> {
  return {
    id: p.id,
    state: effectiveState(p, nowMs),
    acceptEnabled,
    createdAt: iso(p.created_at),
    expiresAt: iso(p.expires_at),
    computedAt: iso(p.computed_at),
    objective: objectiveOf(p),
    lineCount: p.line_count,
    excludedStoreCount: p.stores.filter((s) => s.exclusion !== null).length,
    warningCount: p.warnings.length,
  };
}
