/**
 * RT-974 — the sale's ERPNext posting failure, as a banner under the page
 * header (DESIGN.md §8). RT-1009: the v4 shape (a red strip at the inline
 * start) comes from the `sale-erp-failure` wrapper.
 *
 * RT-1072 (RT-977 §7, §10 slice 2): with `erpPostingFailure` the banner says
 * why, in the order What → Safety → Action → Evidence, one banner per failed
 * posting (the sale's first):
 *   - What: which posting was not made, and the cause by `rejectionCategory`;
 *   - Safety: the sale stays recorded; repair does not change it;
 *   - Action: by the server's `disclosure` and `repair` handle, never the
 *     client role. `category_only` (store_manager) is told who can repair;
 *     `full` with a handle gets "Send to ERPNext again" behind a confirmation
 *     (`repairPosting`, src/posting-repair/); `reconciliation_required` is
 *     never offered a repair;
 *   - Evidence: when posting stopped, and the stored ERPNext message under
 *     `full` only, as plain text in `<bdi>`. The message is never logged, put
 *     in a URL, exported or sent to telemetry.
 * A server without the field gets the RT-974 state-only banner, unchanged; a
 * failed side the probe did not find says the posting changed.
 *
 * The ERPNext connection link stays for the roles that can open it, so no role
 * is sent to a dead destination.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { canReadErpStatus } from "@/erp-status/erpStatusLogic";
import { DateTime, type T, useT } from "@/i18n";
import type { SaleDetail } from "@/lib/sale-queries";
import { type SideView, failureViews } from "@/posting-repair/postingFailureLogic";
import { type PostingRepairState, usePostingRepair } from "@/posting-repair/usePostingRepair";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { erpStateKey } from "./saleLogic";
import { useSaleScope } from "./useSales";

type DetailView = Extract<SideView, { kind: "detail" }>;

function ErpLink({ role }: Readonly<{ role: string | null }>): React.JSX.Element | null {
  const t = useT();
  if (!canReadErpStatus(role)) return null;
  return (
    <Link to="/erp-connection" className="btn-secondary">
      {t("erp.nav.label")}
    </Link>
  );
}

function causeOf(t: T, view: DetailView): string {
  return view.document ? t(view.causeKey, view.document) : t(view.causeKey);
}

/** The RT-974 banner: the state only (an older server), or the state and "changed, refresh". */
function StateOnly({
  view,
  role,
}: Readonly<{ view: SideView; role: string | null }>): React.JSX.Element {
  const t = useT();
  const evidence = t("sales.erpFailure.evidence", {
    field: t(view.fieldKey),
    state: t(erpStateKey({ erpPostingState: "failed" })),
  });
  return (
    <Banner
      variant="danger"
      title={t(view.whatKey)}
      message={view.kind === "changed" ? `${evidence} ${t("postingRepair.changed")}` : evidence}
      action={<ErpLink role={role} />}
    />
  );
}

function Actions({
  view,
  role,
  repair,
  onSend,
  opener,
}: Readonly<{
  view: DetailView;
  role: string | null;
  repair: PostingRepairState;
  onSend: () => void;
  opener: React.RefObject<HTMLButtonElement | null>;
}>): React.JSX.Element {
  const t = useT();
  if (view.disclosure === "category_only") {
    return (
      <>
        <span>{t("postingRepair.action.categoryOnly")}</span>
        <ErpLink role={role} />
      </>
    );
  }
  return (
    <>
      {view.workItemRef ? (
        <button
          ref={opener}
          type="button"
          className="btn-primary"
          disabled={repair.pending !== undefined}
          onClick={onSend}
        >
          {t("postingRepair.action.send")}
        </button>
      ) : null}
      {view.mappingHint ? <span>{t("postingRepair.action.mappingHint")}</span> : null}
      <ErpLink role={role} />
    </>
  );
}

