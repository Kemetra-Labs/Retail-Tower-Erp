/**
 * RT-455 part 1 (OD-T4): the tracking pages show only while the tenant's
 * tracked-selling switch is on. The nav does not list them otherwise; a deep
 * link reaches this gate, which says the section is not available instead of
 * rendering it.
 *
 * Fail closed: the gate's non-disclosing 404 (deployment gate off) and "off"
 * read the same, and a failed read shows why nothing is shown, with a retry.
 * Nothing here decides who may read; each page still checks its roles first.
 */
import { Banner } from "@/components/Banner";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import { trackedSellingOn } from "./trackedSellingLogic";
import { useTrackedSellingQuery } from "./useTrackedSelling";
import "../shell/surface.css";

function GateFrame({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <ListHeaderBand group={t("shell.nav.section.operations")} title={t("tracking.title")} />
      {children}
    </div>
  );
}

export function TrackingPagesGate({
  tenantId,
  role,
  children,
}: Readonly<{
  tenantId: string;
  role: string | null | undefined;
  children: React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const query = useTrackedSellingQuery(tenantId, role);
  const read = query.data;
  if (!read) return <ListState state="loading" label={t("tracking.loadingNoun")} />;
  if (trackedSellingOn(read)) return <>{children}</>;
  if (read.kind === "error") {
    return (
      <GateFrame>
        <Banner
          variant="danger"
          message={t(
            read.status === 401 ? "trackedSelling.sessionExpired" : "trackedSelling.pagesFailed",
          )}
          requestId={read.requestId}
          action={
            <button type="button" className="btn-secondary" onClick={() => void query.refetch()}>
              {t("trackedSelling.retry")}
            </button>
          }
        />
      </GateFrame>
    );
  }
  return (
    <GateFrame>
      <div
        className="inventory__panel-body inventory__panel-body--solo"
        data-testid="tracking-selling-off"
      >
        <ListState state="empty" emptyMessage={t("trackedSelling.pagesOff.title")} />
        <p className="tracking__muted">{t("trackedSelling.pagesOff.body")}</p>
      </div>
    </GateFrame>
  );
}
