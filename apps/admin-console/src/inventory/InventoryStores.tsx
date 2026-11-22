import { Banner } from "@/components/Banner";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { GatedButton } from "@/components/GatedButton";
/**
 * RT-728 — Inventory, store picker. The stores whose inventory the caller may
 * read: with an active store, only that store (the API binds a store-scoped
 * session to it); otherwise the caller's in-scope stores (the scope menu's own
 * rule, RT-354). Each row opens the store's movement ledger and locations.
 * Read-only; picking a store here is navigation, never a scope change.
 *
 * Gate first: a role outside the read roles gets NoAccess and nothing is
 * requested.
 */
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { Link } from "react-router";
import { InventoryReadGate, Machine } from "./parts";
import type { InventoryScope } from "./useInventory";
import { type PickerState, type PickerStore, usePickerStores } from "./usePickerStores";
import "../shell/surface.css";
import "./inventory.css";

function StoresTable({ stores }: Readonly<{ stores: PickerStore[] }>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips">
          <caption id={captionId} className="data-table__caption">
            {t("inventory.stores.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("inventory.stores.col.store")}</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((store) => (
              <tr key={store.id} className="data-table__row data-table__row--static">
                <th scope="row">
                  <Link to={`/inventory/stores/${store.id}`}>
                    {store.name ? <bdi dir="auto">{store.name}</bdi> : <Machine value={store.id} />}
                  </Link>
                </th>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

function StoresBody({ picker }: Readonly<{ picker: PickerState }>): React.JSX.Element {
  const t = useT();
  if (picker.isLoading) {
    return <ListState state="loading" label={t("inventory.stores.loadingNoun")} />;
  }
  if (picker.failed) {
    return (
      <Banner
        variant="danger"
        message={t("inventory.stores.loadFailed")}
        action={
          <GatedButton type="button" className="btn-secondary" onClick={picker.retry}>
            {t("inventory.retry")}
          </GatedButton>
        }
      />
    );
  }
  if (picker.stores.length === 0) {
    return <ListState state="empty" emptyMessage={t("inventory.stores.empty")} />;
  }
  return <StoresTable stores={picker.stores} />;
}

function Content({ scope }: Readonly<{ scope: InventoryScope }>): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const picker = usePickerStores(scope);
  return (
    <div className="surface inventory--v4">
      {/* RT-1016 (C1): the band names the scope (tenant) and carries no fact. The
          picker list is filtered on the client (scope menu rule, or the pinned
          store), so a count of it would not be a figure the server serves. */}
      <ListHeaderBand
        group={t("shell.nav.section.stock")}
        title={t("inventory.nav.label")}
        subtitle={t.rich("inventory.stores.subTenant", {
          tenant: <bdi dir="auto">{context?.active_tenant?.name}</bdi>,
        })}
      />
      <div className="inventory__strip">
        <p className="inventory__note">{t("inventory.note.readOnly")}</p>
        {/* RT-1515: the shipment Transfers live inside the Inventory section
            (owner placement decision); this nav entry stays selected there. */}
        <Link className="inventory__note" to="/inventory/transfers">
          {t("transfers.entry")}
        </Link>
      </div>
      <div className="section-panel">
        <div className="inventory__panel-body inventory__panel-body--solo">
          <StoresBody picker={picker} />
        </div>
      </div>
    </div>
  );
}

export function InventoryStores(): React.JSX.Element {
  return <InventoryReadGate>{(scope) => <Content scope={scope} />}</InventoryReadGate>;
}
