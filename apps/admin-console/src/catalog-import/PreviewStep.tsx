/**
 * RT-1509 step 5, «المعاينة»: say exactly what publish would do, for the `previewHash` on screen.
 * Every figure is the server's. The preview is a snapshot, not a reservation: the catalogue can
 * still change before publish, and the server then answers `409 stale_validation` (back to
 * Validate) or `409 preview_changed` (this preview again).
 *
 * Publish is offered only when the server calls the preview publishable AND names no conflict
 * (`canPublish`, the RT-1536 adapter). A blocked publish stays visible with its reason in text. A
 * batch with nothing to write gets no publish button (G11: the contract does not say a zero-effect
 * batch publishes).
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { ListState } from "@/components/ListState";
import { type MessageKey, formatNumber, useT } from "@/i18n";
import type {
  CatalogImportBatch,
  CatalogImportPreview,
  ImportConflict,
} from "@/lib/catalog-import-queries";
import { useId, useState } from "react";
import { ConflictList } from "./ConflictList";
import { PublishDialog } from "./PublishDialog";
import {
  canPublish,
  conflictTotal,
  isZeroEffect,
  previewConflicts,
  undecidedCount,
} from "./catalogImportLogic";
import { changeFieldLabel, useBrowserTime } from "./importParts";
import type { StepProps } from "./stepTypes";
import { useImportPreview, useImportRows } from "./useCatalogImport";
import type { PublishFlow } from "./usePublishFlow";

const COUNT_ROWS = [
  ["catalogImport.preview.count.create", (p: CatalogImportPreview) => p.productsToCreate],
  ["catalogImport.preview.count.update", (p: CatalogImportPreview) => p.productsToUpdate],
  ["catalogImport.preview.count.identifiers", (p: CatalogImportPreview) => p.identifiersToAdd],
  ["catalogImport.preview.count.brands", (p: CatalogImportPreview) => p.brandsToCreate.length],
  ["catalogImport.preview.count.unchanged", (p: CatalogImportPreview) => p.counts.unchanged],
  ["catalogImport.preview.count.excluded", (p: CatalogImportPreview) => p.counts.excluded],
] as const;

/** Why publish is, or is not, offered: the server's verdict, a named conflict, or undecided rows. */
function usePublishGate(batch: CatalogImportBatch, preview: CatalogImportPreview) {
  const conflicts: readonly ImportConflict[] | null = previewConflicts(preview);
  const total = conflictTotal(preview);
  const hasConflicts = conflicts !== null || total > 0;
  const undecided = undecidedCount(batch.counts) > 0;
  const allowed = canPublish(preview) && !undecided;
  let blockedKey: MessageKey | null = null;
  if (!allowed) {
    if (hasConflicts) blockedKey = "catalogImport.preview.blockedConflict";
    else if (undecided) blockedKey = "catalogImport.preview.blockedUndecided";
    else blockedKey = "catalogImport.preview.blockedNotPublishable";
  }
  return { conflicts, total, hasConflicts, allowed, blockedKey };
}

function PreviewNotices({
  notice,
  publish,
}: Readonly<{ notice: StepProps["notice"]; publish: PublishFlow }>): React.JSX.Element {
  const t = useT();
  const unclear = publish.phase === "unclear" || publish.phase === "refreshing";
  return (
    <>
      {notice === "previewChanged" ? (
        <Banner
          variant="warning"
          title={t("catalogImport.preview.changed.title")}
          message={t("catalogImport.preview.changed.body")}
        />
      ) : null}
      {notice === "notPublishable" ? (
        <Banner
          variant="danger"
          title={t("catalogImport.preview.notPublishable.title")}
          message={t("catalogImport.preview.notPublishable.body")}
        />
      ) : null}
      {unclear ? (
        <Banner
          variant="warning"
          title={t("catalogImport.publish.persistent.title")}
          message={t("catalogImport.publish.persistent.body")}
          action={
            <>
              <button type="button" className="btn-secondary" onClick={() => void publish.resend()}>
                {t("catalogImport.publish.unclear.resend")}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void publish.refresh()}
              >
                {t("catalogImport.publish.unclear.refresh")}
              </button>
            </>
          }
        />
      ) : null}
    </>
  );
}

