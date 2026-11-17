/**
 * The inline confirm of suspending a store, naming the store (owner decision 2026-10-13): shared by
 * the edit screen's «حالة المتجر» section (RT-400) and the detail page's danger zone (RT-1441), which
 * offers suspend first as the reversible alternative to deleting. The caller owns the request.
 */
import { GatedButton } from "@/components/GatedButton";
import { useT } from "@/i18n";

export function SuspendConfirm({
  storeName,
  busy,
  disabled = false,
  confirmPromptKey,
  onConfirm,
  onCancel,
}: Readonly<{
  storeName?: string;
  /** The suspend request is in flight. */
  busy: boolean;
  disabled?: boolean;
  /** The prompt that names the store (`{name}`); each screen says where to activate it again. */
  confirmPromptKey: "stores.status.confirmPrompt" | "storeDeletion.zone.suspendConfirm";
  onConfirm: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <section className="surface__confirm" aria-label={t("stores.status.confirmLabel")}>
      <p className="surface__confirm-msg">
        {t.rich(confirmPromptKey, { name: <bdi>{storeName}</bdi> })}
      </p>
      <div className="surface__confirm-actions">
        <GatedButton
          type="button"
          className="btn-destructive"
          onClick={onConfirm}
          busy={busy}
          disabled={disabled}
        >
          {t("stores.status.suspend")}
        </GatedButton>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}
