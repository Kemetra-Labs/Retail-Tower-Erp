/**
 * RT-1020 (v4.0) the per-day panel beside the chart: one business day's served
 * figures, picked from a plain list of the range's days. It re-reads nothing and
 * calculates nothing: each line is the day's row of the two exact tables, shown
 * through the same cells (count, then one line per currency, never added; sync
 * and ERP parts as served).
 *
 * A day with no bucket in the read is the word Unknown with a note, never 0; a
 * day still running or not begun says so in words. The chart's bars keep their
 * own behaviour (they go to the table row), so the panel is chosen here, not by
 * the bars.
 */
import { SectionIndex } from "@/components/SectionIndex";
import { useT } from "@/i18n";
import { type SalesKpis, metricDefinition } from "@/metrics/metricRegistry";
import { BusinessDate } from "@/sales/SaleParts";
import { useId, useState } from "react";
import { Link } from "react-router";
import {
  MONEY_METRICS,
  MoneyCell,
  STATE_MARK,
  STATUS_METRICS,
  StatusCell,
  Unknown,
} from "./DailyCells";
import type { DayRow, ReportModel } from "./dailyLogic";
import { dayRowId, goToDayRow } from "./dayRowId";

/**
 * The row picked, else the latest day that has begun (a client clock ahead of the
 * server can leave the range's last day not begun), else the last day.
 */
function pickedRow(model: ReportModel, chosen: string | null): DayRow | undefined {
  return (
    model.rows.find((row) => row.date === chosen) ??
    [...model.rows].reverse().find((row) => row.state !== "not-begun") ??
    model.rows.at(-1)
  );
}

function DayFigures({ row }: Readonly<{ row: DayRow }>): React.JSX.Element {
  const t = useT();
  // The panel shows what the table shows: a day the read lacks is Unknown (with the
  // not-begun note when it has not begun); a day the read carries shows its served
  // figures, with the not-begun note above them when it has not begun.
  if (!row.kpis) {
    const note =
      row.state === "not-begun" ? "salesDaily.day.notBegunNote" : "salesDaily.day.unknownNote";
    return (
      <div className="daily-day__unknown">
        <Unknown />
        <p className="daily-report__hint">{t(note)}</p>
      </div>
    );
  }
  return (
    <>
      {row.state === "not-begun" ? (
        <p className="daily-report__hint">{t("salesDaily.day.notBegunNote")}</p>
      ) : null}
      <FigureList kpis={row.kpis} />
    </>
  );
}

function FigureList({ kpis }: Readonly<{ kpis: SalesKpis }>): React.JSX.Element {
  const t = useT();
  return (
    <dl className="daily-day__figures">
      {MONEY_METRICS.map((metric) => (
        <div key={metric}>
          <dt>{t(metricDefinition(metric).labelKey)}</dt>
          <dd>
            <MoneyCell kpis={kpis} metric={metric} />
          </dd>
        </div>
      ))}
      {STATUS_METRICS.map((metric) => (
        <div key={metric}>
          <dt>{t(metricDefinition(metric).labelKey)}</dt>
          <dd>
            <StatusCell kpis={kpis} metric={metric} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DayPanel({
  model,
  storeId,
  position,
}: Readonly<{
  model: ReportModel;
  /** The store of a one-store read; its Sales link needs one (a scope has none). */
  storeId: string | null;
  position: number;
}>): React.JSX.Element | null {
  const t = useT();
  const headingId = useId();
  const selectId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const row = pickedRow(model, chosen);
  if (!row) return null;
  const salesSearch = new URLSearchParams({ store: storeId ?? "", from: row.date, to: row.date });
  return (
    <aside className="section-panel daily-day" aria-labelledby={headingId}>
      <div className="section-panel__head">
        <SectionIndex position={position} />
        <h2 id={headingId} className="section-panel__title">
          {t("salesDaily.day.title")}
        </h2>
      </div>
      <div className="section-panel__body daily-day__body">
        <p className="daily-report__hint">{t("salesDaily.day.hint")}</p>
        <div className="daily-day__pick">
          <label htmlFor={selectId}>{t("salesDaily.day.pick")}</label>
          <select id={selectId} value={row.date} onChange={(e) => setChosen(e.target.value)}>
            {model.rows.map((r) => (
              <option key={r.date} value={r.date}>
                {r.state === "complete" ? r.date : `${r.date} ${t(STATE_MARK[r.state])}`}
              </option>
            ))}
          </select>
        </div>
        {/* The date and its figures are one live region: a new pick is announced whole. */}
        <div className="daily-day__live" aria-live="polite">
          <p className="daily-day__label">
            <BusinessDate value={row.date} />
            {row.state === "complete" ? null : (
              <span className="daily-table__mark"> {t(STATE_MARK[row.state])}</span>
            )}
          </p>
          <DayFigures row={row} />
        </div>
        <ul className="daily-day__links">
          {storeId ? (
            <li>
              <Link to={`/sales?${salesSearch.toString()}`}>{t("salesDaily.day.salesLink")}</Link>
            </li>
          ) : null}
          <li>
            <a href={`#${dayRowId(row.date)}`} onClick={(e) => goToDayRow(e, row.date)}>
              {t("salesDaily.day.rowLink")}
            </a>
          </li>
        </ul>
      </div>
    </aside>
  );
}
