/**
 * RT-1441 (U2) — «حذف المتجر»: the dialog of the owner's guarded store deletion (RT-1437 A2). A real
 * modal (UX-11.9): Tab is trapped, Escape cancels, focus starts on the safe choice «إلغاء»
 * (UX-05.11) and returns to the opener. It shows the server's impact preview (the blockers each
 * linked to its fix, what changes, what does not, and that the delete is irreversible), and only
 * when nothing blocks it asks for the reason and the password again; it commits only with
 * `.btn-destructive`. A blocked store offers no commit and says why as persistent text (UX-11.11).
 * Every verdict, blocker and effect is the server's.
 */
import { Banner } from "@/components/Banner";
import { ConfirmModal } from "@/components/ConfirmModal";
import { FailureBanner } from "@/components/FailureBanner";
import { InlineError } from "@/components/InlineError";
import { TextArea } from "@/devices/RevokeFields";
import { useT } from "@/i18n";
import { type Read, type ReadError, useRefetchOnce } from "@/lib/server-read";
import type { StoreDeletionPreview } from "@/lib/store-deletion-queries";
import { useId } from "react";
import { DeletionBlockers, DeletionImpact } from "./StoreDeletionImpact";
import { reasonFieldProblem } from "./storeDeletionLogic";
import {
  type StoreDeletionFlow,
  useStoreDeletionFlow,
  useStoreDeletionPreview,
} from "./useStoreDeletion";
import "./store-deletion.css";

type Outcome = NonNullable<StoreDeletionFlow["outcome"]>;

function OutcomeBanner({
  outcome,
  requestId,
  retry,
  canRetry,
}: Readonly<{
  outcome: Outcome;
  requestId?: string;
  retry: () => void;
  /** An attempt is still held: a refusal that kept it (429) offers the resend too. */
  canRetry: boolean;
}>): React.JSX.Element | null {
  const t = useT();
  switch (outcome.kind) {
    case "deleted":
      return (
        <Banner
          variant="success"
          message={t(outcome.replay ? "storeDeletion.successReplay" : "storeDeletion.success")}
        />
      );
    case "stale":
      return <Banner variant="warning" message={t("storeDeletion.stale")} />;
    case "reauthRequired":
      return <Banner variant="warning" message={t("storeDeletion.reauthRequired")} />;
    case "blocked":
      return null; // the blockers render below, from the server's list
    case "rejected":
      return (
        <FailureBanner
          variant="danger"
          message={t(outcome.messageKey)}
          requestId={outcome.requestId ?? requestId}
          retry={canRetry ? { label: t("storeDeletion.retry"), onClick: retry } : undefined}
        />
      );
    case "retryable":
      return (
        <FailureBanner
          variant="warning"
          message={t("storeDeletion.retryable")}
          requestId={outcome.requestId}
          retry={{ label: t("storeDeletion.retry"), onClick: retry }}
        />
      );
    case "session":
      return <Banner variant="danger" message={t("storeDeletion.session")} />;
  }
}

function PreviewError({
  error,
  retry,
}: Readonly<{ error: ReadError; retry: () => void }>): React.JSX.Element {
  const t = useT();
  if (error.kind === "failed") {
    return (
      <FailureBanner
        variant="danger"
        message={t("storeDeletion.previewFailed")}
        requestId={error.requestId}
        retry={{ label: t("storeDeletion.retry"), onClick: retry }}
      />
    );
  }
  // A refusal reads as itself and offers no retry: asking again cannot change the answer.
  return (
    <FailureBanner
      variant="danger"
      message={t(
        error.kind === "forbidden"
          ? "storeDeletion.error.previewOwnerOnly"
          : "storeDeletion.error.previewNotAvailable",
      )}
      requestId={error.requestId}
    />
  );
}

