/**
 * RT-993 the receipt row (DESIGN.md §12.2, §12.4, D-V7): the hero receipt and
 * three receipt cards for today so far, each against the previous business day
 * in full. It replaces RT-970's KPI ledger strip.
 *
 * - Every figure is a `SalesKpis` field of `consoleGetSalesSummary` as returned
 *   (`metricRegistry.ts`). The hero is received sales, not net sales: the
 *   contract defines no net sales and no average basket (RT-751 AC 1, RT-975).
 * - Each card names its scope, period, baseline and freshness: the shared
 *   context line (scope · today so far · date · as of) describes every card,
 *   and each delta names its baseline in words.
 * - A delta shows the arrow, the signed value and the baseline, tinted by the
 *   metric's good direction (owner decision 2026-11-01, §12.8.2).
 * - Money stays per currency and is never added across currencies; a date the
 *   read lacks shows «غير متاح», never 0.
 *
 * Modern concept 1/6 (rule 3): every card carries a sparkline, not just the
 * hero — the same 14 business days from the same summary read, one series per
 * card (transactions and voids count their days; returns takes its own first
 * currency's totals, as its card does). A missing day is a gap, never 0.
 */
import { ReceiptCard } from "@/components/ReceiptCard";
import { DIRECTION, DateTime, Money, useLocale, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import { type MetricId, type SalesKpis, deltaTone } from "@/metrics/metricRegistry";
import { type ReportModel, addDays, reportModel } from "@/sales-daily/dailyLogic";
import { BusinessDate } from "@/sales/SaleParts";
import { useId } from "react";
import { Link } from "react-router";
import { Delta, PanelError, PanelSkeleton, Unavailable } from "./PanelParts";
import {
  type GlanceDay,
  TREND_DAYS,
  countTrend,
  dayCurrencies,
  differenceOf,
  glanceDay,
  moneyTrend,
  totalIn,
} from "./glanceLogic";
import { comparisonModel, sparkGeometry } from "./trendLogic";
import type { PanelState } from "./usePanelQuery";

type MoneyFacts = SalesKpis["receivedSales"];
type Ready = Extract<GlanceDay, { state: "ready" }>;

/** A count difference with its sign: `+28`, `-2`, `0`. */
function SignedCount({ value }: Readonly<{ value: number }>): React.JSX.Element {
  return <bdi dir="ltr">{value > 0 ? `+${value}` : String(value)}</bdi>;
}

function MoneyDelta({
  id,
  today,
  previous,
  currency,
}: Readonly<{ id: MetricId; today: MoneyFacts; previous: MoneyFacts | null; currency: string }>) {
  if (!previous) return <Delta trend="unknown" previous={null} tone="neutral" />;
  const trend = moneyTrend(today, previous, currency);
  return (
    <Delta
      trend={trend}
      tone={deltaTone(id, "total", trend)}
      signed={
        <Money
          value={differenceOf(totalIn(today, currency), totalIn(previous, currency))}
          currency={currency}
          signed
        />
      }
      previous={<Money value={totalIn(previous, currency)} currency={currency} />}
    />
  );
}

function amountsOf(today: MoneyFacts | null, previous: MoneyFacts | null): string[] | null {
  return today ? dayCurrencies(today, previous) : null;
}

/** A money card's figure: one line per currency, «غير متاح» without a bucket. */
function MoneyFigure({
  today,
  currencies,
}: Readonly<{ today: MoneyFacts | null; currencies: string[] | null }>) {
  const t = useT();
  if (!today || currencies === null) return <Unavailable />;
  if (currencies.length === 0) return <>{t("metrics.claim.noAmount")}</>;
  return (
    <span className="receipt-row__amounts">
      {currencies.map((currency) => (
        <Money key={currency} value={totalIn(today, currency)} currency={currency} />
      ))}
    </span>
  );
}

function MoneyDeltas({
  id,
  today,
  previous,
  currencies,
}: Readonly<{
  id: MetricId;
  today: MoneyFacts | null;
  previous: MoneyFacts | null;
  currencies: string[] | null;
}>) {
  if (!today || currencies === null) {
    return <Delta trend="unknown" previous={null} tone="neutral" />;
  }
  return (
    <span className="receipt-row__deltas">
      {currencies.map((currency) => (
        <MoneyDelta key={currency} id={id} today={today} previous={previous} currency={currency} />
      ))}
    </span>
  );
}

/**
 * One card's 14-day series ending at `date`: one value per business day from
 * the report model, a gap (null) where the read lacks the day or it has not
 * begun — the same gaps the hero sparkline keeps.
 */
function seriesOf(
  model: ReportModel,
  date: string,
  pick: (kpis: SalesKpis | null) => string | null,
): (string | null)[] {
  return Array.from({ length: TREND_DAYS }, (_, i) => {
    const day = addDays(date, i - TREND_DAYS + 1);
    const row = model.rows.find((r) => r.date === day);
    if (!row || row.state === "not-begun") return null;
    return pick(row.kpis);
  });
}

/** A card's sparkline: the series on a zero baseline, gaps kept. */
function Spark({
  values,
  label,
  tone,
}: Readonly<{
  values: readonly (string | null)[];
  label: string;
  /** `hero` keeps the Mint-on-Ink spark; `plain` is the Ink line for light cards. */
  tone: "hero" | "plain";
}>): React.JSX.Element {
  const t = useT();
  const direction = DIRECTION[useLocale()];
  const g = sparkGeometry(values, direction);
  const prefix = tone === "hero" ? "hero-spark" : "card-spark";
  return (
    <span className="receipt-row__spark">
      <svg
        className={prefix}
        role="img"
        aria-label={label}
        viewBox={`0 0 ${g.width} ${g.height}`}
        width={g.width}
        height={g.height}
        focusable="false"
      >
        <line className={`${prefix}__base`} x1={0} x2={g.width} y1={g.baselineY} y2={g.baselineY} />
        {g.runs.map((run) =>
          run.length === 1 ? (
            <circle
              key={run[0].index}
              className={`${prefix}__dot`}
              cx={run[0].x}
              cy={run[0].y}
              r={2.5}
            />
          ) : (
            <polyline
              key={run[0].index}
              className={`${prefix}__line`}
              points={run.map((p) => `${p.x},${p.y}`).join(" ")}
            />
          ),
        )}
      </svg>
      <span className="receipt-row__spark-period">{t("overview.kpi.sparkPeriod")}</span>
    </span>
  );
}

/** The hero's sparkline: one currency over the last 14 business days, gaps kept. */
function HeroSpark({
  summary,
  date,
  currency,
}: Readonly<{ summary: SalesSummary; date: string; currency: string }>) {
  const t = useT();
  const values = comparisonModel(reportModel(summary), date, TREND_DAYS, currency).map(
    (p) => p.current,
  );
  return <Spark values={values} label={t("overview.kpi.sparkSummary", { currency })} tone="hero" />;
}

function CountCard({
  id,
  label,
  today,
  previous,
  describedBy,
  spark,
}: Readonly<{
  id: MetricId;
  label: string;
  today: number | null;
  previous: number | null;
  describedBy: string;
  /** The card's 14-day series; omitted while the read lacks a series. */
  spark?: readonly (string | null)[];
}>) {
  const t = useT();
  const trend = countTrend(today, previous);
  return (
    <ReceiptCard
      label={label}
      describedBy={describedBy}
      figure={today === null ? <Unavailable /> : <bdi dir="ltr">{today}</bdi>}
    >
      <Delta
        trend={trend}
        tone={deltaTone(id, "total", trend)}
        signed={
          today !== null && previous !== null ? <SignedCount value={today - previous} /> : null
        }
        previous={<bdi dir="ltr">{previous}</bdi>}
      />
      {spark ? <Spark values={spark} label={t("overview.kpi.sparkLabel")} tone="plain" /> : null}
    </ReceiptCard>
  );
}

function MoneyCard({
  id,
  label,
  today,
  previous,
  describedBy,
  spark,
}: Readonly<{
  id: MetricId;
  label: string;
  today: MoneyFacts | null;
  previous: MoneyFacts | null;
  describedBy: string;
  /** The card's 14-day series in its first currency; omitted without one. */
  spark?: readonly (string | null)[];
}>) {
  const t = useT();
  const currencies = amountsOf(today, previous);
  return (
    <ReceiptCard
      label={label}
      describedBy={describedBy}
      figure={<MoneyFigure today={today} currencies={currencies} />}
    >
      <MoneyDeltas id={id} today={today} previous={previous} currencies={currencies} />
      {spark ? <Spark values={spark} label={t("overview.kpi.sparkLabel")} tone="plain" /> : null}
    </ReceiptCard>
  );
}

/**
 * The returns card shows its own first currency, so its trend follows that
 * currency, not the received-sales one.
 */
function returnsSparkCurrency(day: Ready, fallback: string | undefined): string | undefined {
  return amountsOf(day.today?.returns ?? null, day.previous?.returns ?? null)?.[0] ?? fallback;
}

function Row({
  day,
  summary,
  scope,
}: Readonly<{ day: Ready; summary: SalesSummary; scope: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  const contextId = useId();
  const { today, previous } = day;
  const received = amountsOf(today?.receivedSales ?? null, previous?.receivedSales ?? null);
  const sparkCurrency = received?.[0];
  const model = reportModel(summary);
  const transactionsSpark = seriesOf(model, day.date, (kpis) =>
    kpis ? String(kpis.receivedSales.count) : null,
  );
  const returnsCurrency = returnsSparkCurrency(day, sparkCurrency);
  const returnsSpark = returnsCurrency
    ? seriesOf(model, day.date, (kpis) => (kpis ? totalIn(kpis.returns, returnsCurrency) : null))
    : undefined;
  const voidsSpark = seriesOf(model, day.date, (kpis) => (kpis ? String(kpis.voids.count) : null));
  return (
    <>
      <p id={contextId} className="receipt-row__context">
        {t.rich("overview.kpi.context", {
          scope,
          date: <BusinessDate value={day.date} />,
          asOf: <DateTime value={summary.asOf} />,
        })}
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: the explicit list role is the Safari workaround, not a replacement element. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics from a marker-free list; the role restores them. */}
      <ul className="receipt-row" role="list">
        <li>
          <ReceiptCard
            hero
            label={t("metrics.receivedSales.label")}
            describedBy={contextId}
            figure={<MoneyFigure today={today?.receivedSales ?? null} currencies={received} />}
          >
            <MoneyDeltas
              id="receivedSales"
              today={today?.receivedSales ?? null}
              previous={previous?.receivedSales ?? null}
              currencies={received}
            />
            {sparkCurrency ? (
              <HeroSpark summary={summary} date={day.date} currency={sparkCurrency} />
            ) : null}
          </ReceiptCard>
        </li>
        <li>
          <CountCard
            id="receivedSales"
            label={t("overview.kpi.transactions")}
            today={today?.receivedSales.count ?? null}
            previous={previous?.receivedSales.count ?? null}
            describedBy={contextId}
            spark={transactionsSpark}
          />
        </li>
        <li>
          <MoneyCard
            id="returns"
            label={t("metrics.returns.label")}
            today={today?.returns ?? null}
            previous={previous?.returns ?? null}
            describedBy={contextId}
            spark={returnsSpark}
          />
        </li>
        <li>
          <CountCard
            id="voids"
            label={t("metrics.voids.label")}
            today={today?.voids.count ?? null}
            previous={previous?.voids.count ?? null}
            describedBy={contextId}
            spark={voidsSpark}
          />
        </li>
      </ul>
      <p className="receipt-row__note">{t("overview.kpi.compareNote")}</p>
    </>
  );
}

function Body({
  summary,
  scope,
}: Readonly<{ summary: SalesSummary; scope: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  const day = glanceDay(summary);
  if (day.state === "none") return <p className="glance-quiet">{t("overview.kpi.none")}</p>;
  if (day.state === "mixed") {
    return (
      <p className="glance-quiet">
        {t("overview.kpi.mixed")}{" "}
        <Link className="ledger__link" to="/sales-daily">
          {t("salesDaily.entry")}
        </Link>
      </p>
    );
  }
  return <Row day={day} summary={summary} scope={scope} />;
}

export function ReceiptRow({
  state,
  scope,
}: Readonly<{
  state: PanelState<SalesSummary>;
  /** The scope the figures cover: the active store's name, or all stores. */
  scope: React.ReactNode;
}>): React.JSX.Element | null {
  const t = useT();
  if (state.status === "hidden") return null;
  return (
    <section className="glance-kpis" aria-label={t("overview.kpi.label")}>
      {state.status === "loading" ? <PanelSkeleton lines={2} /> : null}
      {state.status === "error" ? (
        <PanelError requestId={state.requestId} failure={state.failure} retry={state.retry} />
      ) : null}
      {state.status === "ready" ? <Body summary={state.data} scope={scope} /> : null}
    </section>
  );
}
