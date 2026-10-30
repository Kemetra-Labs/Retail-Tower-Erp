/**
 * RT-560 store filter (spec 016 §4.5): the optional `store_id` on the three C3
 * reads, limited to the caller's in-scope stores, on the shared FilterBar
 * (RT-960): Apply, Clear. A filter, not a scope change:
 * it never touches the active store. A store id in the URL that the roster does
 * not list stays selectable as itself so the 404 it earns is visible.
 */
import { SelectFilterBar } from "@/components/FilterBar";
import { useT } from "@/i18n";

export interface FilterStore {
  id: string;
  name?: string;
}

export interface StoreFilterProps {
  stores: readonly FilterStore[];
  /** The selected store id, or "" for all stores. */
  value: string;
  onChange: (storeId: string) => void;
}

export function StoreFilter({
  stores,
  value,
  onChange,
}: Readonly<StoreFilterProps>): React.JSX.Element {
  const t = useT();
  const listed = value && !stores.some((s) => s.id === value) ? [...stores, { id: value }] : stores;
  return (
    <SelectFilterBar
      label={t("erp.filter.label")}
      id="erp-store-filter"
      fieldLabel={t("erp.filter.store")}
      value={value}
      allLabel={t("erp.filter.allStores")}
      options={listed.map((store) => ({ value: store.id, label: store.name ?? store.id }))}
      note={t("erp.filter.note")}
      onApply={onChange}
    />
  );
}
