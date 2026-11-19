/**
 * RT-1312 (Phase 3(b) slice B) — Sales the till could not send (`consoleListQuarantinedSales`), for
 * owner / tenant_admin: sales a till uploaded because Backend-Core refused them for good, or the
 * till held them after a re-pair. They have no sale record yet. Newest first, keyset paged with a
 * deliberate Load more; a failed continuation keeps the loaded rows. Read-only: each row opens its
 * item page, which carries the guarded write-off. There is no bulk action here.
 *
 * This is NOT the ERP-sync queue of `src/sale-sync/` (RT-726, sales Backend-Core captured whose
 * processing stopped). The two stay separate pages with their own words and a link between them.
 *
 * Gate first: any other role gets NoAccess and nothing is requested. The store and state filters
 * live in the URL (`?store=`, `?state=`; no state means the open queue), offer only the caller's
 * in-scope stores and the contract's four states, and are filters, not a scope change. A malformed
 * value is never sent; an out-of-scope store reads as not available (the API's non-disclosing 404).
 */
import { Banner } from "@/components/Banner";
import { FilterBar, FilterField } from "@/components/FilterBar";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { DateTime, type T, useT } from "@/i18n";
import type { QuarantinedSale } from "@/lib/sale-quarantine-queries";
import { QueueAsOf, QueueTable } from "@/sale-sync/QueueTable";
import { StoreOptions } from "@/sale-sync/StoreOptions";
import { SyncOpsGate } from "@/sale-sync/SyncOpsGate";
import { Machine } from "@/sale-sync/parts";
import { isStoreFilter } from "@/sale-sync/saleSyncLogic";
import { type FilterStore, useFilterStores } from "@/sale-sync/useFilterStores";
import type { SaleScope } from "@/sales/useSales";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { QuarantineStateBadge, TillTotal } from "./parts";
import { isQuarantineStateFilter, reasonKindKey } from "./quarantineLogic";
import { useQuarantineList } from "./useQuarantine";
import "../shell/surface.css";
import "../sale-sync/sale-sync.css";

/** The four states the contract lists, in the order the filter offers them. */
const STATE_OPTIONS = [
  ["open", "saleQuarantine.state.open"],
  ["captured", "saleQuarantine.state.captured"],
  ["already-captured", "saleQuarantine.state.alreadyCaptured"],
  ["written-off", "saleQuarantine.state.writtenOff"],
] as const;

const OPEN = "open";

interface Applied {
  store: string;
  /** "" is the open queue. */
  state: string;
}

function Filters({
  stores,
  applied,
  onApply,
}: Readonly<{
  stores: readonly FilterStore[];
  applied: Applied;
  onApply: (next: Applied) => void;
}>): React.JSX.Element {
  const t = useT();
  // A state the contract does not list is never offered back: the select starts on the open queue.
  const shown = { ...applied, state: isQuarantineStateFilter(applied.state) ? applied.state : "" };
  const [draft, setDraft] = useState<Applied>(shown);
  const [synced, setSynced] = useState(applied);
  if (synced.store !== applied.store || synced.state !== applied.state) {
    setSynced(applied);
    setDraft(shown);
  }
  // A URL store the roster does not list stays selectable, so its 404 is visible.
  const listed =
    applied.store && !stores.some((s) => s.id === applied.store)
      ? [...stores, { id: applied.store }]
      : stores;
  return (
    <FilterBar
      label={t("saleQuarantine.filter.label")}
      onSubmit={(event) => {
        event.preventDefault();
        onApply({ ...draft, state: draft.state === OPEN ? "" : draft.state });
      }}
      onClear={() => {
        setDraft({ store: "", state: "" });
        onApply({ store: "", state: "" });
      }}
    >
      <FilterField id="quarantine-store" label={t("saleQuarantine.filter.store")}>
        <select
          id="quarantine-store"
          className="input"
          value={draft.store}
          onChange={(e) => setDraft({ ...draft, store: e.target.value })}
        >
          <StoreOptions stores={listed} allLabel={t("saleQuarantine.filter.allStores")} />
        </select>
      </FilterField>
      <FilterField id="quarantine-state" label={t("saleQuarantine.filter.state")}>
        <select
          id="quarantine-state"
          className="input"
          value={draft.state || OPEN}
          onChange={(e) => setDraft({ ...draft, state: e.target.value })}
        >
          {STATE_OPTIONS.map(([value, key]) => (
            <option key={value} value={value}>
              {t(key)}
            </option>
          ))}
        </select>
      </FilterField>
    </FilterBar>
  );
}

function headers(t: T): { key: string; header: string }[] {
  return [
    { key: "externalId", header: t("saleQuarantine.col.externalId") },
    { key: "store", header: t("saleQuarantine.col.store") },
    { key: "reason", header: t("saleQuarantine.col.reason") },
    { key: "total", header: t("saleQuarantine.col.total") },
    { key: "state", header: t("saleQuarantine.col.state") },
    { key: "receivedAt", header: t("saleQuarantine.col.receivedAt") },
  ];
}

