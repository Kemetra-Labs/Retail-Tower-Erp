/**
 * RT-1515 (PR 1) — shipment Transfers, read only. The tenant's Transfers newest
 * first (`listShipmentTransfers`), filtered by the contract's own filters (a
 * store, its direction, a state), with a deliberate Load more; a failed
 * continuation keeps the loaded rows and retries at the boundary (UX-10.18).
 * A row's Open control shows the Transfer in a drawer, so the table keeps its
 * place, filters and focus (UX-10.31).
 *
 * The filters live in the URL, so a reload keeps them; each change starts a
 * fresh list (the cursor is bound to the filters). Until the tenant's shipment
 * workflow is switched on the API answers the non-disclosing 404, which reads
 * as "not available for this organization", never as an empty list.
 *
 * Gate first, as the other inventory views: a role outside the read roles gets
 * NoAccess and nothing is requested. The API still decides every read (a store
 * manager sees only Transfers touching its stores). Nothing is written here.
 */
import { DataTableSkeleton } from "@/components/DataTableSkeleton";
import { DetailPanel } from "@/components/DetailPanel";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { DateTime, type T, formatNumber, useT } from "@/i18n";
import type { ShipmentTransfer, ShipmentTransferFilter } from "@/lib/inventory-queries";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { BackLink, InventoryReadGate, LoadMore, StaleError } from "../parts";
import type { InventoryScope, PagedState } from "../useInventory";
import { usePickerStores } from "../usePickerStores";
import { TransferDrawer } from "./TransferDrawer";
import {
  CaptionedTable,
  LegBadge,
  StateBadge,
  StoreName,
  TransferError,
  useStoreNames,
} from "./TransferParts";
import {
  TRANSFER_STATES,
  type TransferDirection,
  filterFromParams,
  hasFilter,
  isNotAvailable,
  paramsFromFilter,
  transferStateKey,
} from "./transferLogic";
import { useShipmentTransfers } from "./useTransfers";
import "../../shell/surface.css";
import "../inventory.css";
import "./transfers.css";

type StoreNames = ReadonlyMap<string, string>;

function columns(t: T): { key: string; header: string }[] {
  return [
    { key: "created", header: t("transfers.list.col.created") },
    { key: "route", header: t("transfers.list.col.route") },
    { key: "state", header: t("transfers.list.col.state") },
    { key: "lines", header: t("transfers.list.col.lines") },
    { key: "receipts", header: t("transfers.list.col.receipts") },
    { key: "dispatchErp", header: t("transfers.list.col.dispatchErp") },
  ];
}