function Confirmation({
  view,
  repair,
  onClose,
}: Readonly<{ view: DetailView; repair: PostingRepairState; onClose: () => void }>) {
  const t = useT();
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmButton.current?.focus(), []);
  const pending = repair.pending === view.side;
  const send = async () => {
    if (view.workItemRef) await repair.confirm(view.side, view.workItemRef);
    onClose();
  };
  return (
    <section className="surface__confirm" aria-label={t("postingRepair.confirm.label")}>
      <p className="surface__confirm-msg">
        {t(view.side === "sale" ? "postingRepair.confirm.sale" : "postingRepair.confirm.reversal")}
      </p>
      <div className="surface__confirm-actions">
        <GatedButton
          ref={confirmButton}
          className="btn-primary"
          busy={pending}
          onClick={() => void send()}
        >
          {t("postingRepair.confirm.submit")}
        </GatedButton>
        <button type="button" className="btn-ghost" disabled={pending} onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
      {pending ? (
        <output className="content__sub" aria-live="polite">
          {t("postingRepair.sending")}
        </output>
      ) : null}
    </section>
  );
}

function Evidence({
  view,
  timeZone,
}: Readonly<{ view: DetailView; timeZone: string }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="sale-erp-failure__evidence">
      <p>
        {t.rich("postingRepair.evidence.stoppedAt", {
          time: <DateTime value={view.deadLetteredAt} timeZone={timeZone} />,
        })}
      </p>
      {view.reason ? (
        <p>
          {t.rich("postingRepair.evidence.reason", {
            reason: <bdi dir="auto">{view.reason}</bdi>,
          })}
        </p>
      ) : null}
    </div>
  );
}

function FailureDetail({
  view,
  role,
  repair,
  timeZone,
}: Readonly<{
  view: DetailView;
  role: string | null;
  repair: PostingRepairState;
  timeZone: string;
}>): React.JSX.Element {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setConfirming(false);
    opener.current?.focus();
  };
  return (
    <>
      <Banner
        variant="danger"
        title={t(view.whatKey)}
        message={`${causeOf(t, view)} ${t("postingRepair.safety")}`}
        action={
          <Actions
            view={view}
            role={role}
            repair={repair}
            opener={opener}
            onSend={() => {
              repair.reset();
              setConfirming(true);
            }}
          />
        }
      />
      {confirming && view.workItemRef ? (
        <Confirmation view={view} repair={repair} onClose={close} />
      ) : null}
      <Evidence view={view} timeZone={timeZone} />
    </>
  );
}

/** Nothing holds focus: the element that had it was removed. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * The server's answer to the last repair, until the next one starts. It stays
 * when the posting is no longer failed after the detail is read again.
 */
function RepairOutcome({ repair }: Readonly<{ repair: PostingRepairState }>) {
  const t = useT();
  const holder = useRef<HTMLDivElement>(null);
  const { outcome } = repair;
  useEffect(() => {
    if (outcome && focusIsLost()) holder.current?.focus();
  }, [outcome]);
  if (!outcome) return null;
  const { result, side } = outcome;
  const message = result.documentRef
    ? t(result.messageKey, { ref: result.documentRef })
    : t(result.messageKey);
  return (
    <div ref={holder} tabIndex={-1} className="sale-erp-failure__outcome">
      <Banner
        variant={result.variant}
        title={t(side === "sale" ? "sales.erp.sale" : "sales.erp.reversal")}
        message={message}
        requestId={result.requestId}
        action={
          repair.canRetry ? (
            <GatedButton
              className="btn-secondary"
              busy={repair.pending !== undefined}
              onClick={() => void repair.retry()}
            >
              {t("postingRepair.retry")}
            </GatedButton>
          ) : undefined
        }
      />
    </div>
  );
}

export function ErpFailureBanner({
  detail,
  role,
}: Readonly<{ detail: SaleDetail; role: string | null }>): React.JSX.Element | null {
  const scope = useSaleScope();
  const repair = usePostingRepair({ scope, saleRef: detail.summary.saleRef });
  const views = failureViews(detail);
  if (views.length === 0 && !repair.outcome) return null;
  return (
    <div className="sale-erp-failure">
      {views.map((view) =>
        view.kind === "detail" ? (
          <FailureDetail
            key={view.side}
            view={view}
            role={role}
            repair={repair}
            timeZone={detail.storeTimezone}
          />
        ) : (
          <StateOnly key={view.side} view={view} role={role} />
        ),
      )}
      <RepairOutcome repair={repair} />
    </div>
  );
}
