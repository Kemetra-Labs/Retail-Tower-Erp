import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { SectionIndex } from "@/components/SectionIndex";
import { formatNumber, type MessageKey, useT } from "@/i18n";
import { BusinessDate } from "@/sales/SaleParts";
import { STATE_MARK } from "@/sales-daily/DailyCells";
import { useId } from "react";
import { Link } from "react-router";
import type { PostingDayRow, PostingHealthModel, PostingVerdict } from "./postingHealthLogic";

const VERDICT_KEY: Record<PostingVerdict, MessageKey> = {
  fullyPosted: "postingHealth.verdict.fullyPosted",
  needsAttention: "postingHealth.verdict.needsAttention",
  unknownRows: "postingHealth.verdict.unknownRows",
  noSales: "postingHealth.verdict.noSales",
  noData: "postingHealth.verdict.noData",
  running: "postingHealth.verdict.running",
  notBegun: "postingHealth.verdict.notBegun",
};

function Unknown(): React.JSX.Element {
  const t = useT();
  return <span className="posting-table__unknown">{t("metrics.claim.unknown")}</span>;
}

function Count({ value }: Readonly<{ value: number | null }>): React.JSX.Element {
  const t = useT();
  if (value === null) return <Unknown />;
  return <span className="posting-table__count">{formatNumber(value, t.locale)}</span>;
}

function DayCell({ row }: Readonly<{ row: PostingDayRow }>): React.JSX.Element {
  const t = useT();
  return (
    <th scope="row">
      <BusinessDate value={row.date} />
      {row.state === "complete" ? null : (
        <span className="posting-table__mark"> {t(STATE_MARK[row.state])}</span>
      )}
    </th>
  );
}

/**
 * One table over the range's business days: the served posting counts per day
 * and the day's verdict, in words. Plain semantic table, not `DataTable`: a
 * report row opens nothing, so no row is a tab stop. The footer is the
 * server's `rangeTotals`, never a sum of the rows. A day missing from the read
 * is the word Unknown, never 0; a day still running is marked in words, never
 * by colour alone.
 */
export function PostingHealthTable({
  model,
}: Readonly<{ model: PostingHealthModel }>): React.JSX.Element {
  const t = useT();
  const captionId = useCaptionId();
  const hintId = useId();
  return (
    <section className="section-panel posting-report__table">
      <div className="section-panel__head">
        <SectionIndex position={1} />
        <h2 className="section-panel__title">{t("postingHealth.table.caption")}</h2>
      </div>
      <p id={hintId} className="posting-report__hint">
        {t("postingHealth.table.hint")}
      </p>
      <p className="posting-report__summary">
        {t("postingHealth.summary.days", {
          fully: formatNumber(model.fullyPostedDays, t.locale),
          total: formatNumber(model.completedDays, t.locale),
        })}
        {model.daysWithFailures > 0 ? (
          <>
            {" "}
            {t("postingHealth.summary.failures", {
              days: formatNumber(model.daysWithFailures, t.locale),
            })}
          </>
        ) : null}
      </p>
      <DataTableScroll captionId={captionId}>
        <table className="data-table posting-table" aria-describedby={hintId}>
          <caption id={captionId} className="data-table__caption">
            {t("postingHealth.table.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("postingHealth.col.day")}</th>
              <th scope="col">{t("postingHealth.col.posted")}</th>
              <th scope="col">{t("postingHealth.col.pending")}</th>
              <th scope="col">{t("postingHealth.col.failed")}</th>
              <th scope="col">{t("postingHealth.col.unknown")}</th>
              <th scope="col">{t("postingHealth.col.verdict")}</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.date} data-business-date={row.date}>
                <DayCell row={row} />
                <td><Count value={row.posted} /></td>
                <td><Count value={row.pending} /></td>
                <td><Count value={row.failed} /></td>
                <td><Count value={row.unknown} /></td>
                <td>{t(VERDICT_KEY[row.verdict])}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                {t(model.partial ? "postingHealth.row.totalSoFar" : "postingHealth.row.total")}
              </th>
              <td><Count value={model.totals?.posted ?? null} /></td>
              <td><Count value={model.totals?.pending ?? null} /></td>
              <td><Count value={model.totals?.failed ?? null} /></td>
              <td><Count value={model.totals?.unknown ?? null} /></td>
              <td>—</td>
            </tr>
          </tfoot>
        </table>
      </DataTableScroll>
      <p className="posting-report__repair">
        {t("postingHealth.repairHint")}{" "}
        <Link to="/sales-needing-repair">{t("reports.item.salesRepair.title")}</Link>
      </p>
    </section>
  );
}
