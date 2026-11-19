import { Banner } from "@/components/Banner";
/**
 * RT-726 — Sales needing repair (`consoleListNeedsRepair`), for owner /
 * tenant_admin. The server's open NEEDS_REPAIR queue, newest first, keyset
 * paged with a deliberate Load more; a failed continuation keeps the loaded
 * rows. Read-only: each row links to the sale, whose page carries the guarded
 * repair request. There is no bulk or "repair all" action here.
 *
 * Gate first: any other role gets NoAccess and nothing is requested. The
 * optional store filter lives in the URL (`?store=`), offers only the caller's
 * in-scope stores and is a filter, not a scope change. An out-of-scope or
 * malformed store reads as not available (the API's non-disclosing 404).
 */
import { SelectFilterBar } from "@/components/FilterBar";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { DateTime, type T, useT } from "@/i18n";
import type { NeedsRepairItem } from "@/lib/sale-sync-ops-queries";
import type { SaleScope } from "@/sales/useSales";
import { Link, useSearchParams } from "react-router";
import { QueueAsOf, QueueTable } from "./QueueTable";
import { SyncOpsGate } from "./SyncOpsGate";
import { Machine } from "./parts";
import { isStoreFilter } from "./saleSyncLogic";
import { type FilterStore, useFilterStores } from "./useFilterStores";
import { type NeedsRepairState, useNeedsRepairList } from "./useSaleSync";
import "../shell/surface.css";
import "./sale-sync.css";

/** The queue's store filter, on the shared FilterBar (RT-960): Apply, Clear. */
function StoreFilter({
  stores,
  value,
  onApply,
}: Readonly<{
  stores: readonly FilterStore[];
  value: string;
  onApply: (storeId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  // A URL store the roster does not list stays selectable, so its 404 is visible.
  const listed = value && !stores.some((s) => s.id === value) ? [...stores, { id: value }] : stores;
  return (
    <SelectFilterBar
      label={t("saleSync.filter.label")}
      id="needs-repair-store"
      fieldLabel={t("saleSync.filter.store")}
      value={value}
      allLabel={t("saleSync.filter.allStores")}
      options={listed.map((store) => ({ value: store.id, label: store.name ?? store.id }))}
      onApply={onApply}
    />
  );
}

function headers(t: T): { key: string; header: string }[] {
  return [
    { key: "externalId", header: t("saleSync.col.externalId") },
    { key: "store", header: t("saleSync.col.store") },
    { key: "source", header: t("saleSync.col.source") },
    { key: "reason", header: t("saleSync.col.reason") },
    { key: "retries", header: t("saleSync.col.retries") },
    { key: "quarantinedAt", header: t("saleSync.col.quarantinedAt") },
  ];
}

function Row({
  item,
  storeName,
}: Readonly<{ item: NeedsRepairItem; storeName?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <tr className="data-table__row data-table__row--static">
      <th scope="row">
        <Link
          to={`/sales/${item.saleRef}`}
          aria-label={t("saleSync.list.openSale", { ref: item.externalId })}
        >
          <Machine value={item.externalId} />
        </Link>
      </th>
      <td>{storeName ? <bdi dir="auto">{storeName}</bdi> : t("saleSync.list.unknownStore")}</td>
      <td>
        <Machine value={item.sourceSystem} />
      </td>
      <td>
        <Machine value={item.reasonCode} />
      </td>
      <td className="sale-amount">
        {item.retryCount ?? <span className="muted">{t("saleSync.value.notRecorded")}</span>}
      </td>
      <td>
        <DateTime value={item.quarantinedAt} />
      </td>
    </tr>
  );
}

function Rows({
  list,
  filtered,
  nameOf,
}: Readonly<{
  list: NeedsRepairState;
  filtered: boolean;
  nameOf: (id: string) => string | undefined;
}>): React.JSX.Element {
  const t = useT();
  return (
    <QueueTable
      list={list}
      columns={headers(t)}
      caption={t("saleSync.list.caption")}
      loadingNoun={t("saleSync.list.loadingNoun")}
      failedKey="saleSync.list.loadFailed"
      notFoundKey="saleSync.list.storeNotFound"
      loadMoreKey="saleSync.list.loadMore"
      empty={
        <>
          <ListState
            state="empty"
            emptyMessage={t(filtered ? "saleSync.list.emptyStore" : "saleSync.list.empty")}
          />
          <p className="content__sub">{t("saleSync.list.emptyHint")}</p>
        </>
      }
      rowKey={(item) => item.saleRef}
      renderRow={(item) => <Row item={item} storeName={nameOf(item.storeId)} />}
    />
  );
}

function Content({ scope }: Readonly<{ scope: SaleScope }>): React.JSX.Element {
  const t = useT();
  const [search, setSearch] = useSearchParams();
  const storeId = search.get("store") ?? "";
  const stores = useFilterStores(scope.tenantId);
  const validStore = isStoreFilter(storeId);
  const list = useNeedsRepairList({ scope, storeId, enabled: validStore });
  const nameOf = (id: string) => stores.find((s) => s.id === id)?.name;

  return (
    <div className="surface sale-sync-surface">
      {/* RT-1011 (D-V9 amendment 2026-10-31): the band holds the group, title, scope and the
          refresh; it serves no whole-set fact (the queue is paged), so it carries none. */}
      <ListHeaderBand
        group={t("erp.nav.section")}
        title={t("saleSync.list.title")}
        subtitle={t.rich("saleSync.list.bandSub", { tenant: <bdi>{scope.tenantName}</bdi> })}
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={list.refresh}
            disabled={!validStore}
          >
            {t("saleSync.list.refresh")}
          </button>
        }
      />
      <div className="sale-sync__intro">
        <p className="sale-sync__note">
          {t.rich("saleSync.list.sub", { tenant: <bdi>{scope.tenantName}</bdi> })}
        </p>
        <p className="sale-sync__note">{t("saleSync.list.note")}</p>
        <p className="sale-sync__note">
          <Link to="/quarantined-sales">{t("saleSync.list.otherQueue")}</Link>
        </p>
      </div>
      <StoreFilter
        stores={stores}
        value={storeId}
        onApply={(next) => setSearch(next ? new URLSearchParams({ store: next }) : {})}
      />
      <div className="sale-sync__panel">
        {validStore ? (
          <Rows list={list} filtered={storeId !== ""} nameOf={nameOf} />
        ) : (
          // A malformed store filter is never sent: it reads as not available.
          <Banner variant="warning" message={t("saleSync.list.storeNotFound")} />
        )}
        <QueueAsOf asOf={list.asOf} messageKey="saleSync.list.asOf" />
      </div>
    </div>
  );
}

export function NeedsRepairList(): React.JSX.Element {
  return (
    <SyncOpsGate promptKey="saleSync.list.scopePrompt">
      {(scope) => <Content scope={scope} />}
    </SyncOpsGate>
  );
}
