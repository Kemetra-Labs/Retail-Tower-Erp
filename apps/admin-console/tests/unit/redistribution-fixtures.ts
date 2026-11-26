import type {
  RedistributionProposal,
  RedistributionProposalLine,
  RedistributionProposalSummary,
} from "@/lib/redistribution-queries";

export const PROPOSAL_ID = "0190f5a2-3b4c-7d8e-9f01-0000000000a1";
export const STORE_A = "0190f5a2-3b4c-7d8e-9f01-0000000000b1";
export const STORE_B = "0190f5a2-3b4c-7d8e-9f01-0000000000b3";
export const LINE_1 = "0190f5a2-3b4c-7d8e-9f01-0000000000d1";
export const LINE_2 = "0190f5a2-3b4c-7d8e-9f01-0000000000d2";
export const PRODUCT_1 = "0190f5a2-3b4c-7d8e-9f01-0000000000e1";
const PRODUCT_2 = "0190f5a2-3b4c-7d8e-9f01-0000000000e2";
export const TRANSFER_1 = "0190f5a2-3b4c-7d8e-9f01-0000000000f1";
const USER = "0190f5a2-3b4c-7d8e-9f01-0000000000c1";
const NOW = "2026-11-26T08:00:00.000Z";

export function line(over: Partial<RedistributionProposalLine> = {}): RedistributionProposalLine {
  return {
    id: LINE_1,
    productId: PRODUCT_1,
    sourceStoreId: STORE_A,
    destinationStoreId: STORE_B,
    quantity: "8.0000",
    stockingUnit: "piece",
    warnings: [],
    reviewDecision: null,
    acceptOutcome: null,
    ...over,
  };
}

export function proposal(over: Partial<RedistributionProposal> = {}): RedistributionProposal {
  return {
    id: PROPOSAL_ID,
    state: "open",
    acceptEnabled: false,
    createdAt: NOW,
    createdBy: USER,
    expiresAt: "2026-11-27T08:00:00.000Z",
    decidedAt: null,
    supersededBy: null,
    rejectReason: null,
    rule: { name: "reorder_gap_greedy", version: "1.0.0" },
    computedAt: NOW,
    limits: { maxStores: 50, maxRows: 20000, deadlineMs: 5000, maxLinesPerTransfer: 100 },
    buffer: { minimum: "1.0000", percentOfReorderLevel: 10, rounding: "scale" },
    stores: [
      { storeId: STORE_A, readAt: NOW, eligibleAsSource: true, exclusion: null },
      {
        storeId: STORE_B,
        readAt: NOW,
        eligibleAsSource: false,
        exclusion: "device_heartbeat_stale",
      },
    ],
    objective: { deficitBefore: "20.0000", deficitAfter: "4.0000", storePairs: 1, lines: 2 },
    validator: { passed: true, violations: [] },
    warnings: [{ code: "reorder_level_missing", storeId: STORE_B, count: 3 }],
    lines: [line(), line({ id: LINE_2, productId: PRODUCT_2, quantity: "2.5000" })],
    ...over,
  };
}

export function summary(
  over: Partial<RedistributionProposalSummary> = {},
): RedistributionProposalSummary {
  return {
    id: PROPOSAL_ID,
    state: "open",
    acceptEnabled: false,
    createdAt: NOW,
    expiresAt: "2026-11-27T08:00:00.000Z",
    computedAt: NOW,
    objective: { deficitBefore: "20.0000", deficitAfter: "4.0000", storePairs: 1, lines: 2 },
    lineCount: 2,
    excludedStoreCount: 1,
    warningCount: 1,
    ...over,
  };
}

export const createdOutcome = {
  outcome: "created" as const,
  proposedQuantity: "8.0000",
  createdQuantity: "8.0000",
  transferId: TRANSFER_1,
  reason: null,
  decidedAt: NOW,
  decidedBy: USER,
};

export const droppedOutcome = {
  outcome: "dropped" as const,
  proposedQuantity: "2.5000",
  createdQuantity: null,
  transferId: null,
  reason: "source_not_fresh",
  decidedAt: NOW,
  decidedBy: USER,
};