function Deactivations({
  preview,
}: Readonly<{ preview: CatalogImportPreview }>): React.JSX.Element | null {
  const t = useT();
  if (preview.deactivations.length === 0) return null;
  return (
    <>
      <Banner
        variant="warning"
        title={t("catalogImport.preview.deactivations", {
          count: formatNumber(preview.deactivations.length),
        })}
        message={t("catalogImport.preview.deactivationsBody")}
      />
      <ul className="import-issues">
        {preview.deactivations.map((d) => (
          <li key={`${d.rowNumber}-${d.product.productId}`}>
            {d.product.name}
            {d.product.identifiers[0] ? (
              <>
                {" · "}
                <bdi dir="ltr">{d.product.identifiers[0].value}</bdi>
              </>
            ) : null}
            {" · "}
            {t("catalogImport.preview.deactivationRow", { row: d.rowNumber })}
          </li>
        ))}
      </ul>
    </>
  );
}

function PreviewFigures({
  preview,
}: Readonly<{ preview: CatalogImportPreview }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <p className="import-step__lead">{t("catalogImport.preview.title")}</p>
      <ul className="import-kv import-panel">
        {COUNT_ROWS.map(([key, count]) => (
          <li key={key}>
            {t(key)}
            <b>{formatNumber(count(preview))}</b>
          </li>
        ))}
      </ul>
      <Deactivations preview={preview} />
      {preview.newProductsWithoutPrice > 0 ? (
        <Banner
          variant="info"
          title={t("catalogImport.preview.unpriced", {
            count: formatNumber(preview.newProductsWithoutPrice),
          })}
          message={t("catalogImport.preview.unpricedBody", {
            rows: formatNumber(preview.rowsWithPriceNotImported),
          })}
        />
      ) : null}
      {preview.brandsToCreate.length > 0 ? (
        <section className="import-panel">
          <h3 className="import-step__title">{t("catalogImport.preview.brands")}</h3>
          <p>{preview.brandsToCreate.join(" · ")}</p>
        </section>
      ) : null}
    </>
  );
}

function PreviewActions({
  preview,
  gate,
  props,
  onChanges,
}: Readonly<{
  preview: CatalogImportPreview;
  gate: ReturnType<typeof usePublishGate>;
  props: StepProps;
  onChanges: () => void;
}>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const time = useBrowserTime();
  const [computedAt] = useState(() => new Date().toISOString());
  const nothing = isZeroEffect(preview);
  return (
    <>
      {nothing ? (
        <ListState
          state="empty"
          emptyMessage={t("catalogImport.preview.nothing")}
          emptyHint={t("catalogImport.preview.nothingHint")}
        />
      ) : (
        <>
          <div className="import-step__actions">
            <button type="button" className="btn-secondary" onClick={onChanges}>
              {t("catalogImport.preview.changes")}
            </button>
          </div>
          <p className="import-step__why">
            {t("catalogImport.preview.snapshot", { time: time(computedAt) })}
          </p>
        </>
      )}
      <div className="import-step__actions">
        {nothing ? null : (
          <button
            type="button"
            className="btn-primary"
            disabled={!gate.allowed || props.locked}
            aria-describedby={gate.blockedKey ? `${id}-why` : undefined}
            onClick={props.publish.open}
          >
            {t("catalogImport.preview.publish")}
          </button>
        )}
        {props.locked ? (
          <span className="import-step__why">{t("catalogImport.publish.persistent.reason")}</span>
        ) : null}
        {gate.blockedKey && !nothing ? (
          <span id={`${id}-why`} className="import-step__why">
            {t(gate.blockedKey)}
          </span>
        ) : null}
        <button
          type="button"
          className="btn-danger-quiet import-step__actions-end"
          disabled={props.locked}
          onClick={props.requestCancel}
        >
          {t(
            gate.hasConflicts
              ? "catalogImport.cancel.actionRestart"
              : "catalogImport.cancel.action",
          )}
        </button>
      </div>
    </>
  );
}

