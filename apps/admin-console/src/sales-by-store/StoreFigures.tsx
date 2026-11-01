/**
 * RT-1054 section 03 «الأرقام الدقيقة»: the exact figures behind the ranking.
 * Each served fact prints its count, then one line per currency, never added
 * across currencies. The footer is the server's `rangeTotals`, never a sum of
 * the rows; the baseline has no scope-level total, so its footer cell is empty.
 */
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { DetailPanel } from "@/components/DetailPanel";
import { Money, useT } from "@/i18n";
import type { SalesByStore } from "@/lib/sales-by-store-queries";
import { DeltaPill, FactsLines } from "./StoreCells";
import type { ReportModel } from "./storeLogic";

function Dash(): React.JSX.Element {
  const t = useT();
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("salesByStore.notAvailable")}</span>
    </>
  );
}

export function StoreFigures({
  report,
  model,
}: Readonly<{ report: SalesByStore; model: ReportModel }>): React.JSX.Element {
  const t = useT();
  const captionId = useCaptionId();
  const comparing = model.comparing;
  return (
    <DetailPanel id="sbs-table-h" title={t("salesByStore.table.title")} index={3}>
      <p className="sbs-hint sbs-hint--panel">{t("salesByStore.table.hint")}</p>
      <DataTableScroll captionId={captionId}>
        <table className="sbs-table">
          <caption id={captionId} className="sr-only">
            {t("salesByStore.table.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("salesByStore.table.col.store")}</th>
              <th scope="col">{t("salesByStore.table.col.sales")}</th>
              <th scope="col">{t("salesByStore.table.col.returns")}</th>
              <th scope="col">{t("salesByStore.table.col.voids")}</th>
              <th scope="col">{t("salesByStore.table.col.legacy")}</th>
              {comparing ? (
                <>
                  <th scope="col">
                    {t("salesByStore.table.col.baseline", { currency: report.currency })}
                  </th>
                  <th scope="col">{t("salesByStore.table.col.change")}</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {model.rows.map(({ store }) => (
              <tr key={store.storeRef}>
                <th scope="row">
                  <bdi>{store.storeName}</bdi>
                </th>
                <td>
                  <FactsLines facts={store.facts.receivedSales} />
                </td>
                <td>
                  <FactsLines facts={store.facts.returns} />
                </td>
                <td>
                  <FactsLines facts={store.facts.voids} />
                </td>
                <td>
                  <FactsLines facts={store.facts.legacyRefunds} />
                </td>
                {comparing ? (
                  <>
                    <td>
                      {store.ranking.baselineTotal === null ? (
                        <Dash />
                      ) : (
                        <Money value={store.ranking.baselineTotal} currency={report.currency} />
                      )}
                    </td>
                    <td>
                      <DeltaPill ratio={store.ranking.deltaRatio} />
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                {t(
                  model.includesSoFar
                    ? "salesByStore.table.totalSoFar"
                    : "salesByStore.table.total",
                )}
              </th>
              <td>
                <FactsLines facts={report.rangeTotals.receivedSales} />
              </td>
              <td>
                <FactsLines facts={report.rangeTotals.returns} />
              </td>
              <td>
                <FactsLines facts={report.rangeTotals.voids} />
              </td>
              <td>
                <FactsLines facts={report.rangeTotals.legacyRefunds} />
              </td>
              {comparing ? (
                <>
                  <td>
                    <Dash />
                  </td>
                  <td>
                    <Dash />
                  </td>
                </>
              ) : null}
            </tr>
          </tfoot>
        </table>
      </DataTableScroll>
    </DetailPanel>
  );
}
