/**
 * RT-1338 offer editor fields: names, the X / Y / P parameters, the maximum applications, stores,
 * the schedule and the offline policy. Controlled inputs: what is typed outlives every failure.
 * The include / exclude rule sets are `OfferRuleSet`, mounted by the editor beside these.
 *
 * Each field with an error is `aria-invalid` and describes itself by its error text; the form's
 * error summary announces a blocked save, so the inline error is not a second live region.
 */
import { FormField } from "@/components/FormField";
import { FormSection } from "@/components/FormPage";
import { InlineError } from "@/components/InlineError";
import { type MessageKey, useT } from "@/i18n";
import type { OfferOfflinePolicy } from "@/lib/offer-queries";
import {
  type OfferFormErrors,
  type OfferFormField,
  type OfferFormValues,
  QUANTITY_MAX,
} from "./offerFormLogic";

type Store = { id: string; name?: string };

export const OFFER_FIELD_IDS: Record<OfferFormField, string> = {
  nameAr: "offer-name-ar",
  nameEn: "offer-name-en",
  buyQuantity: "offer-buy",
  getQuantity: "offer-get",
  percentOff: "offer-percent",
  maxApplications: "offer-max",
  include: "offer-include",
  storeIds: "offer-stores",
  startsAt: "offer-starts",
  endsAt: "offer-ends",
};

export interface OfferFormFieldsProps {
  values: OfferFormValues;
  /** The errors to show now (inline); the form decides when each is visible. */
  errors: OfferFormErrors;
  onChange: <K extends keyof OfferFormValues>(field: K, value: OfferFormValues[K]) => void;
  roster: readonly Store[];
  tenantWide: boolean;
}

function useError(errors: OfferFormErrors) {
  const t = useT();
  return (field: OfferFormField): string | undefined => {
    const e = errors[field];
    return e ? t(e.messageKey, e.params) : undefined;
  };
}

