/**
 * The public surface of `pos-shifts` (RT-1453): the only file other api modules import (besides
 * `pos-shifts.module.ts`). Everything else in this directory is internal. Add an export here
 * when another module needs it; a port that touches the database takes the caller's `PoolClient`.
 * `tools/module-boundaries` enforces this.
 */
export { countStoreOpenShifts, readStoreOpenShifts } from "./open-shifts";
export { ShiftCashUpError } from "./shift-cash-up.errors";
export type { ShiftWriteResult } from "./shift-cash-up.service";
export { previewFingerprint, readForceCloseFacts } from "./shift-force-close.facts";
export type { ForceCloseFacts } from "./shift-force-close.facts";
export { ShiftForceCloseRepository, stuckBlockers } from "./shift-force-close.repository";
export type { StoreShiftRow, StuckVerdict } from "./shift-force-close.repository";
export { STUCK_THRESHOLD_MINUTES, ShiftForceCloseService } from "./shift-force-close.service";
export type { ConsoleForceClosedShiftProjection } from "./shift-force-close.service";
export { formatMoney } from "./shift-money";
