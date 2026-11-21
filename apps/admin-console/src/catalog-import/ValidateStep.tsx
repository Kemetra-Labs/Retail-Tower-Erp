/**
 * RT-1509 step 3, «التحقق»: what the server found, per row. A status band whose counts are the
 * server's `counts` (they sum to the file's data rows) and act as the filter, a semantic table of
 * rows with their issues in words, and the read-only «تقرير الأخطاء» download. Rows page by keyset
 * (no page numbers, no totals the contract does not give) and keep what is shown when a continuation
 * fails (UX-10.17, UX-10.18). The filter lives in the URL.
 *
 * A `draft` batch with a mapping has no current results (a stale return, or an interrupted run): the
 * step says so and offers «تحقق من جديد». The stale notice stays until validation runs again.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { formatNumber, useT } from "@/i18n";
import {
  type CatalogImportBatch,
  type RowStatus,
  type StatusCounts,
  consoleGetCatalogImportErrorReport,
  consoleValidateCatalogImport,
} from "@/lib/catalog-import-queries";
import { saveBlob } from "@/lib/save-blob";
import { useId, useState } from "react";
import { useSearchParams } from "react-router";
import {
  type ImportOutcome,
  STATUS_KEYS,
  STATUS_ORDER,
  stepAfterValidate,
  undecidedCount,
} from "./catalogImportLogic";
import {
  RefusalBanner,
  RowIssues,
  RowProduct,
  StatusBadge,
  ValidatingNote,
  filenameFromDisposition,
  outcomeOf,
} from "./importParts";
import type { StepProps } from "./stepTypes";
import { type RowPager, useImportRows } from "./useCatalogImport";

type Failure = Exclude<ImportOutcome<unknown>, { kind: "ok" }>;

function statusParam(value: string | null): RowStatus | undefined {
  return STATUS_ORDER.find((s) => s === value);
}

/** One validation run: the answer replaces the batch in the cache and restarts the row pages. */
function useValidateRun({ batch, cache, setNotice, bumpRun }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  async function validate(): Promise<void> {
    setBusy(true);
    setFailure(null);
    const outcome = await outcomeOf(() =>
      consoleValidateCatalogImport(batch.batchId, batch.version),
    );
    setBusy(false);
    if (outcome.kind !== "ok") {
      setFailure(outcome);
      if (outcome.kind === "refused" && outcome.code === "version_conflict") void cache.reread();
      return;
    }
    cache.store(outcome.data);
    setNotice(null);
    bumpRun();
  }
  return { busy, failure, validate };
}

function NeedsValidation({
  props,
  run,
}: Readonly<{ props: StepProps; run: ReturnType<typeof useValidateRun> }>): React.JSX.Element {
  const t = useT();
  const { batch, notice, requestCancel, locked } = props;
  const stale = notice === "stale";
  return (
    <div className="import-step">
      <Banner
        variant={stale ? "warning" : "info"}
        title={t(
          stale ? "catalogImport.validate.stale.title" : "catalogImport.validate.needed.title",
        )}
        message={t(
          stale ? "catalogImport.validate.stale.body" : "catalogImport.validate.needed.body",
        )}
      />
      {run.failure ? <RefusalBanner outcome={run.failure} /> : null}
      {run.busy ? <ValidatingNote rows={batch.file.dataRowCount} /> : null}
      <div className="import-step__actions">
        <GatedButton
          className="btn-primary"
          busy={run.busy}
          disabled={locked}
          onClick={() => void run.validate()}
        >
          {run.busy ? t("catalogImport.validate.busy.button") : t("catalogImport.validate.again")}
        </GatedButton>
        <button
          type="button"
          className="btn-danger-quiet import-step__actions-end"
          disabled={run.busy || locked}
          onClick={requestCancel}
        >
          {t("catalogImport.cancel.action")}
        </button>
      </div>
    </div>
  );
}