function Row({
  item,
  storeName,
}: Readonly<{ item: QuarantinedSale; storeName?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <tr className="data-table__row data-table__row--static">
      <th scope="row">
        <Link
          to={`/quarantined-sales/${item.quarantineRef}`}
          aria-label={t("saleQuarantine.list.openItem", { ref: item.externalId })}
        >
          <Machine value={item.externalId} />
        </Link>
      </th>
      <td>
        {storeName ? <bdi dir="auto">{storeName}</bdi> : t("saleQuarantine.list.unknownStore")}
      </td>
      <td>
        {t(reasonKindKey(item.reasonKind))}
        {item.tillErrorCode ? (
          <>
            {" "}
            <Machine value={item.tillErrorCode} />
          </>
        ) : null}
      </td>
      <td className="sale-amount">
        <TillTotal total={item.summary.posTotal} currency={item.summary.currencyCode} />
      </td>
      <td>
        <QuarantineStateBadge code={item.state} />
      </td>
      <td>
        <DateTime value={item.receivedAt} />
      </td>
    </tr>
  );
}

function emptyMessageKey(applied: Applied) {
  if (applied.store) return "saleQuarantine.list.emptyStore" as const;
  return applied.state && applied.state !== OPEN
    ? ("saleQuarantine.list.emptyState" as const)
    : ("saleQuarantine.list.empty" as const);
}

function Content({ scope }: Readonly<{ scope: SaleScope }>): React.JSX.Element {
  const t = useT();
  const [search, setSearch] = useSearchParams();
  const applied: Applied = { store: search.get("store") ?? "", state: search.get("state") ?? "" };
  const stores = useFilterStores(scope.tenantId);
  const validStore = isStoreFilter(applied.store);
  const validState = isQuarantineStateFilter(applied.state);
  const enabled = validStore && validState;
  const list = useQuarantineList({ scope, storeId: applied.store, state: applied.state, enabled });
  const nameOf = (id: string) => stores.find((s) => s.id === id)?.name;

  return (
    <div className="surface sale-sync-surface">
      <ListHeaderBand
        group={t("erp.nav.section")}
        title={t("saleQuarantine.list.title")}
        subtitle={t.rich("saleQuarantine.list.bandSub", { tenant: <bdi>{scope.tenantName}</bdi> })}
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={list.refresh}
            disabled={!enabled}
          >
            {t("saleQuarantine.list.refresh")}
          </button>
        }
      />
      <div className="sale-sync__intro">
        <p className="sale-sync__note">
          {t.rich("saleQuarantine.list.sub", { tenant: <bdi>{scope.tenantName}</bdi> })}
        </p>
        <p className="sale-sync__note">{t("saleQuarantine.list.note")}</p>
        <p className="sale-sync__note">
          <Link to="/sales-needing-repair">{t("saleQuarantine.list.otherQueue")}</Link>
        </p>
      </div>
      <Filters
        stores={stores}
        applied={applied}
        onApply={(next) => {
          const params = new URLSearchParams();
          if (next.store) params.set("store", next.store);
          if (next.state) params.set("state", next.state);
          setSearch(params);
        }}
      />
      <div className="sale-sync__panel">
        {enabled ? (
          <QueueTable
            list={list}
            columns={headers(t)}
            caption={t("saleQuarantine.list.caption")}
            loadingNoun={t("saleQuarantine.list.loadingNoun")}
            failedKey="saleQuarantine.list.loadFailed"
            notFoundKey="saleQuarantine.list.storeNotFound"
            loadMoreKey="saleQuarantine.list.loadMore"
            empty={
              <>
                <ListState state="empty" emptyMessage={t(emptyMessageKey(applied))} />
                <p className="content__sub">{t("saleQuarantine.list.emptyHint")}</p>
              </>
            }
            rowKey={(item) => item.quarantineRef}
            renderRow={(item) => <Row item={item} storeName={nameOf(item.storeId)} />}
          />
        ) : (
          // A malformed filter is never sent: it reads as not available.
          <Banner
            variant="warning"
            message={t(
              validStore
                ? "saleQuarantine.list.stateNotFound"
                : "saleQuarantine.list.storeNotFound",
            )}
          />
        )}
        <QueueAsOf asOf={list.asOf} messageKey="saleQuarantine.list.asOf" />
      </div>
    </div>
  );
}

export function QuarantineList(): React.JSX.Element {
  return (
    <SyncOpsGate promptKey="saleQuarantine.list.scopePrompt">
      {(scope) => <Content scope={scope} />}
    </SyncOpsGate>
  );
}
