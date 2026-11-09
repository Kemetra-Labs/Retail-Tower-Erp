import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { DetailGrid, DetailPanel, PanelBody } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { useSupportSession } from "@/platform/session/useSupportSession";
import { Link } from "react-router";
import {
  BeforeInstallPanel,
  InstallPanel,
  ProductFacts,
  ReleaseLedger,
  VerifyPanel,
} from "./DownloadPosPanels";
import type { DownloadState } from "./downloadPosLogic";
import { useDeviceScope } from "./useDevices";
import { useDownloadPos } from "./useDownloadPos";
import "../shell/surface.css";
import "./devices.css";
import "./downloadPos.css";

/**
 * RT-1304 — Devices → Download POS (spec RT-1302 §4-§9). A pilot-only page: one explicit
 * click asks Backend-Core for the current pilot installer and hands the short-lived link
 * to the browser. It shows only that a link was ISSUED: the Console cannot see the
 * download start or finish, and the page grants no device trust. The resolver is never
 * called on open, never for a role outside the device roles, and never in a support
 * session (O-2: the page then reads «not available to you», with no call).
 */

/** The banner for every outcome that is not success; success has its own status line. */
function Outcome({
  state,
  secondsLeft,
  onRetry,
}: Readonly<{
  state: DownloadState;
  secondsLeft: number;
  onRetry: () => void;
}>): React.JSX.Element | null {
  const t = useT();
  const retry = (
    <button type="button" className="btn-secondary" onClick={onRetry}>
      {t("devices.download.retry")}
    </button>
  );
  switch (state.kind) {
    case "unavailable":
      return <Banner variant="info" message={t("devices.download.unavailable")} />;
    case "session":
      return (
        <Banner
          variant="danger"
          message={t("devices.list.sessionExpired")}
          requestId={state.requestId}
        />
      );
    case "not-found":
      return <Banner variant="info" message={t("devices.download.notAllowed")} />;
    case "support-session":
      return (
        <Banner
          variant="warning"
          title={t("platform.session.expiredBody.title")}
          message={t("platform.session.expiredBody.body")}
          requestId={state.requestId}
        />
      );
    case "rate-limited":
      return (
        <Banner
          variant="warning"
          message={t("devices.download.rateLimited", {
            wait: t("devices.download.seconds", { count: secondsLeft }),
          })}
        />
      );
    case "failure":
      return (
        <Banner
          variant="danger"
          message={t("devices.download.failed")}
          requestId={state.requestId}
          action={retry}
        />
      );
    case "network":
      return <Banner variant="danger" message={t("devices.download.network")} action={retry} />;
    default:
      return null;
  }
}

function NotAvailable(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <Link to="/devices" className="surface__back">
        <BackArrow /> {t("devices.codes.back")}
      </Link>
      <ListState state="empty" emptyMessage={t("devices.download.notAllowed")} />
    </div>
  );
}

export function DownloadPos(): React.JSX.Element {
  const t = useT();
  const scope = useDeviceScope();
  const { context } = useActiveContextValue();
  const inSession = useSupportSession() !== null;
  const { state, secondsLeft, allowed, activate } = useDownloadPos(scope, inSession);

  if (inSession) return <NotAvailable />;
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("devices.list.scopePrompt")}</p>
      </div>
    );
  }
  if (!allowed) return <NotAvailable />;

  const busy = state.kind === "busy";
  return (
    <div className="surface">
      <Link to="/devices" className="surface__back">
        <BackArrow /> {t("devices.codes.back")}
      </Link>
      <PageHeader
        title={
          <>
            {t("devices.download.title")}
            <span className="badge download-pos__badge">{t("devices.download.badge")}</span>
          </>
        }
        subtitle={t("devices.download.sub")}
      />
      {(context?.memberships?.length ?? 0) > 1 ? (
        <p className="content__sub">{t("devices.download.multiTenant")}</p>
      ) : null}
      <DetailPanel id="download-main" title={t("devices.download.panel.download")}>
        <PanelBody>
          <ProductFacts />
          <div className="download-pos__action">
            <GatedButton
              type="button"
              className="btn-primary"
              busy={busy}
              disabled={state.kind === "rate-limited"}
              onClick={() => void activate()}
            >
              {busy ? t("devices.download.busy") : t("devices.download.action")}
            </GatedButton>
            <p className="download-pos__help">{t("devices.download.actionHelp")}</p>
          </div>
          <output className="download-pos__status">
            {state.kind === "issued" ? t("devices.download.issued") : ""}
          </output>
          {state.kind === "issued" ? <ReleaseLedger facts={state.facts} /> : null}
          <Outcome state={state} secondsLeft={secondsLeft} onRetry={() => void activate()} />
        </PanelBody>
      </DetailPanel>
      <DetailGrid>
        <BeforeInstallPanel />
        <VerifyPanel />
      </DetailGrid>
      <InstallPanel />
    </div>
  );
}
