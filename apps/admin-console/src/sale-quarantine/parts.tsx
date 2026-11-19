/**
 * RT-1312 shared pieces of the sale quarantine screens: the state badge (the text carries the
 * meaning, the colour only reinforces it), the summary figure, and the confirmation modal both
 * writes (repair, write-off) use.
 */
import { ConfirmModal } from "@/components/ConfirmModal";
import { type MessageKey, Money, useT } from "@/i18n";
import { Machine } from "@/sale-sync/parts";
import { quarantineStateView } from "./quarantineLogic";

export function QuarantineStateBadge({ code }: Readonly<{ code: string }>): React.JSX.Element {
  const t = useT();
  const view = quarantineStateView(code);
  return <span className={view.badge ? `badge ${view.badge}` : "badge"}>{t(view.labelKey)}</span>;
}

/** The till's total as an exact decimal string; "not recorded" when the stored sale has none. */
export function TillTotal({
  total,
  currency,
}: Readonly<{ total: string | null; currency: string | null }>): React.JSX.Element {
  const t = useT();
  if (total === null) return <span className="muted">{t("saleQuarantine.value.notRecorded")}</span>;
  return <Money value={total} currency={currency ?? undefined} />;
}

/** The catalog words of one write's confirmation; the commit shows its `committing` word while sending. */
export interface WriteDialogWords {
  title: MessageKey;
  /** The consequence sentence; it takes the item's source reference as `{ref}`. */
  consequence: MessageKey;
  commit: MessageKey;
  committing: MessageKey;
  cancel: MessageKey;
  done: MessageKey;
}

/**
 * The confirmation modal of a quarantine write: safe default focus, one commit, the way out reads
 * Done once the server has answered. The write itself (and what may be sent again) is the caller's.
 */
export function WriteConfirm({
  words,
  reference,
  flow,
  finished,
  canCommit,
  onClose,
  children,
}: Readonly<{
  words: WriteDialogWords;
  /** The source reference the operator knows the sale by. */
  reference: string;
  /** The write in flight: its state and the one send, called only from the commit button. */
  flow: { pending: boolean; commit: () => Promise<void> };
  finished: boolean;
  canCommit: boolean;
  onClose: (finished: boolean) => void;
  children?: React.ReactNode;
}>): React.JSX.Element {
  const { pending } = flow;
  const t = useT();
  return (
    <ConfirmModal
      title={t(words.title)}
      finished={finished}
      pending={pending}
      cancelLabel={t(words.cancel)}
      doneLabel={t(words.done)}
      commit={{
        label: t(pending ? words.committing : words.commit),
        disabled: !canCommit,
        busy: pending,
        onClick: () => void flow.commit(),
      }}
      onClose={onClose}
    >
      <p className="confirm-modal__consequence">
        {t.rich(words.consequence, { ref: <Machine value={reference} /> })}
      </p>
      {children}
    </ConfirmModal>
  );
}
