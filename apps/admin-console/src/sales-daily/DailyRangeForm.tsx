/**
 * RT-821 (VIZ-3) the report's range: an inclusive business-date range of at
 * most 31 days, laid out by the shared FilterBar (RT-960). The contract's rule
 * is checked here before anything is read, and a server 400 still lands at the
 * field (`serverError`). Apply writes the draft to the URL; Clear returns to
 * the default range.
 */
import { FilterBar, FilterField } from "@/components/FilterBar";
import { type MessageKey, useT } from "@/i18n";
import { useState } from "react";
import { type DailyRange, type RangeErrors, validateRange } from "./dailyLogic";

function DateField({
  id,
  label,
  value,
  error,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  error?: MessageKey;
  onChange: (value: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <FilterField id={id} label={label} error={error ? t(error) : undefined}>
      <input
        id={id}
        type="date"
        className="input"
        required
        aria-invalid={error ? true : undefined}
        aria-describedby="sd-range-note"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </FilterField>
  );
}

export function DailyRangeForm({
  range,
  zoneNote,
  serverError,
  onApply,
  onClear,
}: Readonly<{
  /** The applied range (URL or default); null while the default waits for the store zone. */
  range: DailyRange | null;
  zoneNote: React.ReactNode;
  /** A 400 the server answered for the applied range, shown at the To field. */
  serverError?: MessageKey;
  onApply: (range: DailyRange) => void;
  /** Back to the default range. */
  onClear: () => void;
}>): React.JSX.Element {
  const t = useT();
  const empty = { from: "", to: "" };
  const [draft, setDraft] = useState<DailyRange>(range ?? empty);
  const [errors, setErrors] = useState<RangeErrors>(range ? validateRange(range) : {});

  // The URL is the source of truth: when the applied range changes from outside
  // (Back, a deep link, the default arriving) the draft follows.
  const appliedKey = JSON.stringify(range);
  const [syncedKey, setSyncedKey] = useState(appliedKey);
  if (syncedKey !== appliedKey) {
    setSyncedKey(appliedKey);
    setDraft(range ?? empty);
    setErrors(range ? validateRange(range) : {});
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const found = validateRange(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onApply(draft);
  }

  function clear(): void {
    setErrors({});
    onClear();
  }

  return (
    <FilterBar
      label={t("salesDaily.range.label")}
      onSubmit={submit}
      onClear={clear}
      note={
        <p id="sd-range-note" className="filter-bar__note-line">
          {zoneNote}
        </p>
      }
    >
      <DateField
        id="sd-from"
        label={t("sales.filter.from")}
        value={draft.from}
        error={errors.from}
        onChange={(from) => setDraft((d) => ({ ...d, from }))}
      />
      <DateField
        id="sd-to"
        label={t("sales.filter.to")}
        value={draft.to}
        error={errors.to ?? serverError}
        onChange={(to) => setDraft((d) => ({ ...d, to }))}
      />
    </FilterBar>
  );
}
