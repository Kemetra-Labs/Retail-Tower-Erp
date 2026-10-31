/**
 * RT-821 (VIZ-3) the cells of the daily report's exact tables, shared since
 * RT-1020 with the per-day panel: a money cell is the count, then one line per
 * currency, never added across currencies; a status cell is the served parts as
 * text. A day missing from the read is the word Unknown, never 0. Nothing here
 * calculates.
 */
import { type MessageKey, Money, formatNumber, useT } from "@/i18n";
import type { MetricId, SalesKpis } from "@/metrics/metricRegistry";
import type { DayState } from "./dailyLogic";

export type MoneyMetric = "receivedSales" | "voids" | "returns" | "legacyRefunds";
export const MONEY_METRICS: readonly MoneyMetric[] = [
  "receivedSales",
  "voids",
  "returns",
  "legacyRefunds",
];
export const STATUS_METRICS: readonly MetricId[] = ["syncStatus", "erpPosting", "shiftCloses"];

export const STATE_MARK: Record<Exclude<DayState, "complete">, MessageKey> = {
  "so-far": "metrics.context.soFar",
  "not-begun": "salesDaily.row.notBegun",
};

export function Unknown(): React.JSX.Element {
  const t = useT();
  return <span className="daily-table__unknown">{t("metrics.claim.unknown")}</span>;
}

function Count({ value }: Readonly<{ value: number }>): React.JSX.Element {
  const t = useT();
  return <span className="daily-table__count">{formatNumber(value, t.locale)}</span>;
}

export function MoneyCell({
  kpis,
  metric,
}: Readonly<{ kpis: SalesKpis | null; metric: MoneyMetric }>) {
  if (!kpis) return <Unknown />;
  const facts = kpis[metric];
  return (
    <>
      <Count value={facts.count} />
      {facts.byCurrency.length > 0 ? (
        <ul className="daily-table__lines">
          {facts.byCurrency.map((c) => (
            <li key={c.currencyCode}>
              <Money value={c.total} currency={c.currencyCode} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

type Part = [MessageKey, number];

function partsOf(metric: MetricId, kpis: SalesKpis): Part[] {
  if (metric === "syncStatus") {
    const s = kpis.syncStatus;
    return [
      ["metrics.part.captured", s.captured],
      ["metrics.part.synced", s.synced],
      ["metrics.part.failedRetryable", s.failedRetryable],
      ["metrics.part.failedNeedsRepair", s.failedNeedsRepair],
    ];
  }
  if (metric === "erpPosting") {
    const e = kpis.erpPosting;
    return [
      ["metrics.part.posted", e.posted],
      ["metrics.part.pending", e.pending],
      ["metrics.part.failed", e.failed],
      ["metrics.part.unknown", e.unknown],
    ];
  }
  const c = kpis.shiftCloses;
  return [
    ["metrics.part.normal", c.normal],
    ["metrics.part.forced", c.forced],
    ["metrics.part.withVariance", c.withVariance],
    ["metrics.part.approvalMissing.yes", c.approvalMissing.yes],
    ["metrics.part.approvalMissing.no", c.approvalMissing.no],
    ["metrics.part.approvalMissing.unknown", c.approvalMissing.unknown],
  ];
}

export function StatusCell({
  kpis,
  metric,
}: Readonly<{ kpis: SalesKpis | null; metric: MetricId }>) {
  const t = useT();
  if (!kpis) return <Unknown />;
  return (
    <>
      {metric === "shiftCloses" ? <Count value={kpis.shiftCloses.count} /> : null}
      <ul className="daily-table__lines">
        {partsOf(metric, kpis).map(([labelKey, count]) => (
          <li key={labelKey}>{t("metrics.claim.part", { label: t(labelKey), count })}</li>
        ))}
      </ul>
    </>
  );
}

export function Zones({ zones }: Readonly<{ zones: readonly string[] }>): React.JSX.Element {
  const t = useT();
  const sep = t.locale === "ar" ? "، " : ", ";
  return (
    <>
      {zones.map((z, i) => (
        <span key={z}>
          {i > 0 ? sep : null}
          <bdi dir="ltr">{z}</bdi>
        </span>
      ))}
    </>
  );
}
