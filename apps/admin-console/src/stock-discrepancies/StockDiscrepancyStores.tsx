import { Banner } from "@/components/Banner";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { DetailPanel } from "@/components/DetailPanel";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { DateTime, useT } from "@/i18n";
import type { StoreNegativeOnHandSummary } from "@/lib/stock-discrepancy-queries";
/**
 * RT-178 — ERPNext stock discrepancies, store summary list. One row per store
 * the API returns for the caller (owner / tenant_admin: their membership's
 * stores; store_manager: its scoped stores — the list is exactly what the API
 * returns, never filtered or widened here). Each row shows the API's snapshot
 * status, the "as of" time when a snapshot exists, and the negative item count;
 * `no_snapshot` / `no_warehouse_mapping` read "Unknown", never "0 issues".
 * A 404 (role not allowed) renders as not-found. Each store's "as of" time is
 * an operational instant (`<DateTime>`, UTC-labelled until RT-401).
 *
 * RT-1017 (v4.0): the Ink list band names the tenant and carries no facts, no
 * action and no count: the list is paged and the API serves no whole-set
 * figure. The stores sit in one panel under a legend that says a snapshot is a
 * dated read and "Unknown" is not zero. Errors stay below the band, outside the
 * panel; the band never changes with state.
 */
import { Link } from "react-router";
import { InlineLoadError, LoadMoreButton, TenantScopePrompt, useDiscrepancyScope } from "./shared";
import { asOfTime, negativeCountLabel, statusView, storeInitials } from "./stockDiscrepancyLogic";
import { type StockDiscrepancyError, useNegativeOnHandStores } from "./useStockDiscrepancies";
import "../shell/surface.css";
import "./stock-discrepancies.css";

type StoresData = ReturnType<typeof useNegativeOnHandStores>;

/** The three states a store's snapshot can read, named once above the rows. */
const LEGEND_STATUSES = ["fresh", "stale", "no_snapshot"] as const;

function StoresErrorBanner({
  error,
  onRetry,
}: Readonly<{ error: StockDiscrepancyError; onRetry: () => void }>): React.JSX.Element {
  const t = useT();
  if (error.kind === "not-found") {
    return (
      <Banner variant="danger" message={t("stock.stores.notFound")} requestId={error.requestId} />
    );
  }
  return (
    <Banner
      variant="danger"
      message={t("stock.loadFailed")}
      requestId={error.requestId}
      action={
        <button type="button" className="btn-secondary" onClick={onRetry}>
          {t("stock.retry")}
        </button>
      }
    />
  );
}

function AsOfCell({ row }: Readonly<{ row: StoreNegativeOnHandSummary }>): React.JSX.Element {
  const t = useT();
  const asOf = asOfTime(row.snapshot);
  const reasonKey = statusView(row.snapshot.status).noSnapshotReasonKey;
  return (
    <td>
      {asOf ? (
        <DateTime value={asOf} />
      ) : (
        <span className="muted">{reasonKey ? t(reasonKey) : null}</span>
      )}
    </td>
  );
}

function PendingCell({ row }: Readonly<{ row: StoreNegativeOnHandSummary }>): React.JSX.Element {
  const t = useT();
  return (
    <td>
      {row.snapshot.pendingRequest ? (
        <span className="badge badge--pending">{t("stock.stores.pending")}</span>
      ) : (
        <span className="muted">{t("stock.stores.noPending")}</span>
      )}
    </td>
  );
}

function StoreRow({ row }: Readonly<{ row: StoreNegativeOnHandSummary }>): React.JSX.Element {
  const t = useT();
  const view = statusView(row.snapshot.status);
  const count = negativeCountLabel(row.snapshot.status, row.negativeItemCount);
  return (
    <tr className="data-table__row">
      <td>
        <span className="stock-store">
          {/* Decorative: the name beside it is the cell's text. */}
          <span className="stock-store__tile" aria-hidden="true">
            {storeInitials(row.storeName)}
          </span>
          <Link to={`/stock-discrepancies/${row.storeId}`}>
            <bdi dir="auto">{row.storeName}</bdi>
          </Link>
        </span>
      </td>
      <td className="nowrap">
        <span className={view.badgeClass}>{t(view.labelKey)}</span>
      </td>
      <AsOfCell row={row} />
      <td>{t(count.key, count.params)}</td>
      <PendingCell row={row} />
    </tr>
  );
}

function StoresTable({
  stores,
}: Readonly<{ stores: StoreNegativeOnHandSummary[] }>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table stock-table">
          <caption id={captionId} className="data-table__caption">
            {t("stock.stores.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("stock.stores.col.store")}</th>
              <th scope="col">{t("stock.stores.col.snapshot")}</th>
              <th scope="col">{t("stock.stores.col.asOf")}</th>
              <th scope="col">{t("stock.stores.col.negativeItems")}</th>
              <th scope="col">{t("stock.stores.col.request")}</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((row) => (
              <StoreRow key={row.storeId} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

/**
 * What a snapshot state means, once, above the rows: the three states by their
 * own labels, and the two rules the page rests on (a snapshot is a dated read;
 * "Unknown" is not zero). Static copy, no data.
 */
function SnapshotLegend(): React.JSX.Element {
  const t = useT();
  return (
    <div className="stock-legend">
      <p className="stock-legend__lead">{t("stock.stores.sub")}</p>
      <ul className="stock-legend__states" aria-label={t("stock.stores.legendLabel")}>
        {LEGEND_STATUSES.map((status) => {
          const view = statusView(status);
          return (
            <li key={status}>
              <span className={view.badgeClass}>{t(view.labelKey)}</span>
            </li>
          );
        })}
      </ul>
      <p className="stock-legend__note">{t("stock.stores.legend")}</p>
    </div>
  );
}

/** Loading, empty, or the table — exactly one of them (an error is shown outside the panel). */
function StoresBody({ data }: Readonly<{ data: StoresData }>): React.JSX.Element {
  const t = useT();
  if (data.isLoading) return <ListState state="loading" label={t("stock.stores.loadingNoun")} />;
  if (data.stores.length === 0) {
    return <ListState state="empty" emptyMessage={t("stock.stores.empty")} />;
  }
  return <StoresTable stores={data.stores} />;
}

function StoresPanel({ data }: Readonly<{ data: StoresData }>): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel title={t("stock.stores.caption")} className="stock-results">
      <SnapshotLegend />
      <StoresBody data={data} />
      <div className="stock-results__foot">
        <InlineLoadError error={data.inlineError} onRetry={data.retryInline} />
        <LoadMoreButton
          hasMore={data.hasMore}
          isFetching={data.isFetchingNextPage}
          label={t("stock.stores.loadMore")}
          onLoadMore={data.loadMore}
        />
      </div>
    </DetailPanel>
  );
}

export function StockDiscrepancyStores(): React.JSX.Element {
  const t = useT();
  const { scope, tenantName } = useDiscrepancyScope();
  const data = useNegativeOnHandStores(scope);

  if (!scope.tenantId) return <TenantScopePrompt />;
  return (
    <div className="surface surface--v4">
      <ListHeaderBand
        group={t("shell.nav.section.operations")}
        title={t("stock.title")}
        subtitle={t.rich("stock.stores.bandSub", { tenant: <bdi>{tenantName ?? ""}</bdi> })}
      />
      {data.error ? (
        <StoresErrorBanner error={data.error} onRetry={data.refetch} />
      ) : (
        <StoresPanel data={data} />
      )}
    </div>
  );
}
