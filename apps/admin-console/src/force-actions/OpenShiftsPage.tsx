/**
 * RT-1440 (U1) — The open shifts of one store (RT-1437 A1, D6): every shift still open with the
 * SERVER's verdict and its reason as persistent text (UX-05.14, UX-11.11), and, for an eligible
 * shift, the `.btn-danger-quiet` that opens the close-without-a-count dialog. The control is hidden
 * unless the caller is an owner or tenant_admin and not in a support session (AC4); the server
 * stays authoritative and answers the uniform 404 to anyone else, shown as "not available".
 * Nothing here judges a shift: eligible, stale and blockers are the server's fields.
 */
import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { TrustBadge } from "@/devices/DeviceParts";
import { DateTime, useT } from "@/i18n";
import type { OpenShiftSummary } from "@/lib/force-action-queries";
import { useSupportSession } from "@/platform/session/useSupportSession";
import { useStoreOf } from "@/shift-closes/useShiftCloses";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ForceCloseDialog } from "./ForceCloseDialog";
import { canForceClose } from "./forceCloseLogic";
import { blockerKeys } from "./forceCloseOutcomes";
import { useOpenShifts } from "./useForceActions";
import "../shell/surface.css";
import "./force-actions.css";

function Verdict({ shift }: Readonly<{ shift: OpenShiftSummary }>): React.JSX.Element {
  const t = useT();
  if (shift.verdict.eligible) return <>{t("forceActions.openShifts.verdict.eligible")}</>;
  return (
    <>
      {t("forceActions.openShifts.verdict.blocked")}
      <ul className="open-shifts__verdict-list">
        {blockerKeys(shift.verdict.blockers).map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </>
  );
}

interface RowProps {
  shift: OpenShiftSummary;
  timeZone?: string;
  canClose: boolean;
  onClose: (shiftId: string, opener: HTMLButtonElement) => void;
}

function Row({ shift, timeZone, canClose, onClose }: Readonly<RowProps>): React.JSX.Element {
  const t = useT();
  const terminal = shift.terminal.label ?? t("forceActions.openShifts.terminal.none");
  return (
    <tr>
      <td>
        <bdi dir="auto">{terminal}</bdi> <TrustBadge trustState={shift.terminal.trustState} />
        <br />
        <small className="device-quiet">
          {shift.terminal.lastSeenAt === null
            ? t("forceActions.openShifts.neverSeen")
            : t.rich("forceActions.openShifts.lastSeen", {
                time: (
                  <bdi dir="ltr">
                    <DateTime value={shift.terminal.lastSeenAt} timeZone={timeZone} />
                  </bdi>
                ),
              })}
        </small>
      </td>
      <td>
        <bdi dir="auto">
          {shift.cashier.displayName ?? t("forceActions.openShifts.cashier.none")}
        </bdi>
      </td>
      <td>
        <bdi dir="ltr">
          <DateTime value={shift.openedAt} timeZone={timeZone} />
        </bdi>
        <br />
        <small className="device-quiet">
          {t("forceActions.openShifts.age", { count: shift.ageMinutes })}
        </small>
      </td>
      <td>
        <Verdict shift={shift} />
      </td>
      <td className="open-shifts__action-cell">
        {canClose && shift.verdict.eligible ? (
          <button
            type="button"
            className="btn-danger-quiet"
            aria-label={t("forceActions.openShifts.openLabel", { terminal })}
            onClick={(e) => onClose(shift.shiftId, e.currentTarget)}
          >
            {t("forceActions.openShifts.open")}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

export function OpenShiftsPage(): React.JSX.Element {
  const t = useT();
  const { storeId } = useParams();
  const { context } = useActiveContextValue();
  const supportSession = useSupportSession();
  const store = useStoreOf(storeId);
  const shifts = useOpenShifts(storeId);
  const [closing, setClosing] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef<"opener" | "heading" | null>(null);

  // When the dialog is gone, focus goes back to the button that opened it, or, after a recorded
  // close removed that row (or when the button no longer exists), to the page heading (UX-11.8).
  useEffect(() => {
    if (closing !== null || restoreFocus.current === null) return;
    const target =
      restoreFocus.current === "opener" && opener.current?.isConnected
        ? opener.current
        : titleRef.current;
    restoreFocus.current = null;
    target?.focus();
  }, [closing]);
  const canClose = canForceClose(context?.active_role_code, supportSession !== null);

  const header = (
    <PageHeader
      titleRef={titleRef}
      title={t("forceActions.openShifts.title")}
      subtitle={t("forceActions.openShifts.sub", { store: store.name ?? "" })}
    />
  );

  return (
    <div className="surface">
      {storeId ? (
        <Link to={`/stores/${storeId}`} className="surface__back">
          <BackArrow /> {store.name ?? ""}
        </Link>
      ) : null}
      {header}
      {shifts.isLoading ? (
        <output className="content__sub">
          <span className="spinner" aria-hidden="true" /> {t("forceActions.openShifts.loading")}
        </output>
      ) : null}
      {shifts.error ? (
        <Banner
          variant="danger"
          message={t(
            shifts.error.kind === "not-available"
              ? "forceActions.openShifts.notAvailable"
              : "forceActions.openShifts.loadFailed",
          )}
          requestId={shifts.error.requestId}
          action={
            shifts.error.kind === "failed" ? (
              <button type="button" className="btn-secondary" onClick={shifts.refetch}>
                {t("forceActions.openShifts.retry")}
              </button>
            ) : undefined
          }
        />
      ) : null}
      {shifts.data && shifts.data.items.length === 0 ? (
        <p>{t("forceActions.openShifts.empty")}</p>
      ) : null}
      {shifts.data && shifts.data.items.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">{t("forceActions.openShifts.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("forceActions.openShifts.col.terminal")}</th>
                <th scope="col">{t("forceActions.openShifts.col.cashier")}</th>
                <th scope="col">{t("forceActions.openShifts.col.opened")}</th>
                <th scope="col">{t("forceActions.openShifts.col.verdict")}</th>
                <th scope="col">
                  <span className="sr-only">{t("forceActions.openShifts.open")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shifts.data.items.map((shift) => (
                <Row
                  key={shift.shiftId}
                  shift={shift}
                  timeZone={store.timeZone}
                  canClose={canClose}
                  onClose={(id, button) => {
                    opener.current = button;
                    setClosing(id);
                  }}
                />
              ))}
            </tbody>
          </table>
          <p className="device-quiet">
            {t.rich("forceActions.openShifts.snapshot", {
              time: (
                <bdi dir="ltr">
                  <DateTime value={shifts.data.evaluatedAt} timeZone={store.timeZone} />
                </bdi>
              ),
            })}
          </p>
        </div>
      ) : null}
      {closing ? (
        <ForceCloseDialog
          shiftId={closing}
          timeZone={store.timeZone}
          onClose={(recorded) => {
            restoreFocus.current = recorded ? "heading" : "opener";
            setClosing(null);
          }}
        />
      ) : null}
    </div>
  );
}