/** The password re-entry (D2b): masked, never autofilled from this form, and the server judges it. */
function PasswordField({
  value,
  onChange,
}: Readonly<{ value: string; onChange: (value: string) => void }>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <label htmlFor={id}>{t("storeDeletion.password.label")}</label>
      <small id={helpId} className="device-quiet">
        {t("storeDeletion.password.help")}
      </small>
      <input
        id={id}
        className="input"
        type="password"
        autoComplete="current-password"
        dir="ltr"
        required
        value={value}
        aria-describedby={helpId}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ConfirmForm({ flow }: Readonly<{ flow: StoreDeletionFlow }>): React.JSX.Element {
  const t = useT();
  const reasonId = useId();
  return (
    <>
      <TextArea
        id={reasonId}
        label={t("storeDeletion.reason.label")}
        help={t("storeDeletion.reason.help")}
        value={flow.reason}
        problem={reasonFieldProblem(flow.reason)}
        required
        onChange={flow.setReason}
      />
      <PasswordField value={flow.password} onChange={flow.setPassword} />
      {flow.ready || flow.pending ? null : (
        <p className="device-quiet">
          <InlineError message={t("storeDeletion.needInputs")} />
        </p>
      )}
    </>
  );
}

export interface StoreDeletionDialogProps {
  storeId: string;
  /** The store's IANA zone for the times shown (RT-401). */
  timeZone?: string;
  /** `deleted`: the delete was recorded (the store is gone), not merely cancelled. */
  onClose: (deleted: boolean) => void;
}

/** Which of the preview's parts the dialog shows now, from the server's verdict and the last answer. */
function useDialogView(preview: Read<StoreDeletionPreview>, flow: StoreDeletionFlow) {
  const data = preview.data;
  const outcome = flow.outcome;
  const finished = outcome?.kind === "deleted";
  const blockedByAnswer = outcome?.kind === "blocked";
  const canDelete = data?.canDelete === true;
  return {
    data,
    finished,
    blockers: outcome?.kind === "blocked" ? outcome.blockers : (data?.blockers ?? []),
    showBlockers: data !== undefined && !finished && (!canDelete || blockedByAnswer),
    showForm: data !== undefined && canDelete && !finished && !blockedByAnswer,
  };
}

export function StoreDeletionDialog({
  storeId,
  timeZone,
  onClose,
}: Readonly<StoreDeletionDialogProps>): React.JSX.Element {
  const t = useT();
  const preview = useStoreDeletionPreview(storeId);
  const flow = useStoreDeletionFlow(storeId, preview);
  useRefetchOnce(flow.outcome?.kind === "blocked", preview.refetch);
  const view = useDialogView(preview, flow);

  return (
    <ConfirmModal
      title={t("storeDeletion.title")}
      finished={view.finished}
      pending={flow.pending}
      cancelLabel={t("storeDeletion.cancel")}
      doneLabel={t("storeDeletion.backToList")}
      commit={
        view.showForm
          ? {
              label: t(flow.pending ? "storeDeletion.committing" : "storeDeletion.commit"),
              disabled: !flow.ready,
              busy: flow.pending,
              onClick: () => void flow.commit(),
            }
          : null
      }
      onClose={onClose}
    >
      <p className="confirm-modal__consequence">{t("storeDeletion.consequence")}</p>
      <p className="store-deletion__irreversible">{t("storeDeletion.irreversible")}</p>
      <p className="device-quiet">{t("storeDeletion.suspendHint")}</p>
      {preview.isLoading ? (
        <output className="content__sub">
          <span className="spinner" aria-hidden="true" /> {t("storeDeletion.loading")}
        </output>
      ) : null}
      {preview.error ? <PreviewError error={preview.error} retry={preview.refetch} /> : null}
      {view.data && !view.finished ? <DeletionImpact data={view.data} timeZone={timeZone} /> : null}
      {view.showBlockers ? (
        <DeletionBlockers blockers={view.blockers} preview={view.data} storeId={storeId} />
      ) : null}
      {flow.outcome ? (
        <OutcomeBanner
          outcome={flow.outcome}
          requestId={flow.requestId}
          retry={() => void flow.retry()}
          canRetry={flow.canRetry}
        />
      ) : null}
      {view.showForm ? <ConfirmForm flow={flow} /> : null}
    </ConfirmModal>
  );
}
