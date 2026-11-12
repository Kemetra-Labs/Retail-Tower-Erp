/**
 * RT-455 part 2 (OD-2): the recorded sale-line findings of tracked selling, on
 * their own keyset-paged read (`listSaleLineFindings`), newest first, filtered
 * by kind. They are append-only records of past sales, so they are never part
 * of the band's current-state counts (TR-8) and never show a total (UX-10.17).
 * This tab is also the sold-under-hold view of the Health set. Owner and
 * tenant_admin see the tenant, a store_manager its own stores; the identity link
 * needs an identity read, so a store_manager's rows carry none.
 */
import { TableScrollRegion } from "@/components/DataTableScroll";
import { useT } from "@/i18n";
import type { SaleLineFinding, SaleLineFindingKind } from "@/lib/tracking-queries";
import { useState } from "react";
import { Link } from "react-router";
import { Machine } from "../inventory/parts";
import type { InventoryScope } from "../inventory/useInventory";
import { PagedPanel } from "./PagedPanel";
import { ProductName, StoreName, When } from "./parts";
import { SALE_LINE_KINDS, canReadHolds, saleLineCauseKey, saleLineKindKey } from "./trackingLogic";
import { useSaleLineFindings } from "./useTracking";

function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body inventory__panel-body--solo">{children}</div>;
}

const HEADERS = [
  "tracking.saleLines.col.kind",
  "tracking.saleLines.col.cause",
  "tracking.col.product",
  "tracking.col.identity",
  "tracking.col.store",
  "tracking.resolution.col.sale",
  "tracking.saleLines.col.recordedAt",
] as const;

function FindingsTable({
  rows,
  linked,
}: Readonly<{ rows: readonly SaleLineFinding[]; linked: boolean }>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips" data-testid="tracking-saleline-table">
          <caption id={captionId} className="data-table__caption">
            {t("tracking.saleLines.caption")}
          </caption>
          <thead>
            <tr>
              {HEADERS.map((key) => (
                <th key={key} scope="col">
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="data-table__row data-table__row--static">
                <th scope="row">
                  <span className="badge badge--danger">{t(saleLineKindKey(row.kind))}</span>
                </th>
                <td>{t(saleLineCauseKey(row.cause))}</td>
                <td>
                  <ProductName id={row.tenantProductRef} />
                </td>
                <td>
                  {linked ? (
                    <Link to={`/tracking/identities/${row.trackingIdentityId}`}>
                      {t("tracking.identity.open")}
                    </Link>
                  ) : (
                    <Machine value={row.trackingIdentityId} />
                  )}
                </td>
                <td>
                  <StoreName id={row.storeId} />
                </td>
                <td>
                  <Machine value={row.saleId} />
                </td>
                <td>
                  <When iso={row.recordedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

export function SaleLinePanel({ scope }: Readonly<{ scope: InventoryScope }>): React.JSX.Element {
  const t = useT();
  const [kind, setKind] = useState<SaleLineFindingKind | "">("");
  const list = useSaleLineFindings(scope, kind || undefined);
  const body = (
    <PagedPanel
      list={list}
      loadingKey="tracking.saleLines.loadingNoun"
      failedKey="tracking.saleLines.loadFailed"
      emptyKey="tracking.saleLines.empty"
      moreKey="tracking.saleLines.loadMore"
    >
      {(rows) => <FindingsTable rows={rows} linked={canReadHolds(scope.role)} />}
    </PagedPanel>
  );
  return (
    <>
      <Body>
        <p className="tracking__muted">{t("tracking.saleLines.intro")}</p>
        <div className="field tracking__filter">
          <label htmlFor="saleline-kind">{t("tracking.saleLines.kindLabel")}</label>
          <select
            id="saleline-kind"
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as SaleLineFindingKind | "")}
          >
            <option value="">{t("tracking.saleLines.kindAll")}</option>
            {SALE_LINE_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(saleLineKindKey(value))}
              </option>
            ))}
          </select>
        </div>
      </Body>
      {body}
    </>
  );
}
