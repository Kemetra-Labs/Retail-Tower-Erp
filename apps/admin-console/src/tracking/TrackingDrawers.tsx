/**
 * RT-455 read drawers, owner / tenant_admin only (the reads' roles): one hold
 * (`getTrackingHold`) and one recall with its holds (`getInventoryRecall`).
 * Each opens over the list, so the table keeps its place, filters and focus
 * (UX-10.31). The actor is a member's name, else the fallback label (OD-3).
 * An active hold's drawer carries the release (owner only; recessed with the
 * reason for a tenant_admin, owner approval RT-455 comment 15245).
 */
import { Drawer } from "@/components/Drawer";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type { InventoryRecall, TrackingHold } from "@/lib/tracking-queries";
import { Machine, ReadError } from "../inventory/parts";
import type { InventoryScope } from "../inventory/useInventory";
import { IdentityLink } from "./HistoryPanels";
import { ReleaseSection, WriteResult } from "./TrackingForms";
import { ActorName, HoldKindBadge, ProductName, ReasonLabel, When } from "./parts";
import { canReleaseHold, holdKindKey } from "./trackingLogic";
import { useRecall, useTrackingHold } from "./useTracking";
import { useReleaseHold } from "./useTrackingWrites";

function Field({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function HoldFields({ hold }: Readonly<{ hold: TrackingHold }>): React.JSX.Element {
  const t = useT();
  return (
    <dl className="tracking__fields">
      <Field label={t("tracking.col.product")}>
        <ProductName id={hold.tenantProductRef} />
      </Field>
      <Field label={t("tracking.col.identity")}>
        <IdentityLink id={hold.trackingIdentityId} />
      </Field>
      <Field label={t("tracking.col.reason")}>
        <ReasonLabel code={hold.reasonCode} />
      </Field>
      <Field label={t("tracking.col.note")}>
        {hold.note ? <bdi>{hold.note}</bdi> : t("tracking.value.none")}
      </Field>
      <Field label={t("tracking.col.placedAt")}>
        <When iso={hold.placedAt} />
      </Field>
      <Field label={t("tracking.col.placedBy")}>
        <ActorName userId={hold.placedBy} />
      </Field>
      {hold.recallId ? (
        <Field label={t("tracking.col.recall")}>
          <Machine value={hold.recallId} />
        </Field>
      ) : null}
      {hold.releasedAt ? (
        <Field label={t("tracking.col.releasedAt")}>
          <When iso={hold.releasedAt} />
        </Field>
      ) : null}
      {hold.releasedBy ? (
        <Field label={t("tracking.col.releasedBy")}>
          <ActorName userId={hold.releasedBy} />
        </Field>
      ) : null}
      {hold.releaseNote ? (
        <Field label={t("tracking.col.releaseNote")}>
          <bdi>{hold.releaseNote}</bdi>
        </Field>
      ) : null}
    </dl>
  );
}

export function HoldDrawer({
  scope,
  holdId,
  code,
  onClose,
}: Readonly<{
  scope: InventoryScope;
  holdId: string;
  /** The held identity's code when the opener knows it (a hold carries only the id). */
  code?: string;
  onClose: () => void;
}>): React.JSX.Element {
  const t = useT();
  const hold = useTrackingHold(scope, holdId);
  const release = useReleaseHold(holdId);
  const data = hold.data;
  const title = data
    ? t("tracking.hold.title", {
        kind: t(holdKindKey(data.kind)),
        state: t(data.active ? "tracking.hold.active" : "tracking.hold.released"),
      })
    : t("tracking.hold.titleLoading");
  return (
    <Drawer
      title={title}
      onClose={onClose}
      scope={t("tracking.hold.scope")}
      dismissible={!release.pending}
    >
      <div className="tracking__drawer-body" data-testid="tracking-hold-drawer">
        {hold.isLoading ? (
          <ListState state="loading" label={t("tracking.hold.loadingNoun")} />
        ) : null}
        {hold.error ? (
          <ReadError
            error={hold.error}
            failedKey="tracking.hold.loadFailed"
            notFoundKey="tracking.hold.notFound"
            onRetry={hold.retry}
          />
        ) : null}
        {data ? (
          <>
            <HoldKindBadge kind={data.kind} />
            <HoldFields hold={data} />
            {data.active ? (
              <ReleaseSection
                write={release}
                code={code ?? data.trackingIdentityId}
                canRelease={canReleaseHold(scope.role)}
              />
            ) : null}
            {/* Outside the active branch: a recorded release re-reads the hold as released. */}
            <WriteResult
              outcome={release.outcome}
              recorded={t("tracking.release.recorded", { code: code ?? data.trackingIdentityId })}
            />
          </>
        ) : null}
      </div>
    </Drawer>
  );
}

function RecallHolds({ recall }: Readonly<{ recall: InventoryRecall }>): React.JSX.Element {
  const t = useT();
  return (
    <table className="data-table" data-testid="tracking-recall-holds">
      <caption className="data-table__caption">{t("tracking.recall.holdsCaption")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("tracking.col.identity")}</th>
          <th scope="col">{t("tracking.col.status")}</th>
          <th scope="col">{t("tracking.col.releasedAt")}</th>
        </tr>
      </thead>
      <tbody>
        {recall.holds.map((hold) => (
          <tr key={hold.id} className="data-table__row data-table__row--static">
            <th scope="row">
              <IdentityLink id={hold.trackingIdentityId} />
            </th>
            <td>{t(hold.active ? "tracking.hold.active" : "tracking.hold.released")}</td>
            <td>{hold.releasedAt ? <When iso={hold.releasedAt} /> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RecallDrawer({
  scope,
  recallId,
  onClose,
}: Readonly<{ scope: InventoryScope; recallId: string; onClose: () => void }>): React.JSX.Element {
  const t = useT();
  const recall = useRecall(scope, recallId);
  const data = recall.data;
  return (
    <Drawer title={t("tracking.recall.title")} onClose={onClose} scope={t("tracking.recall.scope")}>
      <div className="tracking__drawer-body" data-testid="tracking-recall-drawer">
        {recall.isLoading ? (
          <ListState state="loading" label={t("tracking.recall.loadingNoun")} />
        ) : null}
        {recall.error ? (
          <ReadError
            error={recall.error}
            failedKey="tracking.recall.loadFailed"
            notFoundKey="tracking.recall.notFound"
            onRetry={recall.retry}
          />
        ) : null}
        {data ? (
          <>
            <dl className="tracking__fields">
              <Field label={t("tracking.col.product")}>
                <ProductName id={data.tenantProductRef} />
              </Field>
              <Field label={t("tracking.col.reference")}>
                <Machine value={data.reference} />
              </Field>
              <Field label={t("tracking.col.reason")}>
                <ReasonLabel code={data.reasonCode} />
              </Field>
              <Field label={t("tracking.col.note")}>
                {data.note ? <bdi>{data.note}</bdi> : t("tracking.value.none")}
              </Field>
              <Field label={t("tracking.col.effectiveAt")}>
                <When iso={data.effectiveAt} />
              </Field>
              <Field label={t("tracking.col.createdAt")}>
                <When iso={data.createdAt} />
              </Field>
              <Field label={t("tracking.col.createdBy")}>
                <ActorName userId={data.createdBy} />
              </Field>
            </dl>
            <RecallHolds recall={data} />
            <p className="tracking__muted">{t("tracking.recall.note")}</p>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
