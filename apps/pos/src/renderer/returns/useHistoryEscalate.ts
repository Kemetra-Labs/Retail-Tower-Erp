import { useCallback, useState } from 'react';

import type { ReturnJournalView } from '../../shared/returns/types.js';

/**
 * RT-1498 S4/S5 — handing an unresolved return to support, from the journal: which row's approval
 * sheet is open, and the sale of the last escalation main recorded (for the notice above the list).
 * The renderer never decides the outcome: `done` is set only once main answered `escalated`.
 */
export interface HistoryEscalate {
  /** The row whose approval sheet is open; null when none is. */
  readonly target: ReturnJournalView | null;
  readonly open: (row: ReturnJournalView) => void;
  readonly close: () => void;
  /** The sale of the last return main handed to support; null before any. */
  readonly done: { readonly saleNumber: string } | null;
  /** Main recorded the disposition for `row`: close the sheet and announce it. */
  readonly record: (row: ReturnJournalView) => void;
}

export function useHistoryEscalate(): HistoryEscalate {
  const [target, setTarget] = useState<ReturnJournalView | null>(null);
  const [done, setDone] = useState<{ readonly saleNumber: string } | null>(null);

  const open = useCallback((row: ReturnJournalView) => {
    setDone(null);
    setTarget(row);
  }, []);
  const close = useCallback(() => {
    setTarget(null);
  }, []);
  const record = useCallback((row: ReturnJournalView) => {
    setTarget(null);
    setDone({ saleNumber: row.saleNumber });
  }, []);

  return { target, open, close, done, record };
}
