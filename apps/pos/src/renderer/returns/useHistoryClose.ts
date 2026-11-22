/**
 * RT-1498 close slice — closing an unresolved return as "not recorded", from the journal: which row's
 * approval sheet is open, and the sale of the last close main recorded (for the notice above the list).
 * The same shape as handing a return to support (`useHistoryEscalate`): `done` is set only once main
 * answered `closed`. The renderer never decides the outcome.
 */
export {
  useHistoryEscalate as useHistoryClose,
  type HistoryEscalate as HistoryClose,
} from './useHistoryEscalate.js';