export function PreviewStep(props: Readonly<StepProps>): React.JSX.Element {
  const { batch, notice, publish } = props;
  const t = useT();
  const read = useImportPreview(batch.batchId, true, publish.revision);
  const [showChanges, setShowChanges] = useState(false);
  const preview = read.data;
  if (read.isLoading)
    return <ListState state="loading" label={t("catalogImport.preview.loading")} />;
  if (!preview) {
    return (
      <Banner
        variant="danger"
        title={t("catalogImport.preview.failed.title")}
        message={t("catalogImport.preview.failed.body")}
        requestId={read.error?.requestId}
        action={
          <button type="button" className="btn-secondary" onClick={read.refetch}>
            {t("catalogImport.reload")}
          </button>
        }
      />
    );
  }
  return (
    <LoadedPreview
      key={preview.previewHash}
      props={props}
      preview={preview}
      notice={notice}
      showChanges={showChanges}
      setShowChanges={setShowChanges}
    />
  );
}

function LoadedPreview({
  props,
  preview,
  notice,
  showChanges,
  setShowChanges,
}: Readonly<{
  props: StepProps;
  preview: CatalogImportPreview;
  notice: StepProps["notice"];
  showChanges: boolean;
  setShowChanges: (v: boolean) => void;
}>): React.JSX.Element {
  const { batch, publish, run } = props;
  const gate = usePublishGate(batch, preview);
  return (
    <div className="import-step">
      <PreviewNotices notice={notice} publish={publish} />
      {gate.conflicts ? <ConflictList conflicts={gate.conflicts} total={gate.total} /> : null}
      <PreviewFigures preview={preview} />
      <PreviewActions
        preview={preview}
        gate={gate}
        props={props}
        onChanges={() => setShowChanges(true)}
      />
      {showChanges ? (
        <ChangesDrawer batch={batch} onClose={() => setShowChanges(false)} run={run} />
      ) : null}
      {publish.dialogOpen ? <PublishDialog preview={preview} flow={publish} /> : null}
    </div>
  );
}

/** Field-level before → after of the rows that update a product (the rows carry `fieldChanges`). */
function ChangesDrawer({
  batch,
  onClose,
  run,
}: Readonly<{ batch: CatalogImportBatch; onClose: () => void; run: number }>): React.JSX.Element {
  const t = useT();
  const pager = useImportRows(batch.batchId, "ready_update", run);
  const changed = pager.rows.filter((r) => r.outcome.fieldChanges.length > 0);
  return (
    <Drawer title={t("catalogImport.changes.title")} onClose={onClose}>
      {pager.loading ? <ListState state="loading" /> : null}
      {pager.error ? (
        <Banner
          variant="danger"
          message={t("catalogImport.changes.loadFailed")}
          requestId={pager.error.requestId}
        />
      ) : null}
      {!pager.loading && !pager.error && changed.length === 0 ? (
        <p>{t("catalogImport.changes.empty")}</p>
      ) : null}
      <div className="import-changes">
        {changed.map((row) => (
          <section key={row.rowNumber}>
            <h3 className="import-step__title">
              {t("catalogImport.changes.row", {
                row: row.rowNumber,
                name: row.outcome.matchedProduct?.name ?? "",
              })}
            </h3>
            <dl>
              {row.outcome.fieldChanges.map((c) => (
                <FieldChangeLine key={c.field} field={c.field} before={c.before} after={c.after} />
              ))}
            </dl>
          </section>
        ))}
      </div>
      {pager.hasMore ? (
        <button type="button" className="btn-secondary" onClick={pager.loadMore}>
          {t("catalogImport.validate.loadMore")}
        </button>
      ) : null}
    </Drawer>
  );
}

function FieldChangeLine({
  field,
  before,
  after,
}: Readonly<{ field: string; before: string | null; after: string | null }>): React.JSX.Element {
  const t = useT();
  const label = changeFieldLabel(t, field);
  const none = t("catalogImport.changes.none");
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="sr-only">{t("catalogImport.changes.before")}: </span>
        {before ?? none}
      </dd>
      <dd>
        <span className="sr-only">{t("catalogImport.changes.after")}: </span>
        {after ?? none}
      </dd>
    </>
  );
}
