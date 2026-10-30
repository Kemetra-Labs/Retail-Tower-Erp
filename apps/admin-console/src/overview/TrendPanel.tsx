/**
 * RT-970 the trend panel: received sales over the last 14 business days. The
 * sales-summary contract has no hourly series, so the canvas's hourly chart is
 * a daily one here.
 *
 * - The geometry is the daily report's own (`chartModel`, RT-823): one
 *   currency at a time, a zero baseline, the server's figure as each label,
 *   today hatched and marked "So far", a date the read lacks marked "Unknown"
 *   with no bar. The fills are `--color-viz-*` (RT-822), never status colours,
 *   and `daily-chart.css` already carries the forced-colours rules.
 * - A Chart / Table switch (aria-pressed) shows the same figures as a table:
 *   the chart's accessible alternative. The bars are a picture (`role="img"`)
 *   summarised by its label; the table holds the numbers.
 */
import { DataTableScroll } from "@/components/DataTableScroll";
import { DIRECTION, type Locale, type MessageKey, Money, intlTag, useLocale, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import {
  BAR_WIDTH,
  type ChartBar,
  type ChartGeometry,
  type Direction,
  chartModel,
  currenciesOf,
} from "@/sales-daily/chartModel";
import { type DayRow, type ReportModel, reportModel } from "@/sales-daily/dailyLogic";
import { BusinessDate } from "@/sales/SaleParts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { PanelError, PanelSkeleton } from "./PanelParts";
import { totalIn, trendModel } from "./glanceLogic";
import type { PanelState } from "./usePanelQuery";
import "@/sales-daily/daily-chart.css";

function dayFormat(locale: Locale): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(intlTag(locale), {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
}

function tickFormat(locale: Locale): Intl.NumberFormat {
  return new Intl.NumberFormat(intlTag(locale), { notation: "compact", maximumFractionDigits: 1 });
}

const MARK_KEY = {
  "so-far": "salesDaily.chart.soFar",
  unknown: "salesDaily.chart.unknown",
  "not-begun": "salesDaily.chart.notBegun",
} as const satisfies Record<string, MessageKey>;

function markOf(bar: ChartBar): keyof typeof MARK_KEY | null {
  if (bar.kind !== "value") return bar.kind;
  return bar.state === "so-far" ? "so-far" : null;
}

function Bars({
  geometry,
  direction,
  label,
}: Readonly<{ geometry: ChartGeometry; direction: Direction; label: string }>) {
  const t = useT();
  const locale = useLocale();
  const patternId = `trend-hatch-${useId().replaceAll(":", "")}`;
  const rtl = direction === "rtl";
  const far = rtl ? 12 : geometry.width - 12;
  return (
    <svg
      className="daily-chart__svg"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      width={geometry.width}
      height={geometry.height}
      focusable="false"
    >
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width="6"
          height="6"
          patternTransform="rotate(45)"
        >
          <rect className="daily-chart__hatch-ground" width="6" height="6" />
          <line className="daily-chart__hatch-line" x1="0" y1="0" x2="0" y2="6" strokeWidth="3" />
        </pattern>
      </defs>
      {geometry.ticks.map((tick) => (
        <g key={tick.value}>
          <line
            className={`daily-chart__grid${tick.value === 0 ? " daily-chart__grid--base" : ""}`}
            x1={geometry.axisX}
            x2={far}
            y1={tick.y}
            y2={tick.y}
          />
          <text
            className="daily-chart__tick"
            x={rtl ? geometry.axisX + 8 : geometry.axisX - 8}
            y={tick.y + 4}
            textAnchor={rtl ? "start" : "end"}
          >
            {tickFormat(locale).format(tick.value)}
          </text>
        </g>
      ))}
      {geometry.bars.map((bar) => {
        const mark = markOf(bar);
        const partial = bar.state === "so-far";
        return (
          <g key={bar.date}>
            {bar.kind === "value" ? (
              <rect
                className={`daily-chart__bar${partial ? " daily-chart__bar--so-far" : ""}`}
                x={bar.x}
                y={bar.y}
                width={BAR_WIDTH}
                height={bar.height}
                fill={partial ? `url(#${patternId})` : undefined}
              />
            ) : null}
            <text
              className="daily-chart__day"
              x={bar.cx}
              y={geometry.baselineY + 18}
              textAnchor="middle"
            >
              {dayFormat(locale).format(new Date(`${bar.date}T12:00:00Z`))}
            </text>
            {mark ? (
              <text
                className={`daily-chart__mark${bar.kind === "value" ? "" : " daily-chart__mark--missing"}`}
                x={bar.cx}
                y={bar.kind === "value" ? geometry.baselineY + 34 : geometry.baselineY - 8}
                textAnchor="middle"
              >
                {t(MARK_KEY[mark])}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The chart's scroll region (a keyboard stop, as `DataTableScroll`), opened at
 * its newest end: today is in view, at the inline end in either direction.
 */
function ChartScroll({
  captionId,
  rtl,
  children,
}: Readonly<{ captionId: string; rtl: boolean; children: React.ReactNode }>) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollLeft = rtl ? -el.scrollWidth : el.scrollWidth;
  }, [rtl]);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be keyboard-focusable
    <section ref={ref} className="data-table__scroll" aria-labelledby={captionId} tabIndex={0}>
      {children}
    </section>
  );
}

function stateText(row: DayRow, t: ReturnType<typeof useT>): string {
  if (row.kpis === null) return t("salesDaily.chart.unknown");
  if (row.state === "so-far") return t("salesDaily.chart.soFar");
  if (row.state === "not-begun") return t("salesDaily.chart.notBegun");
  return "";
}

function Table({
  model,
  currency,
  captionId,
}: Readonly<{ model: ReportModel; currency: string; captionId: string }>) {
  const t = useT();
  return (
    <DataTableScroll captionId={captionId}>
      <table className="glance-table">
        <caption id={captionId} className="sr-only">
          {t("overview.trend.title")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("overview.trend.colDay")}</th>
            <th scope="col">{t("overview.trend.colSales", { currency })}</th>
            <th scope="col">{t("overview.trend.colCount")}</th>
            <th scope="col">{t("overview.trend.colState")}</th>
          </tr>
        </thead>
        <tbody>
          {[...model.rows].reverse().map((row) => (
            <tr key={row.date}>
              <th scope="row">
                <BusinessDate value={row.date} />
              </th>
              <td className="glance-table__num">
                {row.kpis ? (
                  <Money value={totalIn(row.kpis.receivedSales, currency)} currency={currency} />
                ) : (
                  "—"
                )}
              </td>
              <td className="glance-table__num">{row.kpis ? row.kpis.receivedSales.count : "—"}</td>
              <td>{stateText(row, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTableScroll>
  );
}

/** The latest store "today": the chart ends there. */
function endDateOf(summary: SalesSummary): string {
  const days = summary.stores.map((s) => s.currentBusinessDate);
  return days.length > 0 ? days.reduce((a, b) => (b > a ? b : a)) : summary.to;
}

function Body({ summary }: Readonly<{ summary: SalesSummary }>): React.JSX.Element {
  const t = useT();
  const direction = DIRECTION[useLocale()];
  const captionId = `trend-caption-${useId()}`;
  const [view, setView] = useState<"chart" | "table">("chart");
  const [chosen, setChosen] = useState<string | null>(null);
  const model = trendModel(reportModel(summary), endDateOf(summary));
  const currencies = currenciesOf(model);
  const currency = chosen && currencies.includes(chosen) ? chosen : currencies[0];
  return (
    <>
      <div className="section-panel__head glance-trend__head">
        <h2 className="section-panel__title">{t("overview.trend.title")}</h2>
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
            <fieldset className="segmented">
              <legend className="sr-only">{t("overview.trend.view")}</legend>
              {(["chart", "table"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className="segmented__btn"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {t(v === "chart" ? "overview.trend.chart" : "overview.trend.table")}
                </button>
              ))}
            </fieldset>
          </div>
        )}
      </div>
      <div className="section-panel__body">
        {currency === undefined ? (
          <p className="glance-quiet">{t("overview.trend.empty")}</p>
        ) : view === "chart" ? (
          <ChartScroll captionId={captionId} rtl={direction === "rtl"}>
            <span id={captionId} className="sr-only">
              {t("overview.trend.title")}
            </span>
            <Bars
              geometry={chartModel(model, currency, direction)}
              direction={direction}
              label={t("overview.trend.summary", { currency })}
            />
          </ChartScroll>
        ) : (
          <Table model={model} currency={currency} captionId={captionId} />
        )}
      </div>
    </>
  );
}

export function TrendPanel({
  state,
}: Readonly<{ state: PanelState<SalesSummary> }>): React.JSX.Element | null {
  if (state.status === "hidden") return null;
  return (
    <section className="section-panel glance-trend">
      {state.status === "ready" ? <Body summary={state.data} /> : <TrendPending state={state} />}
    </section>
  );
}

function TrendPending({
  state,
}: Readonly<{ state: Exclude<PanelState<SalesSummary>, { status: "ready" | "hidden" }> }>) {
  const t = useT();
  return (
    <>
      <div className="section-panel__head">
        <h2 className="section-panel__title">{t("overview.trend.title")}</h2>
      </div>
      <div className="section-panel__body">
        {state.status === "loading" ? (
          <PanelSkeleton lines={4} />
        ) : (
          // The KPI strip reads the same summary and announces its failure.
          <PanelError requestId={state.requestId} retry={state.retry} announce={false} />
        )}
      </div>
    </>
  );
}
