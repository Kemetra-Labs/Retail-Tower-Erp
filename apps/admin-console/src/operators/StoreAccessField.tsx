/**
 * «الوصول إلى المتاجر» of the invite and edit member drawers (RT-971 form
 * template): all stores, or specific stores by id. A radio group named by its
 * label, and the id list, shown only for "specific", named by that choice.
 */
import { useT } from "@/i18n";
import { useId } from "react";

export function StoreAccessField({
  specific,
  onSpecificChange,
  defaultStoreIds,
}: Readonly<{
  specific: boolean;
  onSpecificChange: (specific: boolean) => void;
  defaultStoreIds?: string;
}>): React.JSX.Element {
  const t = useT();
  const labelId = useId();
  return (
    <div className="field">
      <span id={labelId} className="field__label">
        {t("operators.form.storeAccess")}
      </span>
      <div className="drawer__radio-group" role="radiogroup" aria-labelledby={labelId}>
        <label className="drawer__radio">
          <input
            type="radio"
            name="store_access"
            checked={!specific}
            onChange={() => onSpecificChange(false)}
          />
          {t("operators.storeAccess.all")}
        </label>
        <label className="drawer__radio">
          <input
            type="radio"
            name="store_access"
            checked={specific}
            onChange={() => onSpecificChange(true)}
          />
          {t("operators.storeAccess.specific")}
        </label>
      </div>
      {specific ? (
        <input
          name="store_ids"
          className="input"
          defaultValue={defaultStoreIds}
          aria-label={t("operators.storeAccess.specific")}
          placeholder={t("operators.form.storeIdsPlaceholder")}
          autoComplete="off"
        />
      ) : null}
    </div>
  );
}