function TransferRow({
  transfer,
  names,
  onOpen,
}: Readonly<{
  transfer: ShipmentTransfer;
  names: StoreNames;
  onOpen: (id: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <tr className="data-table__row data-table__row--static">
      <th scope="row">
        <button
          type="button"
          className="btn-ghost transfers__open"
          onClick={() => onOpen(transfer.id)}
        >
          <DateTime value={transfer.createdAt} />
          <span className="sr-only">{t("transfers.list.openHint")}</span>
        </button>
      </th>
      <td className="inventory__wrap">
        {t.rich("transfers.route", {
          source: <StoreName id={transfer.sourceStoreId} names={names} />,
          destination: <StoreName id={transfer.destinationStoreId} names={names} />,
        })}
      </td>
      <td>
        <StateBadge state={transfer.state} />
      </td>
      <td className="num">
        <bdi dir="ltr">{formatNumber(transfer.lines.length)}</bdi>
      </td>
      <td className="num">
        <bdi dir="ltr">{formatNumber(transfer.receiptCount)}</bdi>
      </td>
      <td>
        <LegBadge state={transfer.dispatchIntegrationState} />
      </td>
    </tr>
  );
}

function Filters({
  filter,
  stores,
  names,
  onChange,
}: Readonly<{
  filter: ShipmentTransferFilter;
  stores: readonly { id: string; name?: string }[];
  names: StoreNames;
  onChange: (next: ShipmentTransferFilter) => void;
}>): React.JSX.Element {
  const t = useT();
  // A store the URL names but the picker does not list still shows as chosen.
  const options =
    filter.storeId && !stores.some((s) => s.id === filter.storeId)
      ? [...stores, { id: filter.storeId, name: names.get(filter.storeId) }]
      : stores;
  return (
    <fieldset className="transfers__filters">
      <legend className="sr-only">{t("transfers.filter.legend")}</legend>
      <div className="field">
        <label htmlFor="transfer-store-filter">{t("transfers.filter.store")}</label>
        <select
          id="transfer-store-filter"
          className="input"
          value={filter.storeId ?? ""}
          onChange={(e) =>
            onChange({ ...filter, storeId: e.target.value || undefined, direction: undefined })
          }
        >
          <option value="">{t("transfers.filter.store.all")}</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? s.id}
            </option>
          ))}
        </select>
      </div>
      {/* The API ignores a direction without a store, so it is offered only then. */}
      {filter.storeId ? (
        <div className="field">
          <label htmlFor="transfer-direction-filter">{t("transfers.filter.direction")}</label>
          <select
            id="transfer-direction-filter"
            className="input"
            value={filter.direction ?? "any"}
            onChange={(e) =>
              onChange({ ...filter, direction: e.target.value as TransferDirection })
            }
          >
            <option value="any">{t("transfers.filter.direction.any")}</option>
            <option value="outbound">{t("transfers.filter.direction.outbound")}</option>
            <option value="inbound">{t("transfers.filter.direction.inbound")}</option>
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="transfer-state-filter">{t("transfers.filter.state")}</label>
        <select
          id="transfer-state-filter"
          className="input"
          value={filter.state ?? ""}
          onChange={(e) =>
            onChange({
              ...filter,
              state: (e.target.value || undefined) as ShipmentTransferFilter["state"],
            })
          }
        >
          <option value="">{t("transfers.filter.state.all")}</option>
          {TRANSFER_STATES.map((s) => (
            <option key={s} value={s}>
              {t(transferStateKey(s))}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

function ResetButton({ onReset }: Readonly<{ onReset: () => void }>): React.JSX.Element {
  const t = useT();
  return (
    <button type="button" className="btn-secondary" onClick={onReset}>
      {t("transfers.filter.reset")}
    </button>
  );
}

function ListBody({
  list,
  filtered,
  names,
  onOpen,
  onReset,
}: Readonly<{
  list: PagedState<ShipmentTransfer>;
  filtered: boolean;
  names: StoreNames;
  onOpen: (id: string) => void;
  onReset: () => void;
}>): React.JSX.Element {
  const t = useT();
  const cols = columns(t);
  const caption = t("transfers.list.caption");
  if (list.isLoading) {
    return (
      <DataTableSkeleton caption={caption} columns={cols} label={t("transfers.list.loadingNoun")} />
    );
  }
  if (isNotAvailable(list.error)) {
    return (
      <div className="inventory__panel-body">
        <ListState
          state="empty"
          emptyMessage={t("transfers.notAvailable")}
          emptyHint={t(
            filtered ? "transfers.notAvailable.filtered" : "transfers.notAvailable.hint",
          )}
          action={filtered ? <ResetButton onReset={onReset} /> : undefined}
        />
      </div>
    );
  }
  if (list.error) {
    return (
      <div className="inventory__panel-body">
        <TransferError
          error={list.error}
          failedKey="transfers.list.loadFailed"
          onRetry={list.retry}
        />
      </div>
    );
  }
  if (list.rows.length === 0 && !list.hasMore) {
    return (
      <div className="inventory__panel-body">
        {filtered ? (
          <ListState
            state="empty"
            emptyMessage={t("transfers.list.emptyFiltered")}
            action={<ResetButton onReset={onReset} />}
          />
        ) : (
          <ListState state="empty" emptyMessage={t("transfers.list.empty")} />
        )}
      </div>
    );
  }
  return (
    <>
      <CaptionedTable caption={caption}>
        <thead>
          <tr>
            {cols.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={col.key === "lines" || col.key === "receipts" ? "num" : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.rows.map((transfer) => (
            <TransferRow key={transfer.id} transfer={transfer} names={names} onOpen={onOpen} />
          ))}
        </tbody>
      </CaptionedTable>
      {list.inlineError ? (
        <div className="inventory__panel-body">
          <StaleError error={list.inlineError} onRetry={list.retry} />
        </div>
      ) : null}
      <LoadMore
        hasMore={list.hasMore}
        isFetching={list.isFetchingNextPage}
        label={t("transfers.list.loadMore")}
        onLoadMore={list.loadMore}
      />
    </>
  );
}

function TransfersView({ scope }: Readonly<{ scope: InventoryScope }>): React.JSX.Element {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const filter = filterFromParams(params);
  const [openId, setOpenId] = useState<string | null>(null);
  const picker = usePickerStores(scope);
  const names = useStoreNames(scope.tenantId);
  const list = useShipmentTransfers(scope, filter);
  const setFilter = (next: ShipmentTransferFilter) => setParams(paramsFromFilter(next));
  return (
    <div className="surface inventory--v4 transfers">
      <BackLink to="/inventory" label={t("inventory.store.back")} />
      <ListHeaderBand
        group={t("shell.nav.section.stock")}
        title={t("transfers.title")}
        subtitle={t("transfers.sub")}
      />
      <div className="inventory__strip">
        <p className="inventory__note">{t("transfers.note.readOnly")}</p>
        <p className="inventory__note">{t("transfers.note.inTransit")}</p>
      </div>
      <DetailPanel
        id="transfers-list"
        index={1}
        title={t("transfers.list.title")}
        aside={
          <Filters filter={filter} stores={picker.stores} names={names} onChange={setFilter} />
        }
      >
        <ListBody
          list={list}
          filtered={hasFilter(filter)}
          names={names}
          onOpen={setOpenId}
          onReset={() => setFilter({})}
        />
      </DetailPanel>
      {openId ? (
        <TransferDrawer
          scope={scope}
          transferId={openId}
          names={names}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

export function InventoryTransfers(): React.JSX.Element {
  return <InventoryReadGate>{(scope) => <TransfersView scope={scope} />}</InventoryReadGate>;
}
