/**
 * RT-993 Overview v4 (DESIGN.md §12.4, D-V7; board «✓ المعتمد · نظرة عامة v9»):
 * the greeting header with Refresh and the pipeline rail under it; a main
 * column with the receipt row, the trend beside today's posting ring, and the
 * latest sales; a side column with quick actions, the attention list and the
 * «قريبًا» frames. The reads are RT-970's, unchanged in kind.
 *
 * RT-970 Overview v2 (owner-approved canvas «المختار · A + مسار C», 2026-10-30):
 * the page header with Refresh, then the KPI ledger strip, the pipeline strip,
 * the 14-day trend beside the attention list, and the latest sales. Every
 * figure is an existing read (`useGlancePanels.ts`); nothing new is asked of
 * Backend-Core. Note: the latest-sales read is `consoleListSales`, which
 * records a `console_sales.listed` audit event per load and Refresh, as the
 * Sales screen does.
 *
 * RT-559 the Overview's panels under the scope line (spec 009 v1: P-1…P-4).
 * Nothing renders and nothing is read without an active tenant (AC-2). Reads
 * happen on load and on scope change (the shell remounts the route per scope,
 * and every key carries the scope), plus one manual refresh (NG-7: no polling).
 * RT-820's per-store "today" rows (P-6) gave way to the KPI strip (RT-970).
 * Recent activity (P-5) is deferred until Backend-Core can leave read-only audits out (OD-009-3,
 * RT-567): owner and tenant_admin get a plain link to `/audit` instead (AC-10).
 */
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AttentionLedger } from "./AttentionLedger";
import { PostingPanel } from "./PostingPanel";
import { ReceiptRow } from "./ReceiptRow";
import { RecentSales } from "./RecentSales";
import { SaleRail } from "./SaleRail";
import { SideColumn } from "./SideColumn";
import { TrendPanel } from "./TrendPanel";
import { canOpenAudit } from "./overviewLogic";
import { useActiveDevices, useGlanceSummary, useRecentSales } from "./useGlancePanels";
import { type OverviewSession, useOverviewSession } from "./useOverviewPanels";
import { OVERVIEW_KEY } from "./usePanelQuery";
import "./overview.css";

/**
 * One manual re-read of every panel. While it runs the button stays focusable
 * (`aria-disabled`, not `disabled`, which would drop keyboard focus) and ignores
 * presses; a polite status line announces it.
 */
function RefreshButton({ onRefresh }: Readonly<{ onRefresh: () => void }>): React.JSX.Element {
  const t = useT();
  const fetching = useIsFetching({ queryKey: OVERVIEW_KEY }) > 0;
  const refresh = () => {
    if (!fetching) onRefresh();
  };
  return (
    <>
      <button
        type="button"
        className="btn-secondary overview__refresh"
        aria-disabled={fetching}
        onClick={refresh}
      >
        {fetching ? t("overview.refreshing") : t("overview.refresh")}
      </button>
      <output className="sr-only">{fetching ? t("overview.refreshing") : ""}</output>
    </>
  );
}

/**
 * The time the date-bound read (P-2's window) is computed from: load, then each
 * Refresh. The re-read runs after the new time commits, so a query whose key
 * moved (a new day's window) fetches once on its own, and an in-flight read is
 * joined rather than repeated; the old day's window is never re-read.
 */
function useRefresh(): { value: number; refresh: () => void } {
  const qc = useQueryClient();
  const [state, setState] = useState(() => ({ value: Date.now(), tick: 0 }));
  useEffect(() => {
    if (state.tick === 0) return;
    void qc.refetchQueries({ queryKey: OVERVIEW_KEY, type: "active" }, { cancelRefetch: false });
  }, [qc, state.tick]);
  const refresh = () => setState((s) => ({ value: Date.now(), tick: s.tick + 1 }));
  return { value: state.value, refresh };
}

function Panels({
  session,
  nowMs,
  scope,
  header,
}: Readonly<{
  session: OverviewSession;
  nowMs: number;
  scope: React.ReactNode;
  header: (rail: React.ReactNode) => React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const summary = useGlanceSummary(session, nowMs);
  const devices = useActiveDevices(session);
  const recent = useRecentSales(session, nowMs);
  return (
    <>
      {header(<SaleRail session={session} summary={summary} devices={devices} />)}
      <div className="overview">
        <div className="overview__main">
          <ReceiptRow state={summary} scope={scope} />
          <div className="overview__charts">
            <TrendPanel state={summary} />
            <PostingPanel state={summary} />
          </div>
          <RecentSales state={recent} />
          {canOpenAudit(session.role) ? (
            <p className="overview__related">
              <Link className="ledger__link" to="/audit">
                {t("shell.nav.audit")}
              </Link>
            </p>
          ) : null}
        </div>
        <SideColumn
          role={session.role}
          attention={<AttentionLedger session={session} nowMs={nowMs} />}
        />
      </div>
    </>
  );
}

export interface OverviewPanelsProps {
  /** The greeting `<h1>` (DESIGN.md §12.3), or the page name without a user name. */
  title: React.ReactNode;
  subtitle: React.ReactNode;
  /** The scope the figures cover: the active store's name, or all stores. */
  scope: React.ReactNode;
}

/** The page: header first; the panels only once a tenant is active (AC-2). */
export function OverviewPanels({
  title,
  subtitle,
  scope,
}: Readonly<OverviewPanelsProps>): React.JSX.Element {
  const session = useOverviewSession();
  const clock = useRefresh();
  const active = session.tenantId !== null;
  const header = (rail: React.ReactNode) => (
    <PageHeader
      title={title}
      subtitle={subtitle}
      actions={active ? <RefreshButton onRefresh={clock.refresh} /> : null}
    >
      {rail}
    </PageHeader>
  );
  return (
    <div className="surface">
      {active ? (
        <Panels session={session} nowMs={clock.value} scope={scope} header={header} />
      ) : (
        header(null)
      )}
    </div>
  );
}
