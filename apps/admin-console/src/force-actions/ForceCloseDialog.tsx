/**
 * RT-1440 (U1) — "Close without a count": the dialog of the owner's force close of a stuck shift
 * (RT-1437 A1). A real modal (UX-11.9): Tab is trapped, Escape cancels, focus starts on the safe
 * choice «إلغاء» (UX-05.11) and returns to the opener. It shows the server's impact preview (what
 * changes, what does not, and that it is irreversible), asks for the reason and one
 * acknowledgement, and commits only with `.btn-destructive`. Every verdict, blocker and effect is
 * the server's; a blocked shift offers no commit and says why as persistent text (UX-11.11).
 */
import { Banner } from "@/components/Banner";
import { ConfirmModal } from "@/components/ConfirmModal";
import { FailureBanner } from "@/components/FailureBanner";
import { ImpactFootnotes, ImpactList } from "@/components/ImpactList";
import { InlineError } from "@/components/InlineError";
import { TrustBadge } from "@/devices/DeviceParts";
import { TextArea } from "@/devices/RevokeFields";
import { DateTime, type MessageKey, Money, useT } from "@/i18n";
import { formatNumber } from "@/i18n/translate";
import type { ForceClosePreview } from "@/lib/force-action-queries";
import { type Read, type ReadError, useRefetchOnce } from "@/lib/server-read";
import { useId } from "react";
import { effectKeys, hasUnknownEffect, reasonProblem } from "./forceCloseLogic";
import { blockerKeys } from "./forceCloseOutcomes";
import { type ForceCloseFlow, useForceCloseFlow, useForceClosePreview } from "./useForceActions";
import "./force-actions.css";

