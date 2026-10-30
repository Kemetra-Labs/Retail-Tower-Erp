/**
 * RT-970 recent sales: the newest five of the active store from the existing
 * sales list (`consoleListSales`), with the RT-956 ERPNext badges. The list
 * needs a store (`store_id` is required), so tenant-wide the panel says so
 * instead of reading. A table inside a section panel under its header
 * (DESIGN.md §5 v3.0); each sale number opens the sale.
 */
import { DataTableScroll } from "@/components/DataTableScroll";
import { DateTime, Money, useT } from "@/i18n";
import type { SaleItem } from "@/lib/sale-queries";
import { ErpChip, RecordedName, SaleNumber } from "@/sales/SaleParts";
import { useId } from "react";
import { Link } from "react-router";
import { PanelError, PanelSkeleton } from "./PanelParts";
import type { RecentSalesPage, RecentSalesState } from "./useGlancePanels";

function Rows({ page }: Readonly<{ page: RecentSalesPage }>): React.JSX.Element {
  const t = useT();
  const captionId = useId();
  return (
    // A wide table scrolls in its own region, never the page (RT-826).
    <DataTableScroll captionId={captionId}>
      <table className="glance-table glance-table--edge">
        <caption id={captionId} className="sr-only">
          {t("overview.recent.title")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("sales.list.col.saleNumber")}</th>
            <th scope="col">{t("sales.list.col.occurredAt")}</th>
            <th scope="col">{t("sales.list.col.operator")}</th>
            <th scope="col" className="glance-table__num">
              {t("sales.list.col.total")}
            </th>
            <th scope="col">ERPNext</th>
          </tr>
        </thead>
        <tbody>
          {page.sales.map((sale: SaleItem) => (
            <tr key={sale.saleRef}>
              <th scope="row">
                <Link className="glance-table__ref" to={`/sales/${sale.saleRef}`}>
                  <SaleNumber value={sale.saleNumber} />
                </Link>
              </th>
              <td>
                <DateTime value={sale.occurredAt} timeZone={page.timeZone} />
              </td>
              <td>
                <RecordedName name={sale.operator.displayName} source={sale.operator.nameSource} />
              </td>
              <td className="glance-table__num">
                <Money value={sale.posTotal} currency={sale.currencyCode} />
              </td>
              <td>
                <ErpChip state={sale.erpPostingState} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTableScroll>
  );
}

function Body({ state }: Readonly<{ state: RecentSalesState }>): React.JSX.Element | null {
  const t = useT();
  switch (state.status) {
    case "needs-store":
      return <p className="glance-quiet section-panel__body">{t("overview.recent.needsStore")}</p>;
    case "loading":
      return (
        <div className="section-panel__body">
          <PanelSkeleton lines={5} />
        </div>
      );
    case "error":
      return (
        <div className="section-panel__body">
          <PanelError requestId={state.requestId} retry={state.retry} />
        </div>
      );
    case "ready":
      return state.data.sales.length === 0 ? (
        <p className="glance-quiet section-panel__body">{t("overview.recent.none")}</p>
      ) : (
        <Rows page={state.data} />
      );
    default:
      return null;
  }
}

export function RecentSales({
  state,
}: Readonly<{ state: RecentSalesState }>): React.JSX.Element | null {
  const t = useT();
  if (state.status === "hidden") return null;
  return (
    // Not a landmark itself: the table's scroll region is the "Latest sales"
    // region (landmark-unique).
    <div className="section-panel">
      <div className="section-panel__head">
        <h2 id="overview-recent" className="section-panel__title">
          {t("overview.recent.title")}
        </h2>
        <Link className="ledger__link glance-head-link" to="/sales">
          {t("overview.recent.all")}
        </Link>
      </div>
      <Body state={state} />
    </div>
  );
}
