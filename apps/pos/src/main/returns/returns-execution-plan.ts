/**
 * RT-1543 — what a paid-out return reports to Backend-Core as refund executions.
 *
 * A NEW return sends one `allocationRef` per refund tender (all or none, allocation rule 1 of
 * `recordReturn`); the refs live inside the journaled request body, so they are fixed before the
 * first send and never change on a retry. After the payout completes, each allocation is paid out
 * once, and that payout is reported as one `recordRefundExecution`.
 *
 * `readAllocations` reads the refs back from the STORED body, all or none: a return journaled by an
 * older build (no refs), a body with only some refs or a repeated ref, an unreadable body, or an
 * allocation of 0 yields nothing, so such a return never produces an execution. Pure; never throws.
 */
import type { ReturnPayoutMethod } from '../../shared/returns/types.js';
import { RETURN_SOURCE_SYSTEM } from './returns-quote.js';
import { parseJsonBody } from './returns-wire.js';

/** The execution provenance id: `pos-pulse-refund-exec:<executionRef>` (58 characters). */
export const EXECUTION_EXTERNAL_ID_PREFIX = 'pos-pulse-refund-exec:';

/** An allocation (refund tender) of a stored return body that can be paid out and reported. */
export interface PlannedAllocation {
  readonly allocationRef: string;
  /** The allocation's amount exactly as the stored body holds it (positive decimal string). */
  readonly amount: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `NonNegativeDecimalAmount` of the contract. */
const AMOUNT = /^[0-9]{1,15}(\.[0-9]{1,4})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveAmount(value: unknown): value is string {
  return typeof value === 'string' && AMOUNT.test(value) && /[1-9]/.test(value);
}

/** The tenders of a stored body, or null when the body is not a readable return body. */
function tendersOf(requestBodyJson: string): unknown[] | null {
  const body = parseJsonBody(requestBodyJson);
  if (!isRecord(body)) return null;
  const tenders = body['refundTenders'];
  return Array.isArray(tenders) && tenders.length > 0 ? tenders : null;
}

function allocationOf(tender: unknown): PlannedAllocation | null {
  if (!isRecord(tender)) return null;
  const { allocationRef, amount } = tender;
  if (typeof allocationRef !== 'string' || !UUID.test(allocationRef)) return null;
  return isPositiveAmount(amount) ? { allocationRef, amount } : null;
}

/** The refs of `requestBodyJson`: every tender with a unique ref and a positive amount, else none. */
export function readAllocations(requestBodyJson: string): readonly PlannedAllocation[] {
  const tenders = tendersOf(requestBodyJson);
  if (tenders === null) return [];
  const planned: PlannedAllocation[] = [];
  for (const tender of tenders) {
    const allocation = allocationOf(tender);
    if (allocation === null) return [];
    planned.push(allocation);
  }
  const distinct = new Set(planned.map((a) => a.allocationRef.toLowerCase()));
  return distinct.size === planned.length ? planned : [];
}

/**
 * The contract's `evidence.method`. Owner decision on RT-1543 ("Keep manual"): a `no_drawer` payout
 * (the terminal has no cash drawer, RT-531, so there is no attestation step) is reported as
 * `manual`, the only value of the closed `drawer | manual` enum that fits. It is not a manual
 * attestation. A follow-up CONTRACT decision (a distinct `no_drawer` evidence method on
 * `RefundExecutionEvidence`, a Backend-Core change) is owed if the difference must be reported.
 */
export function evidenceMethodOf(method: ReturnPayoutMethod): 'drawer' | 'manual' {
  return method === 'drawer' ? 'drawer' : 'manual';
}

export interface ExecutionBodyInput {
  readonly externalId: string;
  readonly executionRef: string;
  readonly allocationRef: string;
  readonly amount: string;
  readonly method: 'drawer' | 'manual';
  readonly paidAt: string;
  readonly shiftRef: string;
}

/** The `RecordRefundExecutionRequest` bytes, frozen once at enqueue and re-sent as they are. */
export function buildExecutionBody(input: ExecutionBodyInput): string {
  return JSON.stringify({
    sourceSystem: RETURN_SOURCE_SYSTEM,
    externalId: input.externalId,
    executionRef: input.executionRef,
    allocationRef: input.allocationRef,
    amount: input.amount,
    outcome: 'settled',
    evidence: { method: input.method, paidAt: input.paidAt, shiftRef: input.shiftRef },
  });
}
