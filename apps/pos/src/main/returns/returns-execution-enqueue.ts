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
 *   • nothing, with a warning, when the terminal has no open shift: the contract requires
 *     `evidence.shiftRef` and none is invented (owed decision on RT-1543);
 *   • nothing, with a warning, when the journal row has no server `returnRef` (cannot happen for a
 *     confirmed return).
 */
import type { ReturnPayoutMethod } from '../../shared/returns/types.js';
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
  /** A fresh `executionRef` (UUIDv7). */
  readonly newExecutionRef: () => string;
  readonly logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

/** Enqueue the executions of `entry`, paid out by `method` at `paidAt` (the commit's own stamp). */
export type EnqueueExecutions = (
  entry: JournalEntry,
  method: ReturnPayoutMethod,
  paidAt: string,
) => void;

export function createExecutionEnqueuer(deps: ExecutionEnqueueDeps): EnqueueExecutions {
  return (entry, method, paidAt) => {
    const allocations = readAllocations(entry.requestBodyJson);
    if (allocations.length === 0) return;
    if (entry.returnRef === null) {
      deps.logger.warn({ return_id: entry.returnId }, 'returns:execution_no_return_ref');
      return;
    }
    const shiftRef = deps.openShiftRef(entry.scope);
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
