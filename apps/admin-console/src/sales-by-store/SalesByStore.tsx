/**
 * RT-1054 «المبيعات حسب المتجر»: the sales-by-store report at `/sales-by-store`,
 * from the v9 board `Report-stores.dc.html` as amended by RT-996 (D-1…D-12).
 * It reads `consoleGetSalesByStore` only: every store of the caller's scope,
 * ranked by received sales in one currency, with the previous equal-length
 * period beside it. The scope header's active store does not filter it (the
 * contract has no store parameter).
 *
 * The Console presents the server's figures as given and never sums, subtracts
 * or divides one (AI-13): see `storeLogic.ts` for how bars, percentages and rank
 * changes are shown without arithmetic.
 *
 * Entry: the Reports index (RT-1020). The URL (`from`, `to`, `currency`,
 * `compare=none`) is the report's state; the default is the last 10 business
 * days, read only once the store zones are known so a UTC guess never fires.
 */
import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { type BandFacts, ListHeaderBand } from "@/components/ListHeaderBand";
import { DateTime, type MessageKey, Money, formatNumber, useT } from "@/i18n";
import type { SalesByStore as Report } from "@/lib/sales-by-store-queries";
import { Zones } from "@/sales-daily/DailyCells";
import { DailyRangeForm } from "@/sales-daily/DailyRangeForm";
import { Notice, Unavailable } from "@/sales/SalePager";
import { BusinessDateRange } from "@/sales/SaleParts";
import { canReadSales } from "@/sales/saleLogic";
import { useSaleScope } from "@/sales/useSales";
import { useStoreDirectory } from "@/shift-closes/useShiftCloses";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { StoreControls } from "./StoreControls";
import { StoreFigures } from "./StoreFigures";
import { StoreMatrix } from "./StoreMatrix";
import { StorePanel } from "./StorePanel";
import { StoreRanking } from "./StoreRanking";
import {
  type ReportModel,
  type ReportParams,
  buildQuery,
  currencyOptions,
  defaultParams,
  latestToday,
  paramsFromSearch,
  paramsToSearch,
  rangeProblem,
  reportModel,
  selectedRow,
} from "./storeLogic";
import { type SalesByStoreState, useSalesByStore } from "./useSalesByStore";
import "@/components/list-state.css";
import "../shell/surface.css";
import "./sales-by-store.css";

const RANGE_PROBLEM_KEY = {
  "to-before-from": "sales.filter.rangeReversed",
  "range-too-wide": "sales.filter.spanTooWide",
} as const satisfies Record<string, MessageKey>;

/** A 400 about the range belongs at the To field; any other 400 says so there too. */
function fieldErrorOf(error: SalesByStoreState["error"]): MessageKey | undefined {
  if (error?.kind === "range") return RANGE_PROBLEM_KEY[error.problem];
  return error?.kind === "field" ? "salesByStore.rejected" : undefined;
}

function Loading(): React.JSX.Element {
  const t = useT();
  return (
    <div className="section-panel">
      <output className="list-state list-state--loading" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <span className="list-state__msg">{t("salesByStore.loading")}</span>
      </output>
    </div>
  );
}

function Failure({ state }: Readonly<{ state: SalesByStoreState }>): React.JSX.Element | null {
  const t = useT();
  const error = state.error;
  if (!error || error.kind === "range" || error.kind === "field") return null;
  if (error.kind === "not-found") return <Unavailable />;
  if (error.kind === "scope-too-large") {
    return (
      <Notice
        message={t("salesByStore.scopeTooLarge")}
        hint={t("salesByStore.scopeTooLargeHint")}
      />
    );
  }
  const retry = (
    <GatedButton type="button" className="btn-secondary" onClick={state.retry}>
      {t("salesByStore.retry")}
    </GatedButton>
  );
  if (error.kind === "rate-limited") {
    return (
      <div className="sbs-state">
        <Notice message={t("salesByStore.rateLimited")} hint={t("salesByStore.rateLimitedHint")} />
        {retry}
      </div>
    );
  }
  return (
    <Banner
      variant="danger"
      message={t("salesByStore.failed")}
      requestId={error.requestId}
      action={retry}
    />
  );
}

/** The band's three facts, each exactly as the server serves it for the whole scope. */
function useBandFacts(report: Report | undefined): BandFacts | undefined {
  const t = useT();
  if (!report) return undefined;
  const received = report.rangeTotals.receivedSales.byCurrency.find(
    (c) => c.currencyCode === report.currency,
  );
  return [
    {
      label: t("salesByStore.fact.received"),
      value: <Money value={received?.total ?? "0.0000"} currency={report.currency} />,
    },
    { label: t("salesByStore.fact.stores"), value: formatNumber(report.storeCount, t.locale) },
    {
      label: t("salesByStore.fact.withoutSales"),
      value: formatNumber(report.storesWithoutSales, t.locale),
    },
  ];
}

