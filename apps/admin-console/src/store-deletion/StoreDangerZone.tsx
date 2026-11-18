/**
 * RT-1441 (U2) — the store «danger zone» on the store detail page (RT-1437 A2): the owner's way to
 * remove a store, in the order the decision record asks for. Suspending comes FIRST, as the
 * reversible alternative («إيقاف المتجر بدلًا من حذفه يمكن التراجع عنه.»); only then «حذف المتجر…»,
 * which opens the impact preview and the guarded confirm (`StoreDeletionDialog`).
 *
 * Shown to the owner only, never inside a support session (D1). That only hides the control: the
 * server answers 403 `store_deletion_owner_only` or the uniform 404 to anyone else. Nothing is read
 * while the page loads: the preview is requested only once the dialog opens.
 */
import { Banner } from "@/components/Banner";
import { DetailPanel, PanelBody } from "@/components/DetailPanel";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { rf2QueryKeys } from "@/lib/rf2-queries";
import { SuspendConfirm } from "@/stores/SuspendConfirm";
import { useStoreStatusMutation } from "@/stores/useStoreQueries";
import { useStoreScope } from "@/stores/useStoreScope";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { StoreDeletionDialog } from "./StoreDeletionDialog";
import { canDeleteStore } from "./storeDeletionLogic";
import { isDefiniteRefusal } from "./storeDeletionOutcomes";
import "./store-deletion.css";

export interface StoreDangerZoneProps {
  storeId: string;
  storeName: string;
  isActive?: boolean;
  timeZone?: string;
}

/** The reversible alternative: suspend, with the same inline confirm that names the store as on the edit page. */
function SuspendOffer({
  storeId,
  storeName,
  isActive,
}: Readonly<Pick<StoreDangerZoneProps, "storeId" | "storeName" | "isActive">>): React.JSX.Element {
  const t = useT();
  const { activeTenantId } = useStoreScope();
  const status = useStoreStatusMutation(activeTenantId, storeId);
  const [confirming, setConfirming] = useState(false);
  // "refused": a definite 4xx, nothing changed. "unclear": 5xx, 408, 425 or no answer: the PATCH may be applied.
  const [failed, setFailed] = useState<"refused" | "unclear" | null>(null);

  if (isActive === false) {
    return <p className="store-panel-note">{t("storeDeletion.zone.alreadySuspended")}</p>;
  }

  async function suspend(): Promise<void> {
    setFailed(null);
    try {
      const res = await status.mutateAsync(false);
      if (res.status >= 400) setFailed(isDefiniteRefusal(res.status) ? "refused" : "unclear");
    } catch {
      setFailed("unclear");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <p className="store-panel-note">{t("storeDeletion.zone.suspendInstead")}</p>
      {confirming ? (
        <SuspendConfirm
          storeName={storeName}
          busy={status.isPending}
          confirmPromptKey="storeDeletion.zone.suspendConfirm"
          onConfirm={() => void suspend()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="store-panel-row">
          <button type="button" className="btn-danger-quiet" onClick={() => setConfirming(true)}>
            {t("stores.status.suspend")}
          </button>
        </div>
      )}
      {failed === null ? null : (
        <Banner
          variant="danger"
          message={t(
            failed === "refused"
              ? "storeDeletion.zone.suspendFailed"
              : "storeDeletion.zone.suspendUnclear",
          )}
        />
      )}
    </>
  );
}

function DangerZone(props: Readonly<StoreDangerZoneProps>): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  function onClose(deleted: boolean): void {
    setOpen(false);
    if (!deleted) return;
    // The store is gone: leave its page for the list, and drop its cached detail so nothing reads it again.
    navigate("/stores", { replace: true });
    qc.removeQueries({ queryKey: rf2QueryKeys.store(props.storeId) });
  }

  return (
    <>
      <DetailPanel
        id="store-danger-title"
        title={t("storeDeletion.zone.title")}
        className="store-danger"
      >
        <PanelBody>
          <div className="store-danger__body">
            <SuspendOffer
              storeId={props.storeId}
              storeName={props.storeName}
              isActive={props.isActive}
            />
            <div className="store-panel-row">
              <button type="button" className="btn-danger-quiet" onClick={() => setOpen(true)}>
                {t("storeDeletion.zone.delete")}
              </button>
            </div>
          </div>
        </PanelBody>
      </DetailPanel>
      {open ? (
        <StoreDeletionDialog storeId={props.storeId} timeZone={props.timeZone} onClose={onClose} />
      ) : null}
    </>
  );
}

export function StoreDangerZone(props: Readonly<StoreDangerZoneProps>): React.JSX.Element | null {
  const { context } = useActiveContextValue();
  if (!canDeleteStore(context?.active_role_code, Boolean(context?.support_session))) return null;
  return <DangerZone {...props} />;
}