function Fact({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="force-close__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Count({ value }: Readonly<{ value: number | null }>): React.JSX.Element {
  const t = useT();
  // null is unknown, never zero (a legacy shift has no received cash facts).
  return value === null ? (
    <>{t("forceActions.close.fact.unknown")}</>
  ) : (
    <bdi dir="ltr">{formatNumber(value)}</bdi>
  );
}

function Facts({
  preview,
  timeZone,
}: Readonly<{ preview: ForceClosePreview; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  const { shift, recorded } = preview;
  return (
    <dl className="force-close__facts">
      <Fact label={t("forceActions.close.fact.terminal")}>
        {shift.terminal.label ?? t("forceActions.openShifts.terminal.none")}{" "}
        <TrustBadge trustState={shift.terminal.trustState} />
      </Fact>
      <Fact label={t("forceActions.close.fact.cashier")}>
        {shift.cashier.displayName ?? t("forceActions.openShifts.cashier.none")}
      </Fact>
      <Fact label={t("forceActions.close.fact.opened")}>
        <bdi dir="ltr">
          <DateTime value={shift.openedAt} timeZone={timeZone} />
        </bdi>
      </Fact>
      <Fact label={t("forceActions.close.fact.float")}>
        {recorded.openingFloat === null ? (
          t("forceActions.close.fact.unknown")
        ) : (
          <Money value={recorded.openingFloat} currency={recorded.currencyCode ?? undefined} />
        )}
      </Fact>
      <Fact label={t("forceActions.close.fact.movements")}>
        <Count value={recorded.cashMovementCount} />
      </Fact>
      <Fact label={t("forceActions.close.fact.lastMovement")}>
        {recorded.lastCashMovementReceivedAt === null ? (
          t(
            recorded.cashMovementCount === null
              ? "forceActions.close.fact.unknown"
              : "forceActions.close.fact.none",
          )
        ) : (
          <bdi dir="ltr">
            <DateTime value={recorded.lastCashMovementReceivedAt} timeZone={timeZone} />
          </bdi>
        )}
      </Fact>
      <Fact label={t("forceActions.close.fact.sales")}>
        <Count value={recorded.saleCount} />
      </Fact>
      <Fact label={t("forceActions.close.fact.refunds")}>
        <Count value={recorded.refundExecutionCount} />
      </Fact>
    </dl>
  );
}

function EffectList({
  heading,
  list,
  codes,
}: Readonly<{
  heading: string;
  list: "willChange" | "willNotChange";
  codes: readonly string[];
}>): React.JSX.Element {
  return (
    <ImpactList
      className="force-close__effects"
      heading={heading}
      keys={effectKeys(list, codes)}
      unknownKey={hasUnknownEffect(list, codes) ? "forceActions.close.effect.unknown" : undefined}
    />
  );
}

const CAVEATS: Readonly<Record<string, MessageKey>> = {
  offline_facts_not_visible: "forceActions.close.caveat.offline_facts_not_visible",
  terminal_not_notified: "forceActions.close.caveat.terminal_not_notified",
};

/** One catalog key per distinct caveat; a code this build does not know reads as a generic limit. */
function caveatKeys(codes: readonly string[]): MessageKey[] {
  const keys = codes.map((c) =>
    Object.hasOwn(CAVEATS, c) ? CAVEATS[c] : ("forceActions.close.caveat.unknown" as const),
  );
  return [...new Set(keys)];
}

function Blockers({ blockers }: Readonly<{ blockers: readonly string[] }>): React.JSX.Element {
  const t = useT();
  const keys = blockerKeys(blockers);
  return (
    <section className="force-close__blocked" aria-label={t("forceActions.close.blockedIntro")}>
      <Banner variant="danger" message={t("forceActions.close.blockedIntro")} />
      <ul className="force-close__blockers">
        {(keys.length > 0 ? keys : (["forceActions.close.blocker.unknown"] as const)).map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </section>
  );
}

function Outcome({
  outcome,
  requestId,
  retry,
  canRetry,
}: Readonly<{
  outcome: NonNullable<ReturnType<typeof useForceCloseFlow>["outcome"]>;
  requestId?: string;
  retry: () => void;
  /** An attempt is still held: a refusal that kept it (429) offers the resend too. */
  canRetry: boolean;
}>): React.JSX.Element | null {
  const t = useT();
  switch (outcome.kind) {
    case "closed":
      return (
        <Banner
          variant="success"
          message={t(
            outcome.replay ? "forceActions.close.successReplay" : "forceActions.close.success",
          )}
        />
      );
    case "stale":
      return <Banner variant="warning" message={t("forceActions.close.stale")} />;
    case "blocked":
      return null; // the blockers render below, from the server's list
    case "settled":
      return (
        <Banner
          variant="info"
          message={t(`forceActions.close.settled.${outcome.by}`)}
          requestId={outcome.requestId}
        />
      );
    case "rejected":
      return (
        <FailureBanner
          variant="danger"
          message={t(outcome.messageKey)}
          requestId={outcome.requestId ?? requestId}
          retry={canRetry ? { label: t("forceActions.close.retry"), onClick: retry } : undefined}
        />
      );
    case "retryable":
      return (
        <FailureBanner
          variant="warning"
          message={t("forceActions.close.retryable")}
          requestId={outcome.requestId}
          retry={{ label: t("forceActions.close.retry"), onClick: retry }}
        />
      );
    case "session":
      return <Banner variant="danger" message={t("forceActions.close.session")} />;
  }
}

export interface ForceCloseDialogProps {
  shiftId: string;
  /** The store's IANA zone for the times shown (RT-401). */
  timeZone?: string;
  /** `recorded`: the close was recorded (the shift is gone from the list), not merely cancelled. */
  onClose: (recorded: boolean) => void;
}

function Preview({
  data,
  timeZone,
}: Readonly<{ data: ForceClosePreview; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <Facts preview={data} timeZone={timeZone} />
      <EffectList
        heading={t("forceActions.close.heading.willChange")}
        list="willChange"
        codes={data.effects.willChange}
      />
      <EffectList
        heading={t("forceActions.close.heading.willNotChange")}
        list="willNotChange"
        codes={data.effects.willNotChange}
      />
      <p className="force-close__unaccounted">{t("forceActions.close.drawerUnaccounted")}</p>
      <ImpactFootnotes
        caveats={caveatKeys(data.caveats)}
        snapshotKey="forceActions.close.snapshot"
        evaluatedAt={data.evaluatedAt}
        timeZone={timeZone}
      />
    </>
  );
}

function PreviewError({
  error,
  retry,
}: Readonly<{ error: ReadError; retry: () => void }>): React.JSX.Element {
  const t = useT();
  const notAvailable = error.kind === "not-available";
  return (
    <FailureBanner
      variant="danger"
      message={t(
        notAvailable ? "forceActions.close.error.notAvailable" : "forceActions.close.previewFailed",
      )}
      requestId={error.requestId}
      retry={notAvailable ? undefined : { label: t("forceActions.close.retry"), onClick: retry }}
    />
  );
}

function ReasonForm({ flow }: Readonly<{ flow: ForceCloseFlow }>): React.JSX.Element {
  const t = useT();
  const reasonId = useId();
  const problem = flow.reason === "" ? undefined : (reasonProblem(flow.reason) ?? undefined);
  return (
    <>
      <TextArea
        id={reasonId}
        label={t("forceActions.close.reason.label")}
        help={t("forceActions.close.reason.help")}
        value={flow.reason}
        problem={problem}
        required
        onChange={flow.setReason}
      />
      <div className="field">
        <label className="drawer__radio">
          <input
            type="checkbox"
            checked={flow.acknowledged}
            onChange={(e) => flow.setAcknowledged(e.target.checked)}
          />
          {t("forceActions.close.acknowledge")}
        </label>
      </div>
      {flow.canCommit || flow.pending ? null : (
        <p className="device-quiet">
          <InlineError message={t("forceActions.close.needInputs")} />
        </p>
      )}
    </>
  );
}

/** Which of the preview's parts the dialog shows now, from the server's verdict and the last answer. */
function useCloseView(preview: Read<ForceClosePreview>, flow: ForceCloseFlow) {
  const outcome = flow.outcome;
  const data = preview.data;
  const finished = outcome?.kind === "closed" || outcome?.kind === "settled";
  const eligible = data?.shift.verdict.eligible === true;
  const blockedByAnswer = outcome?.kind === "blocked";
  return {
    data,
    finished,
    blockers: outcome?.kind === "blocked" ? outcome.blockers : (data?.shift.verdict.blockers ?? []),
    showBlockers: data !== undefined && !finished && (!eligible || blockedByAnswer),
    showForm: data !== undefined && eligible && !finished,
  };
}

export function ForceCloseDialog({
  shiftId,
  timeZone,
  onClose,
}: Readonly<ForceCloseDialogProps>): React.JSX.Element {
  const t = useT();
  const preview: Read<ForceClosePreview> = useForceClosePreview(shiftId);
  const flow = useForceCloseFlow(shiftId, preview);
  useRefetchOnce(flow.outcome?.kind === "blocked", preview.refetch);
  const view = useCloseView(preview, flow);
  const commitKey = flow.pending ? "forceActions.close.committing" : "forceActions.close.commit";

  return (
    <ConfirmModal
      title={t("forceActions.close.title")}
      finished={view.finished}
      pending={flow.pending}
      cancelLabel={t("forceActions.close.cancel")}
      doneLabel={t("forceActions.close.done")}
      commit={
        view.showForm
          ? {
              label: t(commitKey),
              disabled: !flow.ready,
              busy: flow.pending,
              onClick: () => void flow.commit(),
            }
          : null
      }
      onClose={onClose}
    >
      <p className="confirm-modal__consequence">{t("forceActions.close.consequence")}</p>
      {preview.isLoading ? (
        <output className="content__sub">
          <span className="spinner" aria-hidden="true" /> {t("forceActions.close.loading")}
        </output>
      ) : null}
      {preview.error ? <PreviewError error={preview.error} retry={preview.refetch} /> : null}
      {view.data && !view.finished ? <Preview data={view.data} timeZone={timeZone} /> : null}
      {view.showBlockers ? <Blockers blockers={view.blockers} /> : null}
      {flow.outcome ? (
        <Outcome
          outcome={flow.outcome}
          requestId={flow.requestId}
          retry={() => void flow.retry()}
          canRetry={flow.canRetry}
        />
      ) : null}
      {view.showForm ? <ReasonForm flow={flow} /> : null}
    </ConfirmModal>
  );
}
