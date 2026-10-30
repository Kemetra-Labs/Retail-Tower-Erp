/**
 * RT-587 sales filters (spec 012 J1), laid out by the shared FilterBar (RT-960).
 * One store (required, no "All stores" in v1, OD-556-2), an inclusive
 * business-date range of at most 31 days and an exact sale number in the main
 * row; the contract's four status filters behind «فلاتر إضافية». Choosing a
 * store proposes today in its zone. Applying writes the URL; the server stays
 * the authority on the range (AC-2). The page applies the active store and
 * today on arrival (RT-960, owner decision A).
 */
import { FilterBar, type FilterChip, FilterField, isolate, ltr } from "@/components/FilterBar";
import { type MessageKey, useT } from "@/i18n";
import type { StoreInfo } from "@/shift-closes/useShiftCloses";
import { useState } from "react";
import {
  ERP_STATES,
  type FilterErrors,
  MAX_SALE_NUMBER,
  RETURN_STATES,
  SYNC_STATUSES,
  type SaleFilters,
  emptyFilters,
  todayIn,
  validateFilters,
} from "./saleFilters";
import { erpStateKey, returnStateKey, syncStatusKey } from "./saleLogic";
import "./sales.css";

type FormErrors = FilterErrors & Partial<Record<"store" | "dates", MessageKey>>;

export interface SaleFilterBarProps {
  applied: SaleFilters;
  stores: readonly StoreInfo[];
  /** The active store, proposed when the URL names none. */
  activeStoreId: string | null;
  /** Errors already present in the applied filters (a hand-edited URL). */
  initialErrors: FilterErrors;
  onApply: (filters: SaleFilters) => void;
  onClear: () => void;
}

type SetField = <K extends keyof SaleFilters>(key: K) => (value: SaleFilters[K]) => void;
type Extra = "syncStatus" | "voided" | "returnState" | "erpState";
const EXTRA: readonly Extra[] = ["syncStatus", "voided", "returnState", "erpState"];

function zoneOf(stores: readonly StoreInfo[], storeId: string): string | undefined {
  return stores.find((s) => s.id === storeId)?.timezone;
}

/** Today in the store's zone for a chosen store with no dates yet (J1 default proposal). */
function propose(draft: SaleFilters, stores: readonly StoreInfo[]): SaleFilters {
  const store = stores.find((s) => s.id === draft.storeId);
  if (!store || draft.fromDate !== "" || draft.toDate !== "") return draft;
  const today = todayIn(store.timezone ?? "UTC");
  return { ...draft, fromDate: today, toDate: today };
}

function initialDraft(applied: SaleFilters, activeStoreId: string | null): SaleFilters {
  return applied.storeId || !activeStoreId ? applied : { ...applied, storeId: activeStoreId };
}

function requiredErrors(draft: SaleFilters): FormErrors {
  const errors: FormErrors = {};
  if (!draft.storeId) errors.store = "sales.filter.storeRequired";
  if (!draft.fromDate || !draft.toDate) errors.dates = "sales.filter.datesRequired";
  return errors;
}

function Choice<V extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: V | "";
  options: readonly { value: V; label: string }[];
  onChange: (value: V | "") => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <FilterField id={id} label={label}>
      <select
        id={id}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value as V | "")}
      >
        <option value="">{t("sales.filter.any")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FilterField>
  );
}

function useExtraOptions() {
  const t = useT();
  return {
    syncStatus: SYNC_STATUSES.map((v) => ({
      value: v,
      label: t(syncStatusKey({ syncStatus: v })),
    })),
    voided: [
      { value: "true" as const, label: t("sales.filter.voidedTrue") },
      { value: "false" as const, label: t("sales.filter.voidedFalse") },
    ],
    returnState: RETURN_STATES.map((v) => ({
      value: v,
      label: t(returnStateKey({ returnState: v })),
    })),
    erpState: ERP_STATES.map((v) => ({ value: v, label: t(erpStateKey({ erpPostingState: v })) })),
  };
}

const EXTRA_LABEL: Record<Extra, MessageKey> = {
  syncStatus: "sales.filter.sync",
  voided: "sales.filter.voided",
  returnState: "sales.filter.returns",
  erpState: "sales.filter.erp",
};

function ExtraFields({
  draft,
  set,
}: Readonly<{ draft: SaleFilters; set: SetField }>): React.JSX.Element {
  const t = useT();
  const options = useExtraOptions();
  return (
    <>
      <Choice
        id="sl-sync"
        label={t(EXTRA_LABEL.syncStatus)}
        value={draft.syncStatus}
        options={options.syncStatus}
        onChange={set("syncStatus")}
      />
      <Choice
        id="sl-voided"
        label={t(EXTRA_LABEL.voided)}
        value={draft.voided}
        options={options.voided}
        onChange={set("voided")}
      />
      <Choice
        id="sl-returns"
        label={t(EXTRA_LABEL.returnState)}
        value={draft.returnState}
        options={options.returnState}
        onChange={set("returnState")}
      />
      <Choice
        id="sl-erp"
        label={t(EXTRA_LABEL.erpState)}
        value={draft.erpState}
        options={options.erpState}
        onChange={set("erpState")}
      />
    </>
  );
}

