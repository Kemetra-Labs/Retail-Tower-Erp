/**
 * RT-1543 — enqueue the refund executions of a payout that has just completed.
 *
 * Called from `completePayout`, INSIDE the transaction that moves the payout row to paid and the
 * journal header to `paid_out`, so a completed payout and its outbox rows commit together or not at
 * all (and the 0068 trigger refuses a row for a return that is not `paid_out`). It is the only
 * enqueue point: `drawer`, `manual` and `no_drawer` payouts all complete there, and a failed,
 * refused or unknown payout never does.
 *
 * What it enqueues (one row per allocation of the STORED request body, frozen bytes):
 *   • nothing for a return whose body carries no usable allocation refs (every return journaled
 *     before RT-1543, a zero-total return, a partial or repeated ref) — all or none;
 *   • the shift that paid is the shift open now or, when none is, the shift that was open when the
 *     payout was CLAIMED (a manager may have closed it on the server since: a claim blocks opening
 *     a shift, so the payout completes with no shift open). Backend-Core records
 *     `evidence.shiftRef` as reported: it checks neither that the shift is open, nor that `paidAt`
 *     falls inside it, nor the device (`refund-executions.service.ts`: one shiftRef per return and
 *     `paidAt` at most 120 s ahead of its clock), so the claim-time shift is accepted;
 *   • nothing, with a warning, when neither exists (a claim made while shift cash-up was off): the
 *     contract requires `evidence.shiftRef` and none is invented;
 *   • nothing, with a warning, when the journal row has no server `returnRef` (cannot happen for a
 *     confirmed return).
 */
import type { ReturnPayoutMethod } from '../../shared/returns/types.js';
import type { ShiftCashupRepo } from '../shift-cashup/shift-cashup-repo.js';
import {
  EXECUTION_EXTERNAL_ID_PREFIX,
  buildExecutionBody,
  evidenceMethodOf,
  readAllocations,
} from './returns-execution-plan.js';
import type { NewExecution, ReturnExecutionsRepository } from './returns-execution-repository.js';
import type { JournalEntry, ReturnScope } from './returns-repository.js';

export interface ExecutionEnqueueDeps {
  readonly repo: Pick<ReturnExecutionsRepository, 'enqueue'>;
  /** The terminal's open shift id (the shift whose drawer paid), or null when none is open. */
  readonly openShiftRef: (scope: ReturnScope) => string | null;
  /** The shift that was open on the terminal at an instant (the payout's claim), or null. */
  readonly shiftRefAt: (scope: ReturnScope, at: string) => string | null;
  /** A fresh `executionRef` (UUIDv7). */
  readonly newExecutionRef: () => string;
  readonly logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Enqueue the executions of `entry`, paid out by `method` at `paidAt` (the commit's own stamp), for
 * a payout claimed at `claimedAt`.
 */
export type EnqueueExecutions = (
  entry: JournalEntry,
  method: ReturnPayoutMethod,
  paidAt: string,
  claimedAt: string,
) => void;

/**
 * The terminal's open shift id from the shift cash-up repository, or null when none is open (or
 * shift cash-up is off, so none can be). Kept here, apart from the composition root, so it is tested.
 */
export function openShiftRefOf(
  shifts: Pick<ShiftCashupRepo, 'findOpenShift'>,
): (scope: ReturnScope) => string | null {
  return (scope) => shifts.findOpenShift(scope)?.shiftId ?? null;
}

/**
 * The id of the shift that was open at an instant, from the shift cash-up records, or null (none
 * then). Kept here, apart from the composition root, so it is tested.
 */
export function shiftRefAtOf(
  shifts: Pick<ShiftCashupRepo, 'findShiftAt'>,
): (scope: ReturnScope, at: string) => string | null {
  return (scope, at) => shifts.findShiftAt(scope, at);
}

/**
 * The open shift, or null. A failed shift read must not roll back a payout whose drawer already
 * opened: it counts as no shift (logged), like the no-shift case. Only the INSERT stays fail-closed.
 */
function readShiftRef(deps: ExecutionEnqueueDeps, scope: ReturnScope): string | null {
  try {
    return deps.openShiftRef(scope);
  } catch {
    deps.logger.warn({}, 'returns:execution_shift_read_failed');
    return null;
  }
}

/**
 * The shift that was open when the payout was claimed, or null. Read only when no shift is open
 * now; a failed read counts as no shift (logged), like `readShiftRef`.
 */
function readClaimShiftRef(
  deps: ExecutionEnqueueDeps,
  scope: ReturnScope,
  claimedAt: string,
): string | null {
  try {
    return deps.shiftRefAt(scope, claimedAt);
  } catch {
    deps.logger.warn({}, 'returns:execution_claim_shift_read_failed');
    return null;
  }
}

export function createExecutionEnqueuer(deps: ExecutionEnqueueDeps): EnqueueExecutions {
  return (entry, method, paidAt, claimedAt) => {
    const allocations = readAllocations(entry.requestBodyJson);
    if (allocations.length === 0) return;
    if (entry.returnRef === null) {
      deps.logger.warn({ return_id: entry.returnId }, 'returns:execution_no_return_ref');
      return;
    }
    const shiftRef =
      readShiftRef(deps, entry.scope) ?? readClaimShiftRef(deps, entry.scope, claimedAt);
    if (shiftRef === null) {
      deps.logger.warn({ return_id: entry.returnId }, 'returns:execution_no_open_shift');
      return;
    }
    const { returnRef } = entry;
    const rows: NewExecution[] = allocations.map((allocation) => {
      const executionRef = deps.newExecutionRef();
      const externalId = `${EXECUTION_EXTERNAL_ID_PREFIX}${executionRef}`;
      return {
        executionId: executionRef,
        returnId: entry.returnId,
        serverSaleRef: entry.serverSaleRef,
        returnRef,
        allocationRef: allocation.allocationRef,
        externalId,
        requestBodyJson: buildExecutionBody({
          externalId,
          executionRef,
          allocationRef: allocation.allocationRef,
          amount: allocation.amount,
          method: evidenceMethodOf(method),
          paidAt,
          shiftRef,
        }),
        now: paidAt,
      };
    });
    deps.repo.enqueue(rows);
  };
}
