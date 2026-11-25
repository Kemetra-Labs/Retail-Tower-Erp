/**
 * RT-1598 — the policy values the engine and the validator share. Values only: each side computes with them on
 * its own code path.
 */
import type { BufferPolicyV1, RedistributionLimitsV1 } from './types';

export const RULE_V1 = { name: 'reorder_gap_greedy', version: '1.0.0' } as const;

/**
 * The W3 transfer line limit. W3's `shipment-transfer.rules.ts` exports it as `TRANSFER_LINE_MAX`, but that
 * file loads Nest through `common/quantity`, so this pure module mirrors the value; a spec pins the two equal.
 */
export const TRANSFER_LINE_MAX = 100;

/**
 * Whether a source may end at exactly `reorderLevel + buffer` (true) or must end strictly above it (false).
 * P-10's surplus formula ends a fully used source exactly there, so the floor is inclusive.
 * The engine and the validator both read this one constant.
 */
export const SOURCE_FLOOR_INCLUSIVE = true;

/** P-10 placeholder: `max(1 stocking unit, 10% of reorderLevel)`, rounded up at the 0.0001 scale. */
export const DEFAULT_BUFFER_POLICY_V1: BufferPolicyV1 = {
  minimum: '1.0000',
  percentOfReorderLevel: 10,
  rounding: 'scale',
};

/** P-6 placeholder caps and the D-3 time budget. */
export const DEFAULT_LIMITS_V1: RedistributionLimitsV1 = {
  maxStores: 50,
  maxRows: 20_000,
  deadlineMs: 5_000,
  maxLinesPerTransfer: TRANSFER_LINE_MAX,
};

/**
 * RT-1600 freshness gate (placeholder, tuned with the pilot): an active till whose last heartbeat is older than this,
 * or that never reported, makes its store ineligible as a SOURCE (`device_heartbeat_stale`).
 */
export const HEARTBEAT_STALE_AFTER_MS = 15 * 60 * 1000;

/** RT-1599 V1: a proposal expires 24 hours after it was created. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
