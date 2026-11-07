import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { DateTime, type MessageKey, useT } from "@/i18n";
import {
  type ReviewQueueItem,
  identifierTypeKey,
  resolutionActionKey,
  resolutionStatusKey,
} from "@/lib/unknown-items-queries";
/**
 * SF-4a-2 — inspect drawer (T007). Reuses the shared Drawer (right-side panel,
 * focus-trapped, Escape closes) to render the `ReviewQueueItem` projection
 * read-only. It renders ONLY ReviewQueueItem fields — it MUST NOT reference
 * `sale_context` (that field lives on `UnknownItem`, not the review projection;
 * FR-007 / FR-4a-004).
 *
 * For a `pending` item it offers Link to a product (RT-767), Create product
 * (RT-724) and Dismiss, each of which swaps the action area to its own step
 * (picker + confirm / form / confirm); a `dismissed`
 * item offers Reopen (RT-724). The actions are offered by lifecycle state, not
 * by role (VG-5): a store-scoped actor's reopen gets the backend's 403, shown
 * as the tenant-wide-authority banner. Each action owns its inline error; this
 * surface owns the panel + the read-only detail.
 * RT-1018 (v4.0): the drawer opens with the Ink header (title, tenant scope
 * line, close); the status reads as a pill, its text first. Actions, steps and
 * errors are unchanged.
 * RT-1117: each action carries its one-line description under it.
 * RT-1234: a step swap unmounts the button that was clicked, which would drop
 * focus to <body> outside the dialog; focus moves into the new step instead.
 * RT-399: enum fields render their localized labels (never the raw code), ids
 * stay LTR-isolated, and the instants render as operational times.
 */
import { useEffect, useId, useRef, useState } from "react";
import { UnknownItemCreateProduct } from "./UnknownItemCreateProduct";
import { UnknownItemDismiss } from "./UnknownItemDismiss";
import { UnknownItemErrorBanner } from "./UnknownItemErrorBanner";
import { UnknownItemLinkProduct } from "./UnknownItemLinkProduct";
import { useUnknownItemInspect, useUnknownItemReopen } from "./useUnknownItemQueries";
import "./unknown-items.css";

export interface UnknownItemInspectDrawerProps {
  id: string;
  activeTenantId: string | null;
  /** The active tenant's name for the Ink header's scope line (RT-1018). */
  activeTenantName?: string | null;
  onClose: () => void;
  /**
   * Called after a successful write so the parent can close + refresh. Carries
   * the success notice to show on the queue, or null when the change speaks
   * for itself (a dismissed row simply leaves the queue).
   */
  onCompleted: (notice: MessageKey | null) => void;
}

/** Which action step the drawer shows under the detail. */
type Step = "actions" | "dismiss" | "create" | "link";

