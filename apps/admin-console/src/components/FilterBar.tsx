/**
 * RT-960: the one filter bar for every list screen (DESIGN.md §9). It is
 * presentational: each screen keeps its own draft, URL state and validation,
 * and only lays its fields out here.
 *
 * - A section panel above the list. The fields sit on one grid of equal tracks,
 *   so columns line up across rows; extra fields join the same tracks.
 * - One Apply (primary, rate-limit gated, can be busy) and a ghost Clear.
 * - An optional «فلاتر إضافية» disclosure. Its count is the screen's applied
 *   hidden filters; the region is hidden, never unmounted, so hidden values
 *   still apply, and it opens when one of them has an error.
 * - Optional chips for the applied filters (a required one has no remove) and
 *   a result slot, such as the loaded count.
 */
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { useT } from "@/i18n";
import { useId, useState } from "react";
import "./filter-bar.css";

export interface FilterChip {
  key: string;
  label: string;
  /** Omitted for a required filter: it shows, but it cannot be removed. */
  onRemove?: () => void;
}

export interface FilterBarProps {
  /** The form's accessible name, e.g. "Device filters". */
  label: string;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
  /** The main row's fields (FilterField cells). */
  children: React.ReactNode;
  /** Fields behind «فلاتر إضافية». */
  extra?: React.ReactNode;
  /** How many of the extra filters are applied. */
  extraActive?: number;
  /** Open the disclosure, e.g. because a hidden field has an error. */
  extraOpen?: boolean;
  chips?: readonly FilterChip[];
  result?: React.ReactNode;
  /** Notes under the fields (zone, hints): kept out of the grid cells. */
  note?: React.ReactNode;
  busy?: boolean;
  /** The apply verb; «تطبيق» unless a screen must search before any read. */
  applyLabel?: string;
  /** For a screen with uncontrolled fields (it resets the form on Clear). */
  formRef?: React.Ref<HTMLFormElement>;
}

export function FilterField({
  id,
  label,
  error,
  children,
}: Readonly<{
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="field filter-bar__field">
      <label htmlFor={id}>{label}</label>
      {children}
      <InlineError message={error} />
    </div>
  );
}

function MoreToggle({
  regionId,
  open,
  active,
  onToggle,
}: Readonly<{
  regionId: string;
  open: boolean;
  active: number;
  onToggle: () => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <button
      type="button"
      className="btn-secondary filter-bar__more"
      aria-expanded={open}
      aria-controls={regionId}
      aria-label={active > 0 ? t("filter.moreActive", { count: active }) : t("filter.more")}
      onClick={onToggle}
    >
      {t("filter.more")}
      {active > 0 ? (
        <span className="filter-bar__count" aria-hidden="true">
          {active}
        </span>
      ) : null}
    </button>
  );
}

function Chips({ chips }: Readonly<{ chips: readonly FilterChip[] }>): React.JSX.Element {
  const t = useT();
  return (
    <ul className="filter-bar__chips" aria-label={t("filter.applied")}>
      {chips.map((chip) => (
        <li key={chip.key} className="filter-bar__chip">
          <span>{chip.label}</span>
          {chip.onRemove ? (
            <button
              type="button"
              className="filter-bar__chip-remove"
              aria-label={t("filter.remove", { label: chip.label })}
              onClick={chip.onRemove}
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function FilterBar({
  label,
  onSubmit,
  onClear,
  children,
  extra,
  extraActive = 0,
  extraOpen = false,
  chips,
  result,
  note,
  busy = false,
  applyLabel,
  formRef,
}: Readonly<FilterBarProps>): React.JSX.Element {
  const t = useT();
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const expanded = open || extraOpen;
  const hasFooter = (chips && chips.length > 0) || result;
  return (
    <section className="section-panel filter-bar">
      <form
        ref={formRef}
        className="filter-bar__form"
        aria-label={label}
        // Filters are not unsaved work: no Stay / Discard prompt for them (RT-268).
        data-dirty-guard="off"
        onSubmit={onSubmit}
        noValidate
      >
        <div className="filter-bar__grid">
          {children}
          {extra ? (
            <div id={regionId} className="filter-bar__extra" hidden={!expanded}>
              {extra}
            </div>
          ) : null}
          <div className="filter-bar__actions">
            {extra ? (
              <MoreToggle
                regionId={regionId}
                open={expanded}
                active={extraActive}
                onToggle={() => setOpen(!expanded)}
              />
            ) : null}
            <button type="button" className="btn-ghost" onClick={onClear}>
              {t("filter.clear")}
            </button>
            <GatedButton type="submit" className="btn-primary" busy={busy}>
              {applyLabel ?? t("filter.apply")}
            </GatedButton>
          </div>
        </div>
        {note ? <div className="filter-bar__note">{note}</div> : null}
        {hasFooter ? (
          <div className="filter-bar__footer">
            {chips && chips.length > 0 ? <Chips chips={chips} /> : null}
            {result ? <div className="filter-bar__result">{result}</div> : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}

export interface SelectFilterOption {
  value: string;
  label: string;
}

/**
 * A list with one select filter (a store, a state, a class) on the FilterBar:
 * the select edits a draft, Apply applies it, Clear returns to "all" (""). The
 * applied value is the screen's (its URL or page state); the draft follows it.
 */
export function SelectFilterBar({
  label,
  id,
  fieldLabel,
  value,
  allLabel,
  options,
  note,
  onApply,
}: Readonly<{
  /** The form's accessible name. */
  label: string;
  id: string;
  fieldLabel: string;
  /** The applied value; "" is all. */
  value: string;
  allLabel: string;
  options: readonly SelectFilterOption[];
  /** A note under the field, tied to the select by `${id}-note`. */
  note?: React.ReactNode;
  onApply: (value: string) => void;
}>): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }
  return (
    <FilterBar
      label={label}
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
      onClear={() => {
        setDraft("");
        onApply("");
      }}
      note={
        note ? (
          <p id={`${id}-note`} className="filter-bar__note-line">
            {note}
          </p>
        ) : undefined
      }
    >
      <FilterField id={id} label={fieldLabel}>
        <select
          id={id}
          className="input"
          aria-describedby={note ? `${id}-note` : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        >
          <option value="">{allLabel}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FilterField>
    </FilterBar>
  );
}
