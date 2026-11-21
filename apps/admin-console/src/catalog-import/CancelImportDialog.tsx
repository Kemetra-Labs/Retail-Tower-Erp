/**
 * RT-1509: «إلغاء الاستيراد». The cancel closes the open batch (the mapping and recorded decisions go;
 * the catalogue is untouched), so it is a real modal (UX-11.9) whose focus starts on the safe choice
 * «إبقاء الاستيراد» (UX-05.11). `expectedVersion` is the batch version the caller last read; a
 * `409 version_conflict` re-reads the batch and says so.
 */
import { Banner } from "@/components/Banner";
import { ConfirmModal } from "@/components/ConfirmModal";
import { useT } from "@/i18n";
import { type CatalogImportBatch, consoleCancelCatalogImport } from "@/lib/catalog-import-queries";
import { useState } from "react";
import { type ImportOutcome, errorKey } from "./catalogImportLogic";
import { outcomeOf } from "./importParts";

export function CancelImportDialog({
  batch,
  onClose,
  onCancelled,
  onStale,
}: Readonly<{
  batch: CatalogImportBatch;
  onClose: () => void;
  /** The server closed the batch (the answer is the cancelled batch). */
  onCancelled: (batch: CatalogImportBatch) => void;
  /** The batch changed elsewhere: the caller re-reads it. */
  onStale: () => void;
}>): React.JSX.Element {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Exclude<ImportOutcome<unknown>, { kind: "ok" }> | null>(
    null,
  );

  async function cancel(): Promise<void> {
    setPending(true);
    setFailure(null);
    const outcome = await outcomeOf(() => consoleCancelCatalogImport(batch.batchId, batch.version));
    setPending(false);
    if (outcome.kind === "ok") {
      onCancelled(outcome.data);
      return;
    }
    if (outcome.kind === "refused" && outcome.code === "version_conflict") onStale();
    setFailure(outcome);
  }

  return (
    <ConfirmModal
      title={t("catalogImport.cancelDialog.title")}
      finished={false}
      pending={pending}
      cancelLabel={t("catalogImport.cancelDialog.keep")}
      doneLabel={t("catalogImport.cancelDialog.keep")}
      commit={{
        label: pending
          ? t("catalogImport.cancelDialog.busy")
          : t("catalogImport.cancelDialog.confirm"),
        disabled: false,
        busy: pending,
        onClick: () => void cancel(),
      }}
      onClose={onClose}
    >
      <p className="confirm-modal__consequence">{t("catalogImport.cancelDialog.body")}</p>
      {failure ? (
        <Banner
          variant="danger"
          message={t(
            failure.kind === "refused"
              ? errorKey(failure.code, failure.status)
              : errorKey(undefined, failure.status),
          )}
          requestId={failure.requestId}
        />
      ) : null}
    </ConfirmModal>
  );
}