/** Reopen a dismissed item: one primary action, its error inline. */
function ReopenAction({
  item,
  activeTenantId,
  onReopened,
}: Readonly<{
  item: ReviewQueueItem;
  activeTenantId: string | null;
  onReopened: () => void;
}>): React.JSX.Element {
  const t = useT();
  const hintId = useId();
  const reopen = useUnknownItemReopen(activeTenantId);
  const result = reopen.data;
  const error = result && !result.ok ? result.render : undefined;
  return (
    <div className="unknown-item-dismiss">
      {error ? <UnknownItemErrorBanner error={error} /> : null}
      {reopen.isError ? <Banner variant="danger" message={t("errors.server")} /> : null}
      <div className="unknown-item-choices">
        <div className="unknown-item-choice">
          <GatedButton
            type="button"
            className="btn-primary"
            busy={reopen.isPending}
            aria-describedby={hintId}
            onClick={() =>
              reopen.mutate(item.id, {
                onSuccess: (res) => {
                  if (res.ok) onReopened();
                },
              })
            }
          >
            {t("unknownItems.reopen.action")}
          </GatedButton>
          <p id={hintId} className="field__hint">
            {t("unknownItems.reopen.hint")}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * RT-1117 (v9 board `Unknown-items`): one drawer action with its one-line
 * description under it. The description is a visible hint wired with
 * `aria-describedby`, so the button's accessible name stays its label.
 */
function ActionChoice({
  className,
  label,
  hint,
  onClick,
}: Readonly<{
  className: string;
  label: string;
  hint: string;
  onClick: () => void;
}>): React.JSX.Element {
  const hintId = useId();
  return (
    <div className="unknown-item-choice">
      <button type="button" className={className} aria-describedby={hintId} onClick={onClick}>
        {label}
      </button>
      <p id={hintId} className="field__hint">
        {hint}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
}: Readonly<{ label: string; value: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="unknown-item-detail__field">
      <dt className="unknown-item-detail__label">{label}</dt>
      <dd className="unknown-item-detail__value">{value ?? "—"}</dd>
    </div>
  );
}

/** A machine value (id, code) isolated LTR, or null to show the empty mark. */
function machine(value: string | null): React.ReactNode {
  return value === null ? null : <bdi dir="ltr">{value}</bdi>;
}

/** The pill colour role by lifecycle state (text always carries it); dismissed is neutral. */
const STATUS_BADGE: Partial<Record<ReviewQueueItem["resolution_status"], string>> = {
  pending: "badge--pending",
  resolved: "badge--success",
};

function DetailBody({ item }: Readonly<{ item: ReviewQueueItem }>): React.JSX.Element {
  const t = useT();
  // An enum value outside the contract shows verbatim rather than a guess.
  const label = (key: MessageKey | null, raw: string | null): React.ReactNode =>
    key ? t(key) : machine(raw);
  return (
    <dl className="unknown-item-detail">
      <Field label={t("unknownItems.field.identifier")} value={machine(item.identifier_value)} />
      <Field
        label={t("unknownItems.field.identifierType")}
        value={label(identifierTypeKey(item.identifier_type), item.identifier_type)}
      />
      <Field label={t("unknownItems.field.source")} value={machine(item.source_system)} />
      <Field label={t("unknownItems.field.store")} value={machine(item.store_id)} />
      <Field
        label={t("unknownItems.field.status")}
        value={
          <span className={`badge ${STATUS_BADGE[item.resolution_status] ?? ""}`.trim()}>
            {label(resolutionStatusKey(item.resolution_status), item.resolution_status)}
          </span>
        }
      />
      <Field
        label={t("unknownItems.field.resolutionAction")}
        value={label(resolutionActionKey(item.resolution_action), item.resolution_action)}
      />
      <Field
        label={t("unknownItems.field.encounteredAt")}
        value={<DateTime value={item.encountered_at} />}
      />
      <Field
        label={t("unknownItems.field.resolvedAt")}
        value={item.resolved_at ? <DateTime value={item.resolved_at} /> : null}
      />
      <Field label={t("unknownItems.field.resolvedBy")} value={machine(item.resolved_by)} />
    </dl>
  );
}

/**
 * RT-1234: keep focus inside the dialog when a step swaps in. The clicked button
 * unmounts, so focus would fall to <body> and Tab/Escape would leave the
 * drawer's trap. Skips the first render (the Drawer focuses the panel itself).
 * A form step opens on its first field; a confirm or the actions keep the
 * region itself, so a destructive button is never focused by the swap.
 */
function useFocusOnStepChange(step: Step): React.RefObject<HTMLDivElement | null> {
  const regionRef = useRef<HTMLDivElement>(null);
  const shownStep = useRef<Step>(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    const region = regionRef.current;
    if (!region) return;
    const field = region.querySelector<HTMLElement>(
      "input:not([disabled]),select:not([disabled]),textarea:not([disabled])",
    );
    (field ?? region).focus();
  }, [step]);
  return regionRef;
}

export function UnknownItemInspectDrawer({
  id,
  activeTenantId,
  activeTenantName = null,
  onClose,
  onCompleted,
}: Readonly<UnknownItemInspectDrawerProps>): React.JSX.Element {
  const t = useT();
  const { result, isLoading } = useUnknownItemInspect(id);
  const [step, setStep] = useState<Step>("actions");
  // The item was resolved elsewhere while a link was being chosen (RT-767).
  const [resolvedElsewhere, setResolvedElsewhere] = useState(false);

  const item = result?.kind === "item" ? result.item : undefined;
  const error = result?.kind === "error" ? result.render : undefined;
  const isPending = item?.resolution_status === "pending";
  const isDismissed = item?.resolution_status === "dismissed";

  const stepRef = useFocusOnStepChange(step);

  return (
    <Drawer
      title={t("unknownItems.drawer.title")}
      scope={
        activeTenantName
          ? t.rich("unknownItems.drawer.scope", { tenant: <bdi>{activeTenantName}</bdi> })
          : undefined
      }
      onClose={onClose}
    >
      {isLoading ? (
        <ListState state="loading" label={t("unknownItems.drawer.loadingNoun")} />
      ) : null}

      {error?.kind === "not-found" ? <Banner variant="info" message={t(error.messageKey)} /> : null}
      {error && (error.kind === "banner" || error.kind === "generic") ? (
        <Banner variant="danger" message={t(error.messageKey)} requestId={error.requestId} />
      ) : null}

      {item ? (
        <>
          {resolvedElsewhere ? (
            <Banner variant="warning" message={t("unknownItems.link.alreadyResolved")} />
          ) : null}
          <DetailBody item={item} />
          <div ref={stepRef} tabIndex={-1} className="unknown-item-step">
            {isPending && step === "actions" ? (
              <div className="unknown-item-choices">
                <ActionChoice
                  className="btn-primary"
                  label={t("unknownItems.create.action")}
                  hint={t("unknownItems.create.hint")}
                  onClick={() => setStep("create")}
                />
                <ActionChoice
                  className="btn-secondary"
                  label={t("unknownItems.link.action")}
                  hint={t("unknownItems.link.hint")}
                  onClick={() => setStep("link")}
                />
                <ActionChoice
                  className="btn-danger-quiet"
                  label={t("unknownItems.dismiss.action")}
                  hint={t("unknownItems.dismiss.hint")}
                  onClick={() => setStep("dismiss")}
                />
              </div>
            ) : null}
            {isPending && step === "link" ? (
              <UnknownItemLinkProduct
                key={activeTenantId ?? "none"}
                item={item}
                activeTenantId={activeTenantId}
                onLinked={() => onCompleted("unknownItems.link.success")}
                onResolvedElsewhere={() => {
                  setResolvedElsewhere(true);
                  setStep("actions");
                }}
                onCancel={() => setStep("actions")}
              />
            ) : null}
            {isPending && step === "create" ? (
              <UnknownItemCreateProduct
                item={item}
                activeTenantId={activeTenantId}
                onCreated={() => onCompleted("unknownItems.create.success")}
                onCancel={() => setStep("actions")}
              />
            ) : null}
            {isPending && step === "dismiss" ? (
              <UnknownItemDismiss
                item={item}
                activeTenantId={activeTenantId}
                onDismissed={() => onCompleted(null)}
                onCancel={() => setStep("actions")}
              />
            ) : null}
          </div>
          {isDismissed ? (
            <ReopenAction
              item={item}
              activeTenantId={activeTenantId}
              onReopened={() => onCompleted("unknownItems.reopen.success")}
            />
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}
