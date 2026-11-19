/** The `<option>`s of a queue's store select: "all stores" first, then the in-scope stores. */
import type { FilterStore } from "./useFilterStores";

export function StoreOptions({
  stores,
  allLabel,
}: Readonly<{ stores: readonly FilterStore[]; allLabel: string }>): React.JSX.Element {
  return (
    <>
      <option value="">{allLabel}</option>
      {stores.map((store) => (
        <option key={store.id} value={store.id}>
          {store.name ?? store.id}
        </option>
      ))}
    </>
  );
}