function StatusBand({
  counts,
  total,
  status,
  setStatus,
}: Readonly<{
  counts: StatusCounts;
  total: number;
  status: RowStatus | undefined;
  setStatus: (next: RowStatus | undefined) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of toggle buttons, not form controls.
    <div className="import-band" role="group" aria-label={t("catalogImport.validate.band")}>
      <button
        type="button"
        className="import-band__item"
        aria-pressed={status === undefined}
        onClick={() => setStatus(undefined)}
      >
        <b>{formatNumber(total)}</b>
        <span>{t("catalogImport.validate.all")}</span>
      </button>
      {STATUS_ORDER.map((s) => (
        <button
          key={s}
          type="button"
          className="import-band__item"
          aria-pressed={status === s}
          onClick={() => setStatus(status === s ? undefined : s)}
        >
          <b>{formatNumber(counts[s])}</b>
          <span>{t(STATUS_KEYS[s])}</span>
        </button>
      ))}
    </div>
  );
}

function RowsTable({
  batch,
  pager,
  caption,
}: Readonly<{ batch: CatalogImportBatch; pager: RowPager; caption: string }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="import-table-wrap">
      <table className="import-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t("catalogImport.validate.col.row")}</th>
            <th scope="col">{t("catalogImport.validate.col.status")}</th>
            <th scope="col">{t("catalogImport.validate.col.product")}</th>
            <th scope="col">{t("catalogImport.validate.col.issues")}</th>
          </tr>
        </thead>
        <tbody>
          {pager.rows.map((row) => (
            <tr key={row.rowNumber}>
              <th scope="row" className="is-num">
                <bdi dir="ltr">{row.rowNumber}</bdi>
              </th>
              <td>
                <StatusBadge status={row.status} />
              </td>
              <td>
                <RowProduct batch={batch} row={row} />
              </td>
              <td>
                <RowIssues row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowsView({
  batch,
  pager,
  status,
  setStatus,
}: Readonly<{
  batch: CatalogImportBatch;
  pager: RowPager;
  status: RowStatus | undefined;
  setStatus: (next: RowStatus | undefined) => void;
}>): React.JSX.Element {
  const t = useT();
  const counts = batch.counts;
  if (pager.loading)
    return <ListState state="loading" label={t("catalogImport.validate.loading")} />;
  if (pager.error) {
    return (
      <Banner
        variant="danger"
        title={t("catalogImport.validate.rowsFailed.title")}
        message={t("catalogImport.validate.rowsFailed.body")}
        requestId={pager.error.requestId}
        action={
          <button type="button" className="btn-secondary" onClick={pager.reload}>
            {t("catalogImport.reload")}
          </button>
        }
      />
    );
  }
  if (pager.rows.length === 0) {
    return (
      <ListState
        state="empty"
        emptyMessage={t("catalogImport.validate.empty")}
        action={
          <button type="button" className="btn-secondary" onClick={() => setStatus(undefined)}>
            {t("catalogImport.validate.showAll")}
          </button>
        }
      />
    );
  }
  const caption = status
    ? t("catalogImport.validate.caption", {
        status: t(STATUS_KEYS[status]),
        count: formatNumber(counts ? counts[status] : 0),
      })
    : t("catalogImport.validate.captionAll", { count: formatNumber(batch.file.dataRowCount) });
  return (
    <>
      <RowsTable batch={batch} pager={pager} caption={caption} />
      {pager.moreFailed ? (
        <Banner
          variant="danger"
          title={t("catalogImport.validate.loadMoreFailed.title")}
          message={t("catalogImport.validate.loadMoreFailed.body")}
        />
      ) : null}
      {pager.hasMore ? (
        <div>
          <GatedButton className="btn-secondary" busy={pager.loadingMore} onClick={pager.loadMore}>
            {t("catalogImport.validate.loadMore")}
          </GatedButton>
        </div>
      ) : null}
    </>
  );
}

function ErrorReport({ batchId }: Readonly<{ batchId: string }>): React.JSX.Element {
  const t = useT();
  const id = useId();
  const [failed, setFailed] = useState(false);
  async function download(): Promise<void> {
    setFailed(false);
    const res = await consoleGetCatalogImportErrorReport(batchId).catch(() => null);
    if (!res || res.status !== 200 || !res.data) {
      setFailed(true);
      return;
    }
    saveBlob(
      res.data as Blob,
      filenameFromDisposition(res.disposition, `import-errors-${batchId}.csv`),
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn-secondary import-step__actions-end"
        aria-describedby={`${id}-report`}
        onClick={() => void download()}
      >
        {t("catalogImport.validate.errorReport")}
      </button>
      <p id={`${id}-report`} className="import-step__why">
        {t("catalogImport.validate.errorReportHint")}
      </p>
      {failed ? (
        <Banner variant="danger" message={t("catalogImport.validate.errorReportFailed")} />
      ) : null}
    </>
  );
}

function ValidateActions({
  props,
  run,
}: Readonly<{ props: StepProps; run: ReturnType<typeof useValidateRun> }>): React.JSX.Element {
  const t = useT();
  const { batch, go, locked, requestCancel } = props;
  const counts = batch.counts;
  const next = stepAfterValidate(counts);
  return (
    <>
      <div className="import-step__actions">
        <button type="button" className="btn-primary" disabled={locked} onClick={() => go(next)}>
          {t(
            next === "review"
              ? "catalogImport.validate.toReview"
              : "catalogImport.validate.toPreview",
          )}
        </button>
        <GatedButton
          className="btn-ghost"
          busy={run.busy}
          disabled={locked}
          onClick={() => void run.validate()}
        >
          {t("catalogImport.validate.again")}
        </GatedButton>
        {counts && undecidedCount(counts) > 0 ? (
          <span className="import-step__why">
            {t("catalogImport.validate.nextReason", {
              errors: formatNumber(counts.error),
              review: formatNumber(counts.needs_review),
            })}
          </span>
        ) : null}
        <button
          type="button"
          className="btn-danger-quiet import-step__actions-end"
          disabled={locked}
          onClick={requestCancel}
        >
          {t("catalogImport.cancel.action")}
        </button>
      </div>
      {run.failure ? <RefusalBanner outcome={run.failure} /> : null}
    </>
  );
}

export function ValidateStep(props: Readonly<StepProps>): React.JSX.Element {
  const { batch, run: runNo } = props;
  const t = useT();
  const [params, setParams] = useSearchParams();
  const run = useValidateRun(props);
  const status = statusParam(params.get("status"));
  const validated = batch.state === "validated" && batch.counts !== null;
  const pager = useImportRows(batch.batchId, status, runNo, validated);

  function setStatus(next: RowStatus | undefined): void {
    const nextParams = new URLSearchParams(params);
    if (next) nextParams.set("status", next);
    else nextParams.delete("status");
    setParams(nextParams, { replace: true });
  }

  if (!validated || !batch.counts) return <NeedsValidation props={props} run={run} />;
  return (
    <div className="import-step">
      <div className="import-step__actions">
        <p className="import-step__lead">
          {t("catalogImport.validate.rows", { count: formatNumber(batch.file.dataRowCount) })}
        </p>
        <ErrorReport batchId={batch.batchId} />
      </div>
      <StatusBand
        counts={batch.counts}
        total={batch.file.dataRowCount}
        status={status}
        setStatus={setStatus}
      />
      {status ? (
        <div className="import-row">
          <span className="badge">
            {t("catalogImport.validate.filterActive", { status: t(STATUS_KEYS[status]) })}
          </span>
          <button type="button" className="btn-ghost" onClick={() => setStatus(undefined)}>
            {t("catalogImport.validate.showAll")}
          </button>
        </div>
      ) : null}
      <RowsView batch={batch} pager={pager} status={status} setStatus={setStatus} />
      <ValidateActions props={props} run={run} />
    </div>
  );
}
