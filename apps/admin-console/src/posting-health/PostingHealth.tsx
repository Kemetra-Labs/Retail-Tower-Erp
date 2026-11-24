/**
 * The posting-health report: for each business day in the default range
 * (the last 7 completed days plus today), the served `erpPosting` counts and
 * the day's verdict, in words. Thin v1: no range form, no CSV export — those
 * are follow-ups if the report is used.
 *
 * The data is the same `consoleGetSalesSummary` read as the daily report,
 * so the range, the scope and the failure rules are the daily report's.
 * Sales-by-hour stays proposed: no contract serves hourly buckets, and
 * deriving hours client-side would stitch paged reads (RT-751 AC 4).
 */
import { BackArrow, Banner, GatedButton, ListHeaderBand } from "@/components";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type { SalesSummaryErrorRender } from "@/lib/sales-summary-queries";
import { canReadErpStatus } from "@/erp-status/erpStatusLogic";
import { Notice, Unavailable } from "@/sales/SalePager";
import { type SaleScope, useSaleScope } from "@/sales/useSales";
import { buildSummaryQuery, defaultRange, reportModel } from "@/sales-daily/dailyLogic";
import type { StoreDirectory } from "@/shift-closes/useShiftCloses";
import { useStoreDirectory } from "@/shift-closes/useShiftCloses";
import { Link } from "react-router";
import { PostingHealthTable } from "./PostingHealthTable";
import { postingHealthModel } from "./postingHealthLogic";
import { usePostingHealth } from "./usePostingHealth";
import "./posting-health.css";
import "../shell/surface.css";

function proposalZones(scope: SaleScope, directory: StoreDirectory): string[] {
  if (scope.activeStoreId) return [directory.timeZoneOf(scope.activeStoreId) ?? "UTC"];
  return directory.stores.map((s) => s.timezone ?? "UTC");
}

function Shell({
  subtitle,
  children,
}: Readonly<{ subtitle: string; children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface surface--v4 posting-surface">
      <nav className="back-links" aria-label={t("sales.backList")}>
        <Link to="/reports" className="back-links__link">
          <BackArrow />
          {t("reports.nav.label")}
        </Link>
        <Link to="/erp-connection" className="back-links__link">
          <BackArrow />
          {t("erp.nav.label")}
        </Link>
      </nav>
      <ListHeaderBand
        group={t("reports.group.erp")}
        title={t("reports.item.postingHealth.title")}
        subtitle={subtitle}
      />
      {children}
    </div>
  );
}

function Loading(): React.JSX.Element {
  const t = useT();
  return <ListState state="loading" label={t("postingHealth.loading")} />;
}

function Failure({
  error,
  retry,
}: Readonly<{ error: SalesSummaryErrorRender; retry: () => void }>): React.JSX.Element {
  const t = useT();
  if (error.kind === "not-found") return <Unavailable />;
  if (error.kind === "rate-limited") {
    return (
      <Notice
        tone="warning"
        heading={t("postingHealth.rateLimited")}
        body={t("postingHealth.rateLimitedHint")}
      />
    );
  }
  return (
    <Banner kind="danger" title={t("postingHealth.failed")}>
      <GatedButton type="button" onClick={retry}>
        {t("postingHealth.retry")}
      </GatedButton>
    </Banner>
  );
}

function Body({
  range,
  health,
}: Readonly<{
  range: ReturnType<typeof defaultRange> | null;
  health: ReturnType<typeof usePostingHealth>;
}>): React.JSX.Element {
  const model =
    health.summary && !health.isLoading && !health.error
      ? postingHealthModel(reportModel(health.summary))
      : null;
  if (range === null || health.isLoading) return <Loading />;
  if (health.error) return <Failure error={health.error} retry={health.retry} />;
  if (!model) return null;
  return <PostingHealthTable model={model} />;
}

export function PostingHealth(): React.JSX.Element {
  const t = useT();
  const scope = useSaleScope();
  const permitted = canReadErpStatus(scope.role);
  const directory = useStoreDirectory(permitted ? scope.tenantId : null);
  const range = directory.ready ? defaultRange(proposalZones(scope, directory)) : null;
  const query = permitted && range ? buildSummaryQuery(range, scope.activeStoreId) : null;
  const health = usePostingHealth(scope, query);

  const subtitle = scope.activeStoreId
    ? directory.nameOf(scope.activeStoreId)
      ? t("postingHealth.band.subStore", {
          store: directory.nameOf(scope.activeStoreId) ?? "",
          tenant: scope.tenantName ?? "",
        })
      : t("postingHealth.band.subTenant", { tenant: scope.tenantName ?? "" })
    : t("postingHealth.band.subScope", { tenant: scope.tenantName ?? "" });

  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("sales.list.scopePrompt")}</p>
      </div>
    );
  }
  if (!permitted) {
    return (
      <Shell subtitle={subtitle}>
        <Unavailable />
      </Shell>
    );
  }
  return (
    <Shell subtitle={subtitle}>
      <Body range={range} health={health} />
    </Shell>
  );
}