/** The applied filters as chips: store and period are required, the rest removable. */
function useChips(
  applied: SaleFilters,
  stores: readonly StoreInfo[],
  onApply: (filters: SaleFilters) => void,
): FilterChip[] {
  const t = useT();
  const options = useExtraOptions();
  const chips: FilterChip[] = [];
  const store = stores.find((s) => s.id === applied.storeId);
  if (store) {
    chips.push({ key: "store", label: `${t("sales.filter.store")}: ${isolate(store.name)}` });
  }
  if (applied.fromDate && applied.toDate) {
    const period =
      applied.fromDate === applied.toDate
        ? applied.fromDate
        : `${applied.fromDate} – ${applied.toDate}`;
    chips.push({ key: "period", label: `${t("sales.filter.period")}: ${ltr(period)}` });
  }
  if (applied.saleNumber) {
    chips.push({
      key: "number",
      label: `${t("sales.filter.saleNumber")}: ${ltr(applied.saleNumber)}`,
      onRemove: () => onApply({ ...applied, saleNumber: "" }),
    });
  }
  for (const key of EXTRA) {
    const value = applied[key];
    const option = (options[key] as readonly { value: string; label: string }[]).find(
      (o) => o.value === value,
    );
    if (option) {
      chips.push({
        key,
        label: `${t(EXTRA_LABEL[key])}: ${isolate(option.label)}`,
        onRemove: () => onApply({ ...applied, [key]: "" }),
      });
    }
  }
  return chips;
}

export function SaleFilterBar({
  applied,
  stores,
  activeStoreId,
  initialErrors,
  onApply,
  onClear,
}: Readonly<SaleFilterBarProps>): React.JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState<SaleFilters>(() => initialDraft(applied, activeStoreId));
  const [errors, setErrors] = useState<FormErrors>(initialErrors);
  const chips = useChips(applied, stores, onApply);

  // The URL is the source of truth: when the applied filters change from outside
  // (Back, a deep link, a removed chip, arrival) the draft follows. The form
  // stays mounted, so keyboard focus survives an Apply.
  const appliedKey = JSON.stringify(applied);
  const [syncedKey, setSyncedKey] = useState(appliedKey);
  if (syncedKey !== appliedKey) {
    setSyncedKey(appliedKey);
    setDraft(initialDraft(applied, activeStoreId));
    setErrors(initialErrors);
  }
  // The roster arrives after the first render: propose today once its zone is known.
  const [rosterSize, setRosterSize] = useState(0);
  if (rosterSize !== stores.length) {
    setRosterSize(stores.length);
    setDraft((current) => propose(current, stores));
  }

  const set: SetField = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }));

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const next: SaleFilters = { ...draft, saleNumber: draft.saleNumber.trim() };
    const found: FormErrors = { ...requiredErrors(next), ...validateFilters(next) };
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setDraft(next);
    onApply(next);
  }

  function clear(): void {
    setDraft(emptyFilters());
    setErrors({});
    onClear();
  }

  const zone = zoneOf(stores, draft.storeId);
  const message = (key: MessageKey | undefined) => (key ? t(key) : undefined);
  const extraActive = EXTRA.filter((key) => applied[key] !== "").length;

  return (
    <FilterBar
      label={t("sales.filter.label")}
      onSubmit={submit}
      onClear={clear}
      extra={<ExtraFields draft={draft} set={set} />}
      extraActive={extraActive}
      chips={chips}
      note={
        <>
          <p className="filter-bar__note-line">
            {zone
              ? t.rich("sales.filter.zoneNote", { zone: <bdi dir="ltr">{zone}</bdi> })
              : t("sales.filter.zonePending")}
          </p>
          <p id="sl-number-note" className="filter-bar__note-line">
            {t("sales.filter.saleNumberNote")}
          </p>
        </>
      }
    >
      <FilterField id="sl-store" label={t("sales.filter.store")} error={message(errors.store)}>
        <select
          id="sl-store"
          className="input"
          required
          aria-invalid={errors.store ? true : undefined}
          value={draft.storeId}
          onChange={(e) =>
            setDraft((current) => propose({ ...current, storeId: e.target.value }, stores))
          }
        >
          <option value="">{t("sales.filter.storePlaceholder")}</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField
        id="sl-from"
        label={t("sales.filter.from")}
        error={message(errors.date ?? errors.dates)}
      >
        <input
          id="sl-from"
          type="date"
          className="input"
          required
          aria-invalid={(errors.date ?? errors.dates) ? true : undefined}
          value={draft.fromDate}
          onChange={(e) => set("fromDate")(e.target.value)}
        />
      </FilterField>
      <FilterField id="sl-to" label={t("sales.filter.to")} error={message(errors.range)}>
        <input
          id="sl-to"
          type="date"
          className="input"
          required
          aria-invalid={errors.range ? true : undefined}
          value={draft.toDate}
          onChange={(e) => set("toDate")(e.target.value)}
        />
      </FilterField>
      <FilterField
        id="sl-number"
        label={t("sales.filter.saleNumber")}
        error={message(errors.saleNumber)}
      >
        <input
          id="sl-number"
          className="input"
          dir="ltr"
          autoComplete="off"
          maxLength={MAX_SALE_NUMBER}
          aria-describedby="sl-number-note"
          aria-invalid={errors.saleNumber ? true : undefined}
          value={draft.saleNumber}
          onChange={(e) => set("saleNumber")(e.target.value)}
        />
      </FilterField>
    </FilterBar>
  );
}