function NumberField({
  field,
  label,
  hintKey,
  value,
  error,
  required,
  onChange,
}: Readonly<{
  field: OfferFormField;
  label: MessageKey;
  hintKey?: MessageKey;
  value: string;
  error?: string;
  required?: boolean;
  onChange: (value: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const id = OFFER_FIELD_IDS[field];
  return (
    <FormField
      id={id}
      label={t(label)}
      hint={hintKey ? t(hintKey, { max: QUANTITY_MAX }) : undefined}
      required={required}
      error={error}
    >
      {(aria) => (
        <input
          id={id}
          className="input"
          inputMode="numeric"
          dir="ltr"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      )}
    </FormField>
  );
}

function StoreChoices({
  roster,
  chosen,
  error,
  onToggle,
}: Readonly<{
  roster: readonly Store[];
  chosen: readonly string[];
  error?: string;
  onToggle: (id: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div id={OFFER_FIELD_IDS.storeIds} aria-invalid={error ? true : undefined}>
      {roster.length === 0 ? <p className="content__sub">{t("offers.form.noStores")}</p> : null}
      <ul className="offer-rule__choices">
        {roster.map((store) => (
          <li key={store.id}>
            <label className="offer-rule__choice">
              <input
                type="checkbox"
                name="storeIds"
                value={store.id}
                checked={chosen.includes(store.id)}
                onChange={() => onToggle(store.id)}
              />
              <bdi dir="auto">{store.name ?? store.id}</bdi>
            </label>
          </li>
        ))}
      </ul>
      <InlineError message={error} />
    </div>
  );
}

export function OfferFormFields({
  values,
  errors,
  onChange,
  roster,
  tenantWide,
}: Readonly<OfferFormFieldsProps>): React.JSX.Element {
  const t = useT();
  const err = useError(errors);
  return (
    <>
      <FormSection title={t("offers.form.section.basics")}>
        <FormField
          id={OFFER_FIELD_IDS.nameAr}
          label={t("offers.form.nameAr")}
          required
          error={err("nameAr")}
        >
          {(aria) => (
            <input
              id={OFFER_FIELD_IDS.nameAr}
              className="input"
              dir="rtl"
              lang="ar"
              autoComplete="off"
              value={values.nameAr}
              onChange={(e) => onChange("nameAr", e.target.value)}
              {...aria}
            />
          )}
        </FormField>
        <FormField
          id={OFFER_FIELD_IDS.nameEn}
          label={t("offers.form.nameEn")}
          hint={t("offers.form.nameEnHint")}
          error={err("nameEn")}
        >
          {(aria) => (
            <input
              id={OFFER_FIELD_IDS.nameEn}
              className="input"
              dir="ltr"
              lang="en"
              autoComplete="off"
              value={values.nameEn}
              onChange={(e) => onChange("nameEn", e.target.value)}
              {...aria}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection title={t("offers.form.section.deal")}>
        <p className="field__hint offer-form__formula">{t("offers.form.formula")}</p>
        <NumberField
          field="buyQuantity"
          label="offers.form.buy"
          hintKey="offers.form.buyHint"
          value={values.buyQuantity}
          error={err("buyQuantity")}
          required
          onChange={(v) => onChange("buyQuantity", v)}
        />
        <NumberField
          field="getQuantity"
          label="offers.form.get"
          hintKey="offers.form.getHint"
          value={values.getQuantity}
          error={err("getQuantity")}
          required
          onChange={(v) => onChange("getQuantity", v)}
        />
        <NumberField
          field="percentOff"
          label="offers.form.percent"
          hintKey="offers.form.percentHint"
          value={values.percentOff}
          error={err("percentOff")}
          required
          onChange={(v) => onChange("percentOff", v)}
        />
        <NumberField
          field="maxApplications"
          label="offers.form.max"
          hintKey="offers.form.maxHint"
          value={values.maxApplications}
          error={err("maxApplications")}
          onChange={(v) => onChange("maxApplications", v)}
        />
      </FormSection>

      <FormSection title={t("offers.form.section.stores")}>
        <label className="offer-rule__choice">
          <input
            type="radio"
            name="offer-scope"
            checked={values.scope === "all"}
            disabled={!tenantWide}
            onChange={() => onChange("scope", "all")}
          />
          {t("offers.form.scopeAll")}
        </label>
        <label className="offer-rule__choice">
          <input
            type="radio"
            name="offer-scope"
            checked={values.scope === "stores"}
            onChange={() => onChange("scope", "stores")}
          />
          {t("offers.form.scopeStores")}
        </label>
        {tenantWide ? null : <p className="field__hint">{t("offers.form.boundedScope")}</p>}
        {values.scope === "stores" || errors.storeIds ? (
          <StoreChoices
            roster={roster}
            chosen={values.storeIds}
            error={err("storeIds")}
            onToggle={(id) =>
              onChange(
                "storeIds",
                values.storeIds.includes(id)
                  ? values.storeIds.filter((s) => s !== id)
                  : [...values.storeIds, id],
              )
            }
          />
        ) : null}
      </FormSection>

      <FormSection title={t("offers.form.section.schedule")}>
        {values.scheduleWasAbsolute ? (
          <p className="field__hint">{t("offers.form.absoluteNote")}</p>
        ) : null}
        <FormField
          id={OFFER_FIELD_IDS.startsAt}
          label={t("offers.form.starts")}
          hint={t("offers.form.timeHint")}
          required
          error={err("startsAt")}
        >
          {(aria) => (
            <input
              id={OFFER_FIELD_IDS.startsAt}
              type="datetime-local"
              className="input"
              value={values.startsAt}
              onChange={(e) => onChange("startsAt", e.target.value)}
              {...aria}
            />
          )}
        </FormField>
        <FormField
          id={OFFER_FIELD_IDS.endsAt}
          label={t("offers.form.ends")}
          hint={t("offers.form.endsHint")}
          error={err("endsAt")}
        >
          {(aria) => (
            <input
              id={OFFER_FIELD_IDS.endsAt}
              type="datetime-local"
              className="input"
              value={values.endsAt}
              onChange={(e) => onChange("endsAt", e.target.value)}
              {...aria}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection title={t("offers.form.section.offline")}>
        <FormField
          id="offer-offline"
          label={t("offers.form.offline")}
          hint={t("offers.form.offlineHint")}
        >
          {(aria) => (
            <select
              id="offer-offline"
              className="input"
              value={values.offlinePolicy}
              onChange={(e) => onChange("offlinePolicy", e.target.value as OfferOfflinePolicy)}
              {...aria}
            >
              <option value="allow_cached">{t("offers.offline.allow_cached")}</option>
              <option value="online_only">{t("offers.offline.online_only")}</option>
            </select>
          )}
        </FormField>
      </FormSection>
    </>
  );
}
