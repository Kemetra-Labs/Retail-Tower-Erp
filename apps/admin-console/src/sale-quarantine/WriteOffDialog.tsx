/**
 * RT-1312 — "Close without recording": the dialog of the write-off of one quarantined sale
 * (`consoleWriteOffQuarantinedSale`, decision C3). A real modal (UX-11.9): Tab is trapped, Escape
 * cancels, focus starts on the safe choice «Cancel» (UX-05.11). It names the item, says what the
 * write-off does and that it cannot be undone, and asks for the reason (required, at most 500
 * characters). Only the destructive commit sends the one POST. It is never sent on its own, never
 * retried by the client, and there is no bulk close.
 *
 * The outcome shown is the server's: a 200 shows the item as it returned it; a 5xx or a lost
 * response is "not confirmed" (the server may have acted), and the next confirmation with the same
 * note replays the same Idempotency-Key. A 409 or a 404 leaves nothing to commit.
 */
import { Banner, type BannerVariant } from "@/components/Banner";
import { InlineError } from "@/components/InlineError";
import { TextArea } from "@/devices/RevokeFields";
import { type T, useT } from "@/i18n";
import type { SaleScope } from "@/sales/useSales";
import { useId } from "react";
import { WriteConfirm, type WriteDialogWords } from "./parts";
import { type WriteOffOutcome, writeOffNoteProblem } from "./quarantineLogic";
import { type WriteOffState, isFinishedOutcome, useWriteOff } from "./useQuarantine";

const VARIANTS: Record<WriteOffOutcome["kind"], BannerVariant> = {
  "written-off": "success",
  conflict: "warning",
  "key-conflict": "warning",
  "rate-limited": "warning",
  unconfirmed: "warning",
  "not-found": "danger",
  forbidden: "danger",
  session: "danger",
  rejected: "danger",
};

const WORDS: WriteDialogWords = {
  title: "saleQuarantine.writeOff.dialogTitle",
  consequence: "saleQuarantine.writeOff.consequence",
  commit: "saleQuarantine.writeOff.commit",
  committing: "saleQuarantine.writeOff.committing",
  cancel: "saleQuarantine.writeOff.cancel",
  done: "saleQuarantine.writeOff.done",
};

function outcomeMessage(t: T, outcome: WriteOffOutcome): string {
  if (outcome.kind === "written-off") return t("saleQuarantine.writeOff.success");
  if (outcome.kind === "rate-limited" && outcome.retryAfter) {
    return t(outcome.messageKey, { count: outcome.retryAfter });
  }
  return t(outcome.messageKey);
}

function OutcomeBanner({ outcome }: Readonly<{ outcome: WriteOffOutcome }>): React.JSX.Element {
  const t = useT();
  return (
    <Banner
      variant={VARIANTS[outcome.kind]}
      message={outcomeMessage(t, outcome)}
      requestId={outcome.kind === "written-off" ? undefined : outcome.requestId}
    />
  );
}

function NoteForm({ flow }: Readonly<{ flow: WriteOffState }>): React.JSX.Element {
  const t = useT();
  const noteId = useId();
  const problem = flow.note === "" ? undefined : (writeOffNoteProblem(flow.note) ?? undefined);
  return (
    <>
      <TextArea
        id={noteId}
        label={t("saleQuarantine.writeOff.note.label")}
        help={t("saleQuarantine.writeOff.note.help")}
        value={flow.note}
        problem={problem}
        required
        onChange={flow.setNote}
      />
      {writeOffNoteProblem(flow.note) === null || flow.pending ? null : (
        <p className="device-quiet">
          <InlineError message={t("saleQuarantine.writeOff.needNote")} />
        </p>
      )}
    </>
  );
}

export function WriteOffDialog({
  scope,
  quarantineRef,
  reference,
  onClose,
}: Readonly<{
  scope: SaleScope;
  quarantineRef: string;
  /** The source reference the operator knows the sale by. */
  reference: string;
  /** `recorded`: the write-off (or a conflict) ended the item's open state, not merely cancelled. */
  onClose: (finished: boolean) => void;
}>): React.JSX.Element {
  const flow = useWriteOff({ scope, quarantineRef });
  const finished = isFinishedOutcome(flow.outcome);
  return (
    <WriteConfirm
      words={WORDS}
      reference={reference}
      flow={flow}
      finished={finished}
      canCommit={!flow.pending && writeOffNoteProblem(flow.note) === null}
      onClose={onClose}
    >
      {flow.outcome ? <OutcomeBanner outcome={flow.outcome} /> : null}
      {finished ? null : <NoteForm flow={flow} />}
    </WriteConfirm>
  );
}
