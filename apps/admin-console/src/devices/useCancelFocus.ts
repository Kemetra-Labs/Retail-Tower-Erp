/**
 * RT-372 — Where focus goes when the cancel confirm closes. Keeping the code
 * returns to that row's Cancel button; a cancel that went through (the row may be
 * about to leave the list) returns to the table's region, a stable element, so
 * keyboard focus never falls to the page body. A cancel that handed over to a new
 * issue (RT-1316) leaves focus alone: the issue drawer has just taken it, and
 * pulling it back behind a modal would strand keyboard and screen-reader users.
 */
import { type RefObject, useEffect, useRef } from "react";
import type { CancelFlow } from "./useCancelFlow";

export function useCancelFocus(
  cancel: CancelFlow,
  region: RefObject<HTMLElement | null>,
): CancelFlow {
  const kept = useRef<string | null>(null);
  const wasConfirming = useRef<string | null>(null);
  const confirmingId = cancel.confirming?.pairingCodeId ?? null;
  const handedOff = cancel.handedOff;

  useEffect(() => {
    const closedId = confirmingId === null ? wasConfirming.current : null;
    wasConfirming.current = confirmingId;
    if (closedId === null || handedOff) {
      kept.current = null;
      return;
    }
    const button =
      kept.current === closedId
        ? region.current?.querySelector<HTMLElement>(`[data-cancel-for="${closedId}"]`)
        : null;
    kept.current = null;
    (button ?? region.current)?.focus();
  }, [confirmingId, handedOff, region]);

  return {
    ...cancel,
    keep: () => {
      kept.current = confirmingId;
      cancel.keep();
    },
  };
}
