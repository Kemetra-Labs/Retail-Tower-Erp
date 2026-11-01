/**
 * RT-993 the trend panel (DESIGN.md §12.4, D-V7): received sales of the last
 * 7 or 14 business days against the same days of the period before, one
 * currency at a time. It answers one question, stated under its title: are
 * this period's daily sales above or below the period before?
 *
 * - The period is a segmented control (7 / 14 days); both periods and their
 *   baselines come from the one 30-day summary read, so switching reads
 *   nothing.
 * - A Chart / Table switch (aria-pressed) shows the same figures as a table:
 *   each day, the same day of the previous period, both totals and their
 *   exact difference. The chart is a picture (`role="img"`) summarised by its
 *   label; the table holds the numbers.
 * - A date the read lacks is a gap in the chart and «غير معروف» with "—" in the
 *   table, never 0 (UX-13.23/24). Today is "so far".
 */
import { DataTableScroll } from "@/components/DataTableScroll";
import { SectionIndex } from "@/components/SectionIndex";
import { type MessageKey, Money, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import { currenciesOf } from "@/sales-daily/chartModel";
import { reportModel } from "@/sales-daily/dailyLogic";
import { BusinessDate } from "@/sales/SaleParts";
import { useId, useState } from "react";
import { PanelError, PanelSkeleton } from "./PanelParts";
import { TrendChart } from "./TrendChart";
import { endDateOf } from "./glanceLogic";
import {
  type ComparisonPoint,
  TREND_PERIODS,
  type TrendPeriod,
  comparisonModel,
} from "./trendLogic";
import type { PanelState } from "./usePanelQuery";

const PERIOD_KEY = {
  7: "overview.trend.days7",
  14: "overview.trend.days14",
} as const satisfies Record<TrendPeriod, MessageKey>;

function stateText(point: ComparisonPoint, t: ReturnType<typeof useT>): string {
  if (point.current === null) return t("salesDaily.chart.unknown");
  return point.state === "so-far" ? t("salesDaily.chart.soFar") : "";
}

function Amount({
  value,
  currency,
  signed,
}: Readonly<{ value: string | null; currency: string; signed?: boolean }>) {
  return value === null ? <>—</> : <Money value={value} currency={currency} signed={signed} />;
}

function Table({
  points,
  currency,
  period,
  captionId,
}: Readonly<{
  points: ComparisonPoint[];
  currency: string;
  period: TrendPeriod;
  captionId: string;
}>) {
  const t = useT();
  return (
    <DataTableScroll captionId={captionId}>
      <table className="glance-table">
        <caption id={captionId} className="sr-only">
          {`${t("overview.trend.title")} · ${t(PERIOD_KEY[period])}`}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("overview.trend.colDay")}</th>
            <th scope="col">{t("overview.trend.colSales", { currency })}</th>
            <th scope="col">{t("overview.trend.colPreviousDay")}</th>
            <th scope="col">{t("overview.trend.colPrevious", { currency })}</th>
            <th scope="col">{t("overview.trend.colDifference")}</th>
            <th scope="col">{t("overview.trend.colState")}</th>
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((p) => (
            <tr key={p.date}>
              <th scope="row">
                <BusinessDate value={p.date} />
              </th>
              <td className="glance-table__num">
                <Amount value={p.current} currency={currency} />
              </td>
              <td>
                <BusinessDate value={p.previousDate} />
              </td>
              <td className="glance-table__num">
                <Amount value={p.previous} currency={currency} />
              </td>
              <td className="glance-table__num">
                <Amount value={p.difference} currency={currency} signed />
              </td>
              <td>{stateText(p, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTableScroll>
  );
}

function Segmented<V extends string | number>({
  legend,
  options,
  value,
  onChange,
}: Readonly<{
  legend: string;
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}>) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{legend}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="segmented__btn"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

function Legend(): React.JSX.Element {
  const t = useT();
  return (
    // biome-ignore lint/a11y/useSemanticElements: the explicit list role is the Safari workaround, not a replacement element.
    // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics from a marker-free list; the role restores them.
    <ul className="trend-legend" role="list">
      <li className="trend-legend__item">
        <span className="trend-legend__swatch" aria-hidden="true" />
        {t("overview.trend.current")}
      </li>
      <li className="trend-legend__item">
        <span className="trend-legend__swatch trend-legend__swatch--previous" aria-hidden="true" />
        {t("overview.trend.previous")}
      </li>
    </ul>
  );
}

function Head({ titleId, children }: Readonly<{ titleId: string; children?: React.ReactNode }>) {
  const t = useT();
  return (
    <div className="section-panel__head glance-trend__head">
      <div className="panel-title">
        <SectionIndex position={1} />
        <h2 id={titleId} className="section-panel__title">
          {t("overview.trend.title")}
        </h2>
      </div>
      {children}
    </div>
  );
}

function Body({ summary, titleId }: Readonly<{ summary: SalesSummary; titleId: string }>) {
  const t = useT();
  const captionId = `trend-caption-${useId()}`;
  const [view, setView] = useState<"chart" | "table">("chart");
  const [period, setPeriod] = useState<TrendPeriod>(14);
  const [chosen, setChosen] = useState<string | null>(null);
  const model = reportModel(summary);
  const currencies = currenciesOf(model);
  const currency = chosen && currencies.includes(chosen) ? chosen : currencies[0];
  const points = currency ? comparisonModel(model, endDateOf(summary), period, currency) : [];
  return (
    <>
      <Head titleId={titleId}>
        {currency === undefined ? null : (
          <div className="glance-trend__controls">
            {currencies.length > 1 ? (
              <label className="glance-trend__currency">
                {t("salesDaily.chart.currency")}
                <select value={currency} onChange={(e) => setChosen(e.target.value)}>
                  {currencies.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Segmented
              legend={t("overview.trend.period")}
              options={TREND_PERIODS.map((p) => ({ value: p, label: t(PERIOD_KEY[p]) }))}
              value={period}
              onChange={setPeriod}
            />
            <Segmented
              legend={t("overview.trend.view")}
              options={[
                { value: "chart" as const, label: t("overview.trend.chart") },
                { value: "table" as const, label: t("overview.trend.table") },
              ]}
              value={view}
              onChange={setView}
            />
          </div>
        )}
      </Head>
      <div className="section-panel__body">
        <p className="section-panel__question">{t("overview.trend.question")}</p>
        {currency === undefined ? (
          <p className="glance-quiet">{t("overview.trend.empty")}</p>
        ) : view === "chart" ? (
          <>
            <TrendChart
              key={period}
              points={points}
              currency={currency}
              label={t("overview.trend.summary", { currency, days: period })}
            />
            <Legend />
          </>
        ) : (
          <Table points={points} currency={currency} period={period} captionId={captionId} />
        )}
      </div>
    </>
  );
}

export function TrendPanel({
  state,
}: Readonly<{ state: PanelState<SalesSummary> }>): React.JSX.Element | null {
  const titleId = useId();
  if (state.status === "hidden") return null;
  return (
    <section className="section-panel glance-trend" aria-labelledby={titleId}>
      {state.status === "ready" ? (
        <Body summary={state.data} titleId={titleId} />
      ) : (
        <>
          <Head titleId={titleId} />
          <div className="section-panel__body">
            {state.status === "loading" ? (
              <PanelSkeleton lines={4} />
            ) : (
              // The receipt row reads the same summary and announces its failure.
              <PanelError requestId={state.requestId} retry={state.retry} announce={false} />
            )}
          </div>
        </>
      )}
    </section>
  );
}
