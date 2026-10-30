import { parseFeatureFlags } from '../app/feature-flags.js';
import type { DatabaseHandle } from '../db/client.js';
import { createShiftCashupRepo } from '../shift-cashup/shift-cashup-repo.js';

/** The terminal a cash tender is for: the payment attempt's own scope. */
export interface CashShiftScope {
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly terminal_id: string;
}

/**
 * RT-998 — may cash be tendered on this terminal now?
 *
 * `shift_required` means main refuses the cash with `shift_not_open`: a cash
 * sale finalized with no open shift falls outside every shift window, so no
 * Expected Cash would include it (RT-276 c14691, owner decision c14719).
 */
export type CashShiftGate = (scope: CashShiftScope) => 'ok' | 'shift_required';

/**
 * Main-side authority for "does this cash tender have an open shift?" (RT-998).
 * The question is about the terminal, never the operator: it reads the open
 * shift of the attempt's tenant, branch and terminal, so a manager on a
 * terminal where a cashier opened the shift can tender cash, and a manager on
 * a terminal with no open shift cannot.
 *
 * With `POS_PULSE_FEATURE_SHIFT_CASHUP` off no shift can ever be opened, so the
 * gate allows (a gate that stayed on would block every cash sale). Both the flag
 * and the shift are read on every call. Synchronous, so a handler can run it
 * immediately before its write with no await in between.
 */
export function bindCashShiftGate(
  db: DatabaseHandle,
  isShiftCashupEnabled: () => boolean = () => parseFeatureFlags(process.env).shiftCashup,
): CashShiftGate {
  const repo = createShiftCashupRepo(db);
  return (scope) => {
    if (!isShiftCashupEnabled()) return 'ok';
    const open = repo.findOpenShift({
      tenantId: scope.tenant_id,
      branchId: scope.branch_id,
      terminalId: scope.terminal_id,
    });
    return open === null ? 'shift_required' : 'ok';
  };
}
