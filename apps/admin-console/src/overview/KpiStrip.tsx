/**
 * RT-970 the KPI ledger strip (canvas «مؤشرات اليوم»; DESIGN.md §2 v3.0: one
 * strip, never a stat-card grid). One section panel of four cells divided by
 * rules: received sales, transactions, returns and voids, today so far, each
 * against the previous business day in full.
 *
 * Every figure is a `SalesKpis` field of `consoleGetSalesSummary` as returned
 * (`metricRegistry.ts`); there is no net sales and no average basket because
 * the contract defines neither (RT-751 AC 1). Money stays per currency and is
 * never added across currencies. A date the read lacks shows «غير متاح».
 */
import { Money, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import type { SalesKpis } from "@/metrics/metricRegistry";
import { BusinessDate } from "@/sales/SaleParts";
import { Link } from "react-router";
import { Delta, PanelError, PanelSkeleton, Unavailable } from "./PanelParts";
import {
  type GlanceDay,
  countTrend,
  dayCurrencies,
  glanceDay,
  moneyTrend,
  totalIn,
} from "./glanceLogic";
import type { PanelState } from "./usePanelQuery";

type MoneyFacts = SalesKpis["receivedSales"];
type Ready = Extract<GlanceDay, { state: "ready" }>;

function Cell({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="kpi-strip__cell">
      <dt className="kpi-strip__label">{label}</dt>
      {children}
    </div>
  );
}

/** One money figure per currency, today's, each with its comparison. */
function MoneyCell({
  label,
  today,
  previous,
}: Readonly<{ label: string; today: MoneyFacts | null; previous: MoneyFacts | null }>) {
  const t = useT();
  if (!today) {
    return (
      <Cell label={label}>
        <dd className="kpi-strip__value">
          <Unavailable />
        </dd>
      </Cell>
    );
  }
  const currencies = dayCurrencies(today, previous);
  if (currencies.length === 0) {
    return (
      <Cell label={label}>
        <dd className="kpi-strip__value kpi-strip__value--quiet">{t("metrics.claim.noAmount")}</dd>
      </Cell>
    );
  }
  return (
    <Cell label={label}>
      {currencies.map((currency) => (
        <dd key={currency} className="kpi-strip__money">
          <Money
            className="kpi-strip__value"
            value={totalIn(today, currency)}
            currency={currency}
          />
          {previous ? (
            <Delta
              trend={moneyTrend(today, previous, currency)}
              previous={<Money value={totalIn(previous, currency)} currency={currency} />}
            />
          ) : (
            <Delta trend="unknown" previous={null} />
          )}
        </dd>
      ))}
    </Cell>
  );
}

function CountCell({
  label,
  today,
  previous,
}: Readonly<{ label: string; today: number | null; previous: number | null }>) {
  return (
    <Cell label={label}>
      <dd className="kpi-strip__money">
        {today === null ? <Unavailable /> : <span className="kpi-strip__value">{today}</span>}
        <Delta
          trend={countTrend(today, previous)}
          previous={<span className="kpi-strip__num">{previous}</span>}
        />
      </dd>
    </Cell>
  );
}

function Strip({ day }: Readonly<{ day: Ready }>): React.JSX.Element {
  const t = useT();
  const { today, previous } = day;
  return (
    <>
      <dl className="kpi-strip">
        <MoneyCell
          label={t("metrics.receivedSales.label")}
          today={today?.receivedSales ?? null}
          previous={previous?.receivedSales ?? null}
        />
        <CountCell
          label={t("overview.kpi.transactions")}
          today={today?.receivedSales.count ?? null}
          previous={previous?.receivedSales.count ?? null}
        />
        <MoneyCell
          label={t("metrics.returns.label")}
          today={today?.returns ?? null}
          previous={previous?.returns ?? null}
        />
        <CountCell
          label={t("metrics.voids.label")}
          today={today?.voids.count ?? null}
          previous={previous?.voids.count ?? null}
        />
      </dl>
      <p className="kpi-strip__note">
        {t.rich("overview.kpi.soFar", { date: <BusinessDate value={day.date} /> })}
        {" · "}
        {t("overview.kpi.compareNote")}
      </p>
    </>
  );
}

function Body({ summary }: Readonly<{ summary: SalesSummary }>): React.JSX.Element {
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
  return <Strip day={day} />;
}

export function KpiStrip({
  state,
}: Readonly<{ state: PanelState<SalesSummary> }>): React.JSX.Element | null {
  const t = useT();
  if (state.status === "hidden") return null;
  return (
    <section className="section-panel glance-kpis" aria-label={t("overview.kpi.label")}>
      {state.status === "loading" ? <PanelSkeleton lines={2} /> : null}
      {state.status === "error" ? (
        <PanelError requestId={state.requestId} retry={state.retry} />
      ) : null}
      {state.status === "ready" ? <Body summary={state.data} /> : null}
    </section>
  );
}
