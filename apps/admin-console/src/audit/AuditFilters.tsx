/**
 * SF-6-1 filters (T019), laid out by the shared FilterBar (RT-960).
 * Uncontrolled native inputs (no form library, R6-5): action prefix, actor id,
 * store id (shown only when a store dimension is in scope — scope-driven, never
 * role-driven, FR-006-004), from/to date-time. Apply, a ghost Clear. Serializes
 * to the contract's query params.
 */
import { FilterBar, type FilterChip, FilterField, ltr } from "@/components/FilterBar";
import { useT } from "@/i18n";
import { textField } from "@/lib/form-field";
import { useRef } from "react";
import type { AuditFilters as Filters } from "./auditQueryKeys";
import "./audit.css";

/**
 * Example action-code prefixes. Audit action codes are machine data, identical
 * in every locale and never translated, so this hint is not catalog copy.
 */
const ACTION_EXAMPLE = "auth. / shift.";

export interface AuditFiltersProps {
  /** True when the active scope carries a store dimension (shows the store filter). */
  storeInScope: boolean;
  /** The applied filters (page state), shown as removable chips. */
  applied: Filters;
  onApply: (filters: Filters) => void;
  onClear: () => void;
}

type ChipKey = "action" | "actor_user_id" | "store_id" | "from" | "to";
const CHIP_FIELDS: readonly ChipKey[] = ["action", "actor_user_id", "store_id", "from", "to"];

export function AuditFilters({
  storeInScope,
  applied,
  onApply,
  onClear,
}: Readonly<AuditFiltersProps>): React.JSX.Element {
  const t = useT();
  const formRef = useRef<HTMLFormElement>(null);

  function read(): Filters {
    const form = new FormData(formRef.current ?? undefined);
    const val = (k: string) => {
      const v = textField(form, k).trim();
      return v.length > 0 ? v : undefined;
    };
    return {
      action: val("action"),
      actor_user_id: val("actor_user_id"),
      store_id: storeInScope ? val("store_id") : undefined,
      from: val("from"),
      to: val("to"),
    };
  }

  const labels: Record<ChipKey, string> = {
    action: t("audit.field.action"),
    actor_user_id: t("audit.field.actor"),
    store_id: t("audit.field.store"),
    from: t("audit.filters.from"),
    to: t("audit.filters.to"),
  };
  // The fields are uncontrolled: a removed chip clears its input, then applies the form.
  const chips: FilterChip[] = CHIP_FIELDS.filter((key) => applied[key]).map((key) => ({
    key,
    label: `${labels[key]}: ${ltr(String(applied[key]))}`,
    onRemove: () => {
      const input = formRef.current?.elements.namedItem(key);
      if (input instanceof HTMLInputElement) input.value = "";
      onApply(read());
    },
  }));

  return (
    <FilterBar
      label={t("audit.filters.label")}
      formRef={formRef}
      chips={chips}
      onSubmit={(e) => {
        e.preventDefault();
        onApply(read());
      }}
      onClear={() => {
        formRef.current?.reset();
        onClear();
      }}
    >
      <FilterField id="f-action" label={t("audit.field.action")}>
        {/* Action codes and IDs are machine data: typed and shown LTR (UX-11). */}
        <input
          id="f-action"
          name="action"
          className="input"
          dir="ltr"
          placeholder={ACTION_EXAMPLE}
          autoComplete="off"
        />
      </FilterField>
      <FilterField id="f-actor" label={t("audit.field.actor")}>
        <input
          id="f-actor"
          name="actor_user_id"
          className="input"
          dir="ltr"
          placeholder={t("audit.filters.actorPlaceholder")}
          autoComplete="off"
        />
      </FilterField>
      {storeInScope ? (
        <FilterField id="f-store" label={t("audit.field.store")}>
          <input
            id="f-store"
            name="store_id"
            className="input"
            dir="ltr"
            placeholder={t("audit.filters.storePlaceholder")}
            autoComplete="off"
          />
        </FilterField>
      ) : null}
      <FilterField id="f-from" label={t("audit.filters.from")}>
        <input id="f-from" name="from" type="datetime-local" className="input" />
      </FilterField>
      <FilterField id="f-to" label={t("audit.filters.to")}>
        <input id="f-to" name="to" type="datetime-local" className="input" />
      </FilterField>
    </FilterBar>
  );
}
