/**
 * RT-1509 (D2, G1): the 409 `import_batch_open` card. The contract has no "find the open batch"
 * read, so the only way to know of it is the id the refusal carries. The card reads that batch and
 * offers to resume it (the route carries the batch id) or cancel it. Nothing is guessed: the facts
 * are the batch the server returned.
 */
import { Banner } from "@/components/Banner";
import { ListState } from "@/components/ListState";
import { type MessageKey, useT } from "@/i18n";
import type { CatalogImportBatch } from "@/lib/catalog-import-queries";
import { useState } from "react";
import { useNavigate } from "react-router";
import { CancelImportDialog } from "./CancelImportDialog";
import { useBrowserTime } from "./importParts";
import { useBatchCache, useImportBatch } from "./useCatalogImport";

export function OpenBatchCard({
  batchId,
  onClosed,
}: Readonly<{ batchId: string; onClosed: () => void }>): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const read = useImportBatch(batchId);
  const cache = useBatchCache(batchId);
  const time = useBrowserTime();
  const [cancelling, setCancelling] = useState(false);

  if (read.isLoading) return <ListState state="loading" />;
  if (!read.data) {
    return (
      <Banner
        variant="danger"
        message={t("catalogImport.open.loadFailed")}
        requestId={read.error?.requestId}
        action={
          <button type="button" className="btn-secondary" onClick={read.refetch}>
            {t("catalogImport.reload")}
          </button>
        }
      />
    );
  }
  const batch: CatalogImportBatch = read.data;
  return (
    <section className="import-panel" aria-labelledby="import-open-title">
      <h2 id="import-open-title" className="import-step__title">
        {t("catalogImport.open.title")}
      </h2>
      <p>{t("catalogImport.open.body")}</p>
      <ul className="import-kv">
        <li>
          {t("catalogImport.open.file")}
          <b>
            <bdi dir="ltr">{batch.file.name ?? "—"}</bdi>
          </b>
        </li>
        <li>
          {t("catalogImport.open.state")}
          <b>{t(`catalogImport.state.${batch.state}` as MessageKey)}</b>
        </li>
        <li>
          {t("catalogImport.open.updated")}
          <b>{time(batch.updatedAt)}</b>
        </li>
        {batch.expiresAt ? (
          <li>
            {t("catalogImport.open.expires")}
            <b>{time(batch.expiresAt)}</b>
          </li>
        ) : null}
      </ul>
      <div className="import-step__actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => navigate(`/catalog/import/${batch.batchId}`)}
        >
          {t("catalogImport.open.resume")}
        </button>
        <button type="button" className="btn-danger-quiet" onClick={() => setCancelling(true)}>
          {t("catalogImport.cancel.action")}
        </button>
      </div>
      {cancelling ? (
        <CancelImportDialog
          batch={batch}
          onClose={() => setCancelling(false)}
          onStale={() => void cache.reread()}
          onCancelled={() => {
            setCancelling(false);
            onClosed();
          }}
        />
      ) : null}
    </section>
  );
}
