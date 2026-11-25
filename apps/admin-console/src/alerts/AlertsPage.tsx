/**
 * The alerts screen: the Overview's attention ledger on its own page, so the
 * work waiting in the current scope is one destination instead of one panel
 * among many. Same reads, same role rules, same manual refresh: nothing new
 * is asked of Backend-Core. The Overview links here from the ledger's head.
 */
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { AttentionLedger } from "@/overview/AttentionLedger";
import { OverviewRefreshButton, useOverviewRefresh } from "@/overview/OverviewPanels";
import { useOverviewSession } from "@/overview/useOverviewPanels";
import "../shell/surface.css";
import "../overview/overview.css";

export function AlertsPage(): React.JSX.Element {
  const t = useT();
  const session = useOverviewSession();
  const clock = useOverviewRefresh();
  const { context } = useActiveContextValue();
  const tenant = <bdi>{context?.active_tenant?.name}</bdi>;
  const subtitle = context?.active_store
    ? t.rich("shell.overview.scope", {
        tenant,
        store: <bdi>{context.active_store.name}</bdi>,
      })
    : tenant;

  if (!session.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("alerts.scopePrompt")}</p>
      </div>
    );
  }
  return (
    <div className="surface surface--v4 alerts-surface">
      <PageHeader
        title={t("alerts.title")}
        documentTitle={t("alerts.title")}
        subtitle={subtitle}
        actions={<OverviewRefreshButton onRefresh={clock.refresh} />}
      />
      <AttentionLedger session={session} nowMs={clock.value} />
    </div>
  );
}
