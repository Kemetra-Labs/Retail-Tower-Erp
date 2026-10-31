/**
 * RT-821 (VIZ-3) the daily received-sales report body: the context line, then
 * the chart (VIZ-5, RT-823), then two exact tables over the same business days.
 * The first table is the accessible alternative of the chart, whose bars link
 * to its row ids.
 *
 *   1. received sales, voids, returns, legacy refunds (R2): count, then one
 *      line per currency, never added across currencies;
 *   2. sync state, ERP posting state (R3) and shift closes (R4).
 *
 * Plain semantic tables, not `DataTable`: a report row opens nothing, so no
 * row is a tab stop. The footer is the server's `rangeTotals`, never a sum of
 * the rows. A day missing from the read is the word Unknown, never 0; a day
 * still running is marked in words (and a pattern), never by colour alone.
 */
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { SectionIndex } from "@/components/SectionIndex";
import { DateTime, type MessageKey, useT } from "@/i18n";
import {
  METRIC_IDS,
  type MetricId,
  type SalesKpis,
  metricDefinition,
} from "@/metrics/metricRegistry";
import { BusinessDate } from "@/sales/SaleParts";
import { useId } from "react";
import {
  MONEY_METRICS,
  MoneyCell,
  type MoneyMetric,
  STATE_MARK,
  STATUS_METRICS,
  StatusCell,
  Zones,
} from "./DailyCells";
import { DailyChart } from "./DailyChart";
import { DayPanel } from "./DayPanel";
import { ExportButton } from "./ExportButton";
import type { DayRow, ReportModel } from "./dailyLogic";
import { dayRowId } from "./dayRowId";

function DayHeader({ row }: Readonly<{ row: DayRow }>): React.JSX.Element {
  const t = useT();
  return (
    <th scope="row">
      <BusinessDate value={row.date} />
      {row.state === "complete" ? null : (
        <span className="daily-table__mark"> {t(STATE_MARK[row.state])}</span>
      )}
    </th>
  );
}

interface TableSpec {
  captionKey: MessageKey;
  hintKey: MessageKey;
  metrics: readonly MetricId[];
  cell: (kpis: SalesKpis | null, metric: MetricId) => React.ReactNode;
}

const TABLES: readonly TableSpec[] = [
  {
    captionKey: "salesDaily.table.money.caption",
    hintKey: "salesDaily.table.money.hint",
    metrics: MONEY_METRICS,
    cell: (kpis, metric) => <MoneyCell kpis={kpis} metric={metric as MoneyMetric} />,
  },
  {
    captionKey: "salesDaily.table.status.caption",
    hintKey: "salesDaily.table.status.hint",
    metrics: STATUS_METRICS,
    cell: (kpis, metric) => <StatusCell kpis={kpis} metric={metric} />,
  },
];

