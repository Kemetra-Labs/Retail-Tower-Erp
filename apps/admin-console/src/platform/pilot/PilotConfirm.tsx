/**
 * RT-1329: the inline confirm step of the "POS pilot" page (UX-05.2: friction
 * follows consequence). It names the exact release or organization and the
 * consequence, focuses Cancel first (safe default) and holds one primary. Not
 * `ConfirmDelete`: neither action is a soft-delete an administrator restores.
 */
import { GatedButton } from "@/components/GatedButton";
import { type T, useT } from "@/i18n";
import { useEffect, useRef } from "react";

export interface PilotConfirmProps {
  /** The region's accessible name (already translated). */
  label: string;
  /** The question naming the target and its consequence (already rendered). */
  prompt: React.ReactNode;
  confirmLabel: string;
  tone: "primary" | "destructive";
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PilotConfirm(props: Readonly<PilotConfirmProps>): React.JSX.Element {
  const { label, prompt, confirmLabel, tone, pending, onConfirm, onCancel } = props;
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <section className="pos-pilot__confirm" aria-label={label}>
      <p className="pos-pilot__confirm-msg">{prompt}</p>
      <div className="pos-pilot__confirm-actions">
        <GatedButton
          type="button"
          className={tone === "primary" ? "btn-primary" : "btn-destructive"}
          onClick={onConfirm}
          busy={pending}
        >
          {confirmLabel}
        </GatedButton>
        <button
          ref={cancelRef}
          type="button"
          className="btn-ghost"
          onClick={onCancel}
          disabled={pending}
        >
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}

/** A write's result line: translated copy, its tone and the request id when sent. */
export interface PilotNotice {
  variant: "success" | "warning" | "danger" | "info";
  message: string;
  requestId?: string;
}

/** The outcomes every write shares: 403 not permitted, 429, and anything unexpected. */
export function commonNotice(t: T, outcome: { kind: string; requestId?: string }): PilotNotice {
  if (outcome.kind === "notPermitted") {
    return { variant: "danger", message: t("posPilot.notPermitted") };
  }
  if (outcome.kind === "rateLimited") {
    return { variant: "warning", message: t("posPilot.rateLimited") };
  }
  return { variant: "danger", message: t("posPilot.failed"), requestId: outcome.requestId };
}
