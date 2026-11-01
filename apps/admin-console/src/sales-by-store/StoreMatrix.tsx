/**
 * RT-1054 section 02 «متجر × يوم عمل»: each store's received amount on each
 * business day, in the ranking currency, exactly as served. The board's heat
 * ramp needs each cell divided by the largest, which the Console may not do
 * (AI-13), so a cell carries its meaning in words and a pattern instead:
 * a day still running is hatched and named, a day not begun is named, a zero
 * is faded, and the store's served best day carries a star.
 */
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { DetailPanel } from "@/components/DetailPanel";
import { formatMoney, useT } from "@/i18n";
import type { SalesByStore } from "@/lib/sales-by-store-queries";
import { BusinessDate } from "@/sales/SaleParts";
import { DAY_STATE_MARK, type DayCell, type StoreRow, isZeroAmount } from "./storeLogic";

/** `1250.5000` → `1,250.50`; a real zero is `0`. The currency is named by the section. */
function amountOf(total: string): string {
  return isZeroAmount(total) ? "0" : formatMoney(total, "").trim();
}

function DayHead({ date }: Readonly<{ date: string }>): React.JSX.Element {
  return (
    <th scope="col">
      <span className="sr-only">
        <BusinessDate value={date} />
      </span>
      <span aria-hidden="true">{date.slice(8)}</span>
    </th>
  );
}

function Cell({ cell, selected }: Readonly<{ cell: DayCell | undefined; selected: boolean }>) {
  const t = useT();
  if (!cell) return <td className="sbs-cell" />;
  const mark = DAY_STATE_MARK[cell.state];
  const classes = [
    "sbs-cell",
    cell.state === "so_far" ? "sbs-cell--so-far" : "",
    cell.state === "not_begun" ? "sbs-cell--not-begun" : "",
    isZeroAmount(cell.total) ? "sbs-cell--zero" : "",
    selected ? "sbs-cell--on" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <td className={classes}>
      <bdi dir="ltr">{amountOf(cell.total)}</bdi>
      {cell.best ? (
        <>
          <span className="sbs-cell__best" aria-hidden="true">
            ★
          </span>
          <span className="sr-only"> {t("salesByStore.matrix.best")}</span>
        </>
      ) : null}
      {mark ? <span className="sr-only"> {t(mark)}</span> : null}
    </td>
  );
}

export function StoreMatrix({
  report,
  rows,
  pickedRef,
}: Readonly<{
  report: SalesByStore;
  rows: readonly StoreRow[];
  pickedRef: string | undefined;
}>): React.JSX.Element {
  const t = useT();
  const captionId = useCaptionId();
  return (
    <DetailPanel id="sbs-matrix-h" title={t("salesByStore.matrix.title")} index={2}>
      <p className="sbs-hint sbs-hint--panel">{t("salesByStore.matrix.hint")}</p>
      <DataTableScroll captionId={captionId}>
        <table className="sbs-matrix">
          <caption id={captionId} className="sr-only">
            {`${t("salesByStore.matrix.caption")} (${report.currency})`}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">{t("salesByStore.matrix.store")}</span>
              </th>
              {report.days.map((d) => (
                <DayHead key={d.businessDate} date={d.businessDate} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const byDate = new Map(row.cells.map((c) => [c.businessDate, c]));
              const selected = row.store.storeRef === pickedRef;
              return (
                <tr
                  key={row.store.storeRef}
                  className={selected ? "sbs-matrix__row--on" : undefined}
                >
                  <th scope="row">
                    <bdi>{row.store.storeName}</bdi>
                  </th>
                  {report.days.map((d) => (
                    <Cell
                      key={d.businessDate}
                      cell={byDate.get(d.businessDate)}
                      selected={selected}
                    />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataTableScroll>
      <p className="sbs-hint sbs-hint--panel">{t("salesByStore.matrix.legend")}</p>
    </DetailPanel>
  );
}