function DailyTable({
  spec,
  model,
  contextId,
  withRowIds,
  position,
}: Readonly<{
  spec: TableSpec;
  model: ReportModel;
  contextId: string;
  withRowIds: boolean;
  position: number;
}>) {
  const t = useT();
  const captionId = useCaptionId();
  const hintId = useId();
  return (
    <section className="section-panel daily-report__table">
      <div className="section-panel__head">
        <SectionIndex position={position} />
        <h2 className="section-panel__title">{t(spec.captionKey)}</h2>
      </div>
      <p id={hintId} className="daily-report__hint daily-report__panel-hint">
        {t(spec.hintKey)}
      </p>
      <DataTableScroll captionId={captionId}>
        <table className="data-table daily-table" aria-describedby={`${hintId} ${contextId}`}>
          <caption id={captionId} className="data-table__caption">
            {t(spec.captionKey)}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("salesDaily.col.day")}</th>
              {spec.metrics.map((m) => (
                <th key={m} scope="col">
                  {t(metricDefinition(m).labelKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr
                key={row.date}
                id={withRowIds ? dayRowId(row.date) : undefined}
                // A chart bar moves focus here; the row is never a tab stop.
                tabIndex={withRowIds ? -1 : undefined}
                data-business-date={row.date}
                className={row.state === "complete" ? undefined : "daily-table__row--partial"}
              >
                <DayHeader row={row} />
                {spec.metrics.map((m) => (
                  <td key={m}>{spec.cell(row.kpis, m)}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                {t(model.partial ? "salesDaily.row.totalSoFar" : "salesDaily.row.total")}
              </th>
              {spec.metrics.map((m) => (
                <td key={m}>{spec.cell(model.totals, m)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </DataTableScroll>
    </section>
  );
}

const SEP = " · ";

/** One part of the context line, after a separator. */
function Part({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <>
      {SEP}
      <span>{children}</span>
    </>
  );
}

function ScopePart({
  model,
  storeName,
}: Readonly<{ model: ReportModel; storeName: string }>): React.JSX.Element {
  const t = useT();
  // A scope's plural copy already names the calendar; one store gets it on its own.
  if (model.scope === "all_in_scope") {
    return <span>{t("metrics.context.allInScope", { count: model.storeCount })}</span>;
  }
  return (
    <>
      <span>{t.rich("metrics.context.store", { store: <bdi>{storeName}</bdi> })}</span>
      <Part>{t("salesDaily.context.calendar")}</Part>
    </>
  );
}

function ZonesPart({
  model,
  readStores,
}: Readonly<{ model: ReportModel; readStores: number }>): React.JSX.Element | null {
  const t = useT();
  const zones = model.zones;
  if (zones.length === 0) return null;
  const partial = model.zonesComplete
    ? null
    : ` (${t("salesDaily.context.zonesPartial", { count: readStores })})`;
  return (
    <Part>
      {t.rich(zones.length === 1 ? "metrics.context.zone" : "metrics.context.zones", {
        zone: <Zones zones={zones} />,
        zones: <Zones zones={zones} />,
      })}
      {partial}
    </Part>
  );
}

/** Scope, calendar, range, zones, `asOf` and completeness: what every figure below covers. */
function ReportContext({
  model,
  storeName,
  readStores,
  id,
}: Readonly<{ model: ReportModel; storeName: string; readStores: number; id: string }>) {
  const t = useT();
  // One store: its zone (RT-751 D5); a scope: UTC, labelled.
  const asOfZone = model.scope === "store" ? model.zones[0] : undefined;
  return (
    <p id={id} className="daily-report__context" data-testid="sales-daily-context">
      <ScopePart model={model} storeName={storeName} />
      <Part>
        {t.rich("metrics.context.range", {
          from: <BusinessDate value={model.rows[0]?.date ?? ""} />,
          to: <BusinessDate value={model.rows.at(-1)?.date ?? ""} />,
        })}
      </Part>
      <ZonesPart model={model} readStores={readStores} />
      <Part>
        {t.rich("metrics.context.asOf", {
          asOf: <DateTime value={model.asOf} timeZone={asOfZone} />,
        })}
      </Part>
      <Part>{t("metrics.context.completeness")}</Part>
      {model.partial ? <Part>{t("salesDaily.context.soFar")}</Part> : null}
    </p>
  );
}

/** What each column counts, from the console metric registry (RT-819). */
function Definitions(): React.JSX.Element {
  const t = useT();
  return (
    <details className="daily-report__about">
      <summary>{t("salesDaily.about")}</summary>
      <dl>
        {METRIC_IDS.map((id) => {
          const def = metricDefinition(id);
          return (
            <div key={id}>
              <dt>{t(def.labelKey)}</dt>
              <dd>
                {t(def.definitionKey)} {t(def.zoneRuleKey)} {t(def.unknown.meaningKey)}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}

export function DailyReport({
  model,
  storeName,
  storeId,
  readStores,
}: Readonly<{
  model: ReportModel;
  storeName: string;
  /** The store of a one-store read, for the day panel's Sales link; null for a scope. */
  storeId: string | null;
  readStores: number;
}>): React.JSX.Element {
  const contextId = useId();
  return (
    <div className="daily-report">
      <div className="daily-report__main">
        <section className="section-panel daily-report__chart-panel">
          <div className="section-panel__body daily-report__chart-body">
            <ReportContext
              model={model}
              storeName={storeName}
              readStores={readStores}
              id={contextId}
            />
            <ExportButton model={model} storeName={model.scope === "store" ? storeName : null} />
            <DailyChart model={model} badge={<SectionIndex position={1} />} />
          </div>
        </section>
        <DayPanel model={model} storeId={storeId} position={2} />
      </div>
      {TABLES.map((spec, index) => (
        <DailyTable
          key={spec.captionKey}
          spec={spec}
          model={model}
          contextId={contextId}
          withRowIds={index === 0}
          position={index + 3}
        />
      ))}
      <Definitions />
    </div>
  );
}
