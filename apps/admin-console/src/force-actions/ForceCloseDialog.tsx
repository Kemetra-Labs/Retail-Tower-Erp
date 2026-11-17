/**
 * RT-1440 (U1) — "Close without a count": the dialog of the owner's force close of a stuck shift
 * (RT-1437 A1). A real modal (UX-11.9): Tab is trapped, Escape cancels, focus starts on the safe
 * choice «إلغاء» (UX-05.11) and returns to the opener. It shows the server's impact preview (what
 * changes, what does not, and that it is irreversible), asks for the reason and one
 * acknowledgement, and commits only with `.btn-destructive`. Every verdict, blocker and effect is
 * the server's; a blocked shift offers no commit and says why as persistent text (UX-11.11).
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { TrustBadge } from "@/devices/DeviceParts";
import { TextArea } from "@/devices/RevokeFields";
import { DateTime, type MessageKey, Money, useT } from "@/i18n";
import { formatNumber } from "@/i18n/translate";
import type { ForceClosePreview } from "@/lib/force-action-queries";
import { useEffect, useId, useRef } from "react";
import { effectKeys, hasUnknownEffect, reasonProblem } from "./forceCloseLogic";
import { type ForceCloseOutcome, blockerKeys } from "./forceCloseOutcomes";
import {
  type ForceCloseFlow,
  type Read,
  type ReadError,
  useForceCloseFlow,
  useForceClosePreview,
} from "./useForceActions";
import "./force-actions.css";

const FOCUSABLE =
  "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])";

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
  const t = useT();
  return (
    <section className="force-close__effects">
      <h3>{heading}</h3>
      <ul>
        {effectKeys(list, codes).map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
        {hasUnknownEffect(list, codes) ? <li>{t("forceActions.close.effect.unknown")}</li> : null}
      </ul>
    </section>
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
}: Readonly<{
  outcome: NonNullable<ReturnType<typeof useForceCloseFlow>["outcome"]>;
  requestId?: string;
  retry: () => void;
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
        <Banner
          variant="danger"
          message={t(outcome.messageKey)}
          requestId={outcome.requestId ?? requestId}
        />
      );
    case "retryable":
      return (
        <Banner
          variant="warning"
          message={t("forceActions.close.retryable")}
          requestId={outcome.requestId}
          action={
            <button type="button" className="btn-secondary" onClick={retry}>
              {t("forceActions.close.retry")}
            </button>
          }
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
  onClose: () => void;
}

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

/** A blocked answer shows the server's verdict again: read the preview once more per answer. */
function useRefetchOnBlocked(outcome: ForceCloseOutcome | null, refetch: () => void): void {
  const done = useRef(false);
  const blocked = outcome?.kind === "blocked";
  useEffect(() => {
    if (blocked && !done.current) refetch();
    done.current = blocked;
  }, [blocked, refetch]);
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
      <ul className="force-close__caveats">
        {caveatKeys(data.caveats).map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <p className="device-quiet">
        {t.rich("forceActions.close.snapshot", {
          time: (
            <bdi dir="ltr">
              <DateTime value={data.evaluatedAt} timeZone={timeZone} />
            </bdi>
          ),
        })}
      </p>
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
    <Banner
      variant="danger"
      message={t(
        notAvailable ? "forceActions.close.error.notAvailable" : "forceActions.close.previewFailed",
      )}
      requestId={error.requestId}
      action={
        notAvailable ? undefined : (
          <button type="button" className="btn-secondary" onClick={retry}>
            {t("forceActions.close.retry")}
          </button>
        )
      }
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

interface ActionsProps {
  flow: ForceCloseFlow;
  finished: boolean;
  showForm: boolean;
  cancelRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

function Actions({
  flow,
  finished,
  showForm,
  cancelRef,
  onClose,
}: Readonly<ActionsProps>): React.JSX.Element {
  const t = useT();
  return (
    <div className="force-close__actions">
      <button
        ref={cancelRef}
        type="button"
        className="btn-secondary"
        onClick={onClose}
        disabled={flow.pending}
      >
        {t(finished ? "forceActions.close.done" : "forceActions.close.cancel")}
      </button>
      {finished || !showForm ? null : (
        <GatedButton
          type="button"
          className="btn-destructive"
          disabled={!flow.ready}
          busy={flow.pending}
          onClick={() => void flow.commit()}
        >
          {t(flow.pending ? "forceActions.close.committing" : "forceActions.close.commit")}
        </GatedButton>
      )}
    </div>
  );
}

export function ForceCloseDialog({
  shiftId,
  timeZone,
  onClose,
}: Readonly<ForceCloseDialogProps>): React.JSX.Element {
  const t = useT();
  const titleId = useId();
  const preview: Read<ForceClosePreview> = useForceClosePreview(shiftId);
  const flow = useForceCloseFlow(shiftId, preview);
  const panelRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useSafeFocus(cancelRef);
  useRefetchOnBlocked(flow.outcome, preview.refetch);

  const finished = flow.outcome?.kind === "closed" || flow.outcome?.kind === "settled";
  // The commit button leaves when the close is recorded: keep focus inside the modal, on Done (UX-11.8).
  useEffect(() => {
    if (finished) cancelRef.current?.focus();
  }, [finished]);
  const data = preview.data;
  const eligible = data?.shift.verdict.eligible === true;
  const blockers =
    flow.outcome?.kind === "blocked" ? flow.outcome.blockers : (data?.shift.verdict.blockers ?? []);
  const showForm = data !== undefined && eligible && !finished;

  function onKeyDown(e: React.KeyboardEvent<HTMLDialogElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!flow.pending) onClose();
    } else if (e.key === "Tab" && panelRef.current) {
      trapTab(e, panelRef.current);
    }
  }

  return (
    <div className="force-close-scrim">
      <dialog
        ref={panelRef}
        open
        className="force-close"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="force-close__title">
          {t("forceActions.close.title")}
        </h2>
        <p className="force-close__consequence">{t("forceActions.close.consequence")}</p>
        {preview.isLoading ? (
          <output className="content__sub">
            <span className="spinner" aria-hidden="true" /> {t("forceActions.close.loading")}
          </output>
        ) : null}
        {preview.error ? <PreviewError error={preview.error} retry={preview.refetch} /> : null}
        {data && !finished ? <Preview data={data} timeZone={timeZone} /> : null}
        {data !== undefined && !finished && (!eligible || flow.outcome?.kind === "blocked") ? (
          <Blockers blockers={blockers} />
        ) : null}
        {flow.outcome ? (
          <Outcome
            outcome={flow.outcome}
            requestId={flow.requestId}
            retry={() => void flow.commit()}
          />
        ) : null}
        {showForm ? <ReasonForm flow={flow} /> : null}
        <Actions
          flow={flow}
          finished={finished}
          showForm={showForm}
          cancelRef={cancelRef}
          onClose={onClose}
        />
      </dialog>
    </div>
  );
}
