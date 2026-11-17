/**
 * The modal of the owner's guarded force actions (RT-1440 close-without-a-count, RT-1441 store
 * deletion): a real modal (UX-11.9), not a drawer. Tab is trapped, Escape cancels, focus starts on
 * the safe choice «Cancel» (UX-05.11) and returns to the opener on close (UX-11.8). The commit button
 * is `.btn-destructive` and appears only when the caller offers one; when the action is recorded
 * (`finished`) it leaves, focus stays inside the modal on the way out, and the same button reads as
 * the way out («Done»). Extracted from the RT-1440 dialog so the two do not each copy it.
 */
import { GatedButton } from "@/components/GatedButton";
import { useEffect, useId, useRef } from "react";
import "./confirm-modal.css";

const FOCUSABLE =
  "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])";

/** Tab and Shift+Tab cycle inside the panel (aria-modal is honest, UX-11.9). */
function trapTab(e: React.KeyboardEvent<HTMLDialogElement>, panel: HTMLElement): void {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null,
  );
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const atEdge = e.shiftKey ? document.activeElement === first : document.activeElement === last;
  if (!atEdge) return;
  e.preventDefault();
  (e.shiftKey ? last : first).focus();
}

/** Focus starts on the safe choice and returns to the opener on close (UX-05.11, UX-11.8). */
function useSafeFocus(target: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    target.current?.focus();
    return () => opener?.focus?.();
  }, [target]);
}

export interface ConfirmModalProps {
  title: string;
  /** The action is recorded: the commit is gone and the cancel button reads as `doneLabel`. */
  finished: boolean;
  /** A send is in flight: Escape and the cancel button wait for it. */
  pending: boolean;
  cancelLabel: string;
  doneLabel: string;
  /** The commit button; null when there is nothing to commit (loading, blocked, finished). */
  commit: { label: string; disabled: boolean; busy: boolean; onClick: () => void } | null;
  /** `finished`: the action was recorded, not merely cancelled. */
  onClose: (finished: boolean) => void;
  children: React.ReactNode;
}

export function ConfirmModal({
  title,
  finished,
  pending,
  cancelLabel,
  doneLabel,
  commit,
  onClose,
  children,
}: Readonly<ConfirmModalProps>): React.JSX.Element {
  const titleId = useId();
  const panelRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useSafeFocus(cancelRef);

  // The commit button leaves when the action is recorded: keep focus inside the modal, on the way out.
  useEffect(() => {
    if (finished && !pending) cancelRef.current?.focus();
  }, [finished, pending]);

  // A control that left or went disabled while focused (the commit after a refusal) must not strand
  // focus outside the keyboard handling: it falls back to the safe choice.
  useEffect(() => {
    const active = document.activeElement;
    const stranded =
      !panelRef.current?.contains(active) ||
      (active instanceof HTMLButtonElement && active.disabled);
    if (stranded) cancelRef.current?.focus();
  });

  function onKeyDown(e: React.KeyboardEvent<HTMLDialogElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!pending) onClose(finished);
    } else if (e.key === "Tab" && panelRef.current) {
      trapTab(e, panelRef.current);
    }
  }

  return (
    <div className="confirm-modal-scrim">
      <dialog
        ref={panelRef}
        open
        className="confirm-modal"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="confirm-modal__title">
          {title}
        </h2>
        {children}
        <div className="confirm-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn-secondary"
            onClick={() => onClose(finished)}
            disabled={pending}
          >
            {finished ? doneLabel : cancelLabel}
          </button>
          {commit && !finished ? (
            <GatedButton
              type="button"
              className="btn-destructive"
              disabled={commit.disabled}
              busy={commit.busy}
              onClick={commit.onClick}
            >
              {commit.label}
            </GatedButton>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}
