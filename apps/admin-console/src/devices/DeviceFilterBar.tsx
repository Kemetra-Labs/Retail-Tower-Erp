import { FilterBar, type FilterChip, FilterField, isolate } from "@/components/FilterBar";
import { useT } from "@/i18n";
/**
 * RT-371 filter bar: store and trust state, the two filters the contract has.
 * Laid out by the shared FilterBar (RT-960): Apply, a ghost Clear, and a
 * removable chip per applied filter. A store in the URL that the caller's
 * roster does not list (a hand-edited or stale link) stays selected and is
 * named as such; the server decides whether it is readable.
 */
import type { TrustState } from "@/lib/device-queries";
import type { StoreInfo } from "@/shift-closes/useShiftCloses";
import { useState } from "react";
import { type DeviceFilters, EMPTY_FILTERS } from "./deviceFilters";
import "./devices.css";

export interface DeviceFilterBarProps {
  applied: DeviceFilters;
  stores: readonly StoreInfo[];
  onApply: (filters: DeviceFilters) => void;
  onClear: () => void;
}

const TRUST_OPTIONS: {
  value: TrustState;
  key: "devices.trust.active" | "devices.trust.revoked" | "devices.trust.retired";
}[] = [
  { value: "active", key: "devices.trust.active" },
  { value: "revoked", key: "devices.trust.revoked" },
  { value: "retired", key: "devices.trust.retired" },
];

function useChips(
  applied: DeviceFilters,
  stores: readonly StoreInfo[],
  onApply: (filters: DeviceFilters) => void,
): FilterChip[] {
  const t = useT();
  const chips: FilterChip[] = [];
  if (applied.storeId) {
    const name =
      stores.find((s) => s.id === applied.storeId)?.name ?? t("devices.filter.unlistedStore");
    chips.push({
      key: "store",
      label: `${t("devices.filter.store")}: ${isolate(name)}`,
      onRemove: () => onApply({ ...applied, storeId: "" }),
    });
  }
  const trust = TRUST_OPTIONS.find((o) => o.value === applied.trustState);
  if (trust) {
    chips.push({
      key: "trust",
      label: `${t("devices.filter.trust")}: ${isolate(t(trust.key))}`,
      onRemove: () => onApply({ ...applied, trustState: "" }),
    });
  }
  return chips;
}

export function DeviceFilterBar({
  applied,
  stores,
  onApply,
  onClear,
}: Readonly<DeviceFilterBarProps>): React.JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState<DeviceFilters>(applied);
  const chips = useChips(applied, stores, onApply);

  // The URL is the source of truth: when the applied filters change from outside
  // (Back, a deep link, a removed chip) the draft follows. The form stays mounted,
  // so keyboard focus survives an Apply.
  const appliedKey = JSON.stringify(applied);
  const [syncedKey, setSyncedKey] = useState(appliedKey);
  if (syncedKey !== appliedKey) {
    setSyncedKey(appliedKey);
    setDraft(applied);
  }

  const unlisted = draft.storeId !== "" && !stores.some((s) => s.id === draft.storeId);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    onApply(draft);
  }

  function clear(): void {
    setDraft(EMPTY_FILTERS);
    onClear();
  }

  return (
    <FilterBar label={t("devices.filter.label")} onSubmit={submit} onClear={clear} chips={chips}>
      <FilterField id="df-store" label={t("devices.filter.store")}>
        <select
          id="df-store"
          className="input"
          value={draft.storeId}
          onChange={(e) => setDraft({ ...draft, storeId: e.target.value })}
        >
          <option value="">{t("devices.filter.allStores")}</option>
          {unlisted ? (
            <option value={draft.storeId}>{t("devices.filter.unlistedStore")}</option>
          ) : null}
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField id="df-trust" label={t("devices.filter.trust")}>
        <select
          id="df-trust"
          className="input"
          value={draft.trustState}
          onChange={(e) =>
            setDraft({ ...draft, trustState: e.target.value as DeviceFilters["trustState"] })
          }
        >
          <option value="">{t("devices.filter.trustAny")}</option>
          {TRUST_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.key)}
            </option>
          ))}
        </select>
      </FilterField>
    </FilterBar>
  );
}
