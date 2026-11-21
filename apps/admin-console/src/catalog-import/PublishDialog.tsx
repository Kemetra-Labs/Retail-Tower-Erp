/**
 * RT-1509 step 6, «النشر»: the confirm modal. It names the action, the counts and the consequence;
 * focus starts on «إلغاء» (UX-05.2, UX-05.23) and Tab is trapped (`ConfirmModal`). Publishing is
 * consequential but not a deletion, so the commit is the strong neutral button (D8), not the red one.
 *
 * An unclear answer swaps the content for «لم يتأكد النشر»: the commit becomes «إعادة الإرسال» (same
 * key, same body), «تحديث الحالة» reads the batch, and the cancel button reads «إغلاق». No success
 * wording appears here: the flow leaves the modal only when the server returned the published batch.
 */
import { Banner } from "@/components/Banner";
import { ConfirmModal } from "@/components/ConfirmModal";
import { GatedButton } from "@/components/GatedButton";
import { formatNumber, useT } from "@/i18n";
import type { CatalogImportPreview } from "@/lib/catalog-import-queries";
import { errorKey } from "./catalogImportLogic";
import type { PublishFlow } from "./usePublishFlow";

export function PublishDialog({
  preview,
  flow,
}: Readonly<{ preview: CatalogImportPreview; flow: PublishFlow }>): React.JSX.Element {
  const t = useT();
  const unclear = flow.phase === "unclear" || flow.phase === "refreshing";
  const pending = flow.phase === "pending" || flow.phase === "refreshing";

  if (unclear) {
    return (
      <ConfirmModal
        title={t("catalogImport.publish.unclear.title")}
        finished={false}
        pending={flow.phase === "refreshing"}
        cancelLabel={t("catalogImport.publish.unclear.close")}
        doneLabel={t("catalogImport.publish.unclear.close")}
        commit={{
          label: t("catalogImport.publish.unclear.resend"),
          disabled: flow.wait > 0 || flow.phase === "refreshing",
          busy: false,
          onClick: () => void flow.resend(),
        }}
        commitVariant="primary"
        extraActions={
          <GatedButton
            type="button"
            className="btn-secondary"
            busy={flow.phase === "refreshing"}
            onClick={() => void flow.refresh()}
          >
            {flow.phase === "refreshing"
              ? t("catalogImport.publish.unclear.refreshing")
              : t("catalogImport.publish.unclear.refresh")}
          </GatedButton>
        }
        onClose={flow.close}
      >
        <Banner
          variant="warning"
          title={t("catalogImport.publish.unclear.heading")}
          message={
            flow.wait > 0
              ? t("catalogImport.publish.wait", { count: flow.wait })
              : flow.notPublished
                ? t("catalogImport.publish.unclear.notPublished")
                : t("catalogImport.publish.unclear.body")
          }
          requestId={flow.unclear?.requestId}
        />
      </ConfirmModal>
    );
  }

  return (
    <ConfirmModal
      title={t("catalogImport.publish.title")}
      finished={false}
      pending={pending}
      cancelLabel={t("catalogImport.publish.cancel")}
      doneLabel={t("catalogImport.publish.cancel")}
      commit={{
        label: pending ? t("catalogImport.publish.busy") : t("catalogImport.publish.confirm"),
        disabled: false,
        busy: pending,
        onClick: () => void flow.publish(preview),
      }}
      commitVariant="primary"
      onClose={flow.close}
    >
      <p className="confirm-modal__consequence">{t("catalogImport.publish.body")}</p>
      <ul className="import-kv import-modal-counts">
        <li>
          {t("catalogImport.publish.count.create")}
          <b>{formatNumber(preview.productsToCreate)}</b>
        </li>
        <li>
          {t("catalogImport.publish.count.update")}
          <b>{formatNumber(preview.productsToUpdate)}</b>
        </li>
        <li>
          {t("catalogImport.publish.count.identifiers")}
          <b>{formatNumber(preview.identifiersToAdd)}</b>
        </li>
        <li>
          {t("catalogImport.publish.count.brands")}
          <b>{formatNumber(preview.brandsToCreate.length)}</b>
        </li>
        <li>
          {t("catalogImport.publish.count.deactivated")}
          <b>{formatNumber(preview.deactivations.length)}</b>
        </li>
      </ul>
      <p className="import-step__why">{t("catalogImport.publish.consequence")}</p>
      {pending ? (
        <output aria-busy="true">
          <b>{t("catalogImport.publish.inFlight")}</b>
        </output>
      ) : null}
      {flow.refusal ? (
        <Banner
          variant="danger"
          message={t(errorKey(flow.refusal.code, flow.refusal.status))}
          requestId={flow.refusal.requestId}
        />
      ) : null}
    </ConfirmModal>
  );
}
