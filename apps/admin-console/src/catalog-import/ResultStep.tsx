/**
 * RT-1509 step 7, «النتيجة»: shown only for a `published` batch, i.e. after the server confirmed.
 * The summary is the publish answer's own; when the batch is opened again later (a reload, a replay)
 * `GET batch` carries no publish summary (G8), so the figures are read from the preview, which the
 * contract allows for a published batch, and the page says it is the stored result. No undo is
 * offered: no domain contract restores a published batch (UX-05.21). The audit reference is the
 * batch id (D12), copyable and LTR.
 */
import { Banner } from "@/components/Banner";
import { ListState } from "@/components/ListState";
import { formatNumber, useT } from "@/i18n";
import type { PublishSummary } from "@/lib/catalog-import-queries";
import { useState } from "react";
import { Link } from "react-router";
import { useBrowserTime } from "./importParts";
import type { StepProps } from "./stepTypes";
import { useImportPreview } from "./useCatalogImport";

export interface ResultFromPublish {
  summary: PublishSummary;
  replayed: boolean;
}

export function ResultStep({
  batch,
  fromPublish,
}: Readonly<
  Pick<StepProps, "batch"> & { fromPublish: ResultFromPublish | null }
>): React.JSX.Element {
  const t = useT();
  const time = useBrowserTime();
  const read = useImportPreview(batch.batchId, fromPublish === null, 0);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);

  let summary: PublishSummary | null = fromPublish?.summary ?? null;
  const preview = read.data;
  if (!summary && preview) {
    summary = {
      brandsCreated: preview.brandsToCreate.length,
      productsCreated: preview.productsToCreate,
      productsUpdated: preview.productsToUpdate,
      identifiersAdded: preview.identifiersToAdd,
      productsDeactivated: preview.deactivations.length,
      rowsUnchanged: preview.counts.unchanged,
      rowsExcluded: preview.counts.excluded,
    };
  }
  const stored = fromPublish === null || fromPublish.replayed;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(batch.batchId);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="import-step">
      <Banner
        variant="success"
        title={t("catalogImport.result.title")}
        message={
          batch.publishedAt
            ? t("catalogImport.result.confirmed", { time: time(batch.publishedAt) })
            : ""
        }
      />
      {stored ? (
        <Banner
          variant="info"
          title={t("catalogImport.result.replay.title")}
          message={t("catalogImport.result.replay.body")}
        />
      ) : null}

      {summary ? (
        <>
          <ul className="import-kv import-panel">
            <li>
              {t("catalogImport.result.count.created")}
              <b>{formatNumber(summary.productsCreated)}</b>
            </li>
            <li>
              {t("catalogImport.result.count.updated")}
              <b>{formatNumber(summary.productsUpdated)}</b>
            </li>
            <li>
              {t("catalogImport.result.count.identifiers")}
              <b>{formatNumber(summary.identifiersAdded)}</b>
            </li>
            <li>
              {t("catalogImport.result.count.brands")}
              <b>{formatNumber(summary.brandsCreated)}</b>
            </li>
            <li>
              {t("catalogImport.result.count.deactivated")}
              <b>{formatNumber(summary.productsDeactivated)}</b>
            </li>
            <li>
              {t("catalogImport.result.count.unchanged")}
              <b>{formatNumber(summary.rowsUnchanged)}</b>
            </li>
            <li>
              {t("catalogImport.result.count.excluded")}
              <b>{formatNumber(summary.rowsExcluded)}</b>
            </li>
          </ul>
          {summary.productsCreated > 0 ? (
            <Banner
              variant="info"
              title={t("catalogImport.result.unpriced", {
                count: formatNumber(summary.productsCreated),
              })}
              message={t("catalogImport.result.unpricedBody")}
            />
          ) : null}
        </>
      ) : read.isLoading ? (
        <ListState state="loading" />
      ) : (
        <Banner
          variant="danger"
          title={t("catalogImport.result.loadFailed.title")}
          message={t("catalogImport.result.loadFailed.body")}
          requestId={read.error?.requestId}
          action={
            <button type="button" className="btn-secondary" onClick={read.refetch}>
              {t("catalogImport.reload")}
            </button>
          }
        />
      )}

      <div className="import-panel">
        <span id="import-audit-label" className="import-step__title">
          {t("catalogImport.result.audit")}
        </span>
        <div className="import-row">
          <bdi dir="ltr" className="import-ref" aria-labelledby="import-audit-label">
            {batch.batchId}
          </bdi>
          <button type="button" className="btn-secondary" onClick={() => void copy()}>
            {t("catalogImport.result.copy")}
          </button>
        </div>
        <output className="import-step__why" aria-live="polite">
          {copied === "ok"
            ? t("catalogImport.result.copied")
            : copied === "failed"
              ? t("catalogImport.result.copyFailed")
              : ""}
        </output>
      </div>

      <div className="import-step__actions">
        <Link to="/catalog/products" className="btn-primary">
          {t("catalogImport.result.viewProducts")}
        </Link>
        <Link to="/catalog/import" className="btn-secondary">
          {t("catalogImport.result.another")}
        </Link>
      </div>
    </div>
  );
}