function Chip({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <span className="sbs-chip">{children}</span>;
}

/** Scope, calendar, zones, read time, baseline and completeness: what every figure below covers. */
function ReportContext({
  report,
  model,
}: Readonly<{ report: Report; model: ReportModel }>): React.JSX.Element {
  const t = useT();
  const zone = model.zones.length === 1 ? model.zones[0] : undefined;
  return (
    <div className="sbs-context">
      <Chip>
        {t("salesByStore.context.scope", { count: formatNumber(report.storeCount, t.locale) })}
      </Chip>
      <Chip>{t("salesDaily.context.calendar")}</Chip>
      {model.zones.length > 0 ? (
        <Chip>{t.rich("metrics.context.zones", { zones: <Zones zones={model.zones} /> })}</Chip>
      ) : null}
      <Chip>
        {t.rich("metrics.context.asOf", { asOf: <DateTime value={report.asOf} timeZone={zone} /> })}
      </Chip>
      <Chip>
        {model.comparing
          ? t.rich("salesByStore.context.baseline", {
              range: <BusinessDateRange from={report.baseline.from} to={report.baseline.to} />,
            })
          : t("salesByStore.context.noCompare")}
      </Chip>
      {model.includesSoFar ? (
        <Chip>
          <span className="sbs-chip__so-far">{t("salesByStore.context.soFar")}</span>
        </Chip>
      ) : null}
      <p className="sbs-context__note">{t("metrics.context.completeness")}</p>
    </div>
  );
}

function Content({ report }: Readonly<{ report: Report }>): React.JSX.Element {
  const t = useT();
  const model = reportModel(report);
  const [pickedRef, setPickedRef] = useState<string | null>(null);
  const picked = selectedRow(model.rows, pickedRef);
  if (report.storeCount === 0 || !picked) {
    return <Notice message={t("salesByStore.empty")} hint={t("salesByStore.emptyHint")} />;
  }
  const allUnranked = report.rankable && model.rows.every((r) => !r.ranked);
  return (
    <div className="sbs-report">
      <ReportContext report={report} model={model} />
      {report.rankable ? null : <p className="sbs-note">{t("salesByStore.rank.notRankable")}</p>}
      {allUnranked ? (
        <p className="sbs-note">{t("salesByStore.allUnranked", { currency: report.currency })}</p>
      ) : null}
      <div className="sbs-board">
        <div className="sbs-board__main">
          <StoreRanking
            report={report}
            rows={model.rows}
            comparing={model.comparing}
            pickedRef={picked.store.storeRef}
            onPick={setPickedRef}
          />
          <StoreMatrix report={report} rows={model.rows} pickedRef={picked.store.storeRef} />
        </div>
        <StorePanel report={report} row={picked} comparing={model.comparing} />
      </div>
      <StoreFigures report={report} model={model} />
    </div>
  );
}

function Body({ state }: Readonly<{ state: SalesByStoreState }>): React.JSX.Element | null {
  if (state.isLoading) return <Loading />;
  if (state.error) return <Failure state={state} />;
  if (!state.report) return null;
  return <Content report={state.report} />;
}

function Shell({
  facts,
  children,
}: Readonly<{ facts?: BandFacts; children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface surface--v4 sbs-surface">
      <div className="sbs-crumbs">
        <Link to="/reports" className="surface__back">
          <BackArrow /> {t("salesDaily.back.reports")}
        </Link>
      </div>
      <ListHeaderBand
        group={t("salesDaily.band.group")}
        title={t("salesByStore.title")}
        subtitle={t("salesByStore.band.subtitle")}
        facts={facts ? { label: t("salesByStore.band.label"), items: facts } : undefined}
      />
      {children}
    </div>
  );
}

export function SalesByStore(): React.JSX.Element {
  const t = useT();
  const scope = useSaleScope();
  const [search, setSearch] = useSearchParams();
  // A refused role reads nothing: the server would answer the same 404.
  const permitted = canReadSales(scope.role);
  const directory = useStoreDirectory(permitted ? scope.tenantId : null);
  const zones = directory.stores.map((s) => s.timezone ?? "UTC");
  const applied: ReportParams | null =
    paramsFromSearch(search) ?? (directory.ready ? defaultParams(zones) : null);
  const valid = applied !== null && rangeProblem(applied) === null;
  const query = permitted && valid ? buildQuery(applied) : null;
  const state = useSalesByStore(scope.tenantId, query);
  const facts = useBandFacts(state.isLoading || state.error ? undefined : state.report);
  const write = (next: ReportParams) => setSearch(paramsToSearch(next));

  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("sales.list.scopePrompt")}</p>
      </div>
    );
  }
  if (!permitted) {
    return (
      <Shell>
        <Unavailable />
      </Shell>
    );
  }
  const served = state.report ? reportModel(state.report).currencies : [];
  return (
    <Shell facts={facts}>
      {applied ? (
        <StoreControls
          params={applied}
          today={directory.ready ? latestToday(zones) : null}
          currencies={currencyOptions(applied.currency, served)}
          onChange={write}
        />
      ) : null}
      <DailyRangeForm
        range={applied ? { from: applied.from, to: applied.to } : null}
        zoneNote={`${t("salesDaily.range.note")} ${t("salesDaily.context.calendar")}`}
        serverError={fieldErrorOf(state.error)}
        onApply={(range) => applied && write({ ...applied, ...range })}
        onClear={() => setSearch(new URLSearchParams())}
      />
      {applied === null ? <Loading /> : <Body state={state} />}
    </Shell>
  );
}
