/**
 * RT-1338 one eligibility set of the offer editor: the include set, or the exclude set. Each is
 * made of products, categories and brands, chosen from the tenant's own catalog; the Console never
 * resolves a rule or counts what it matches (Backend-Core materialises the eligible set, OD-6; the
 * preview shows its count and a sample).
 *
 * - Products: chips with names (read by id for a loaded draft) and an inline picker to add one.
 * - Categories and brands: checkbox lists from the flat lists. A rule that names a category or
 *   brand the list no longer carries stays visible, marked unavailable, so it can be removed.
 * - Brands are whole-set lists (not paginated), categories too; both can be long, so they scroll.
 */
import { ProductPicker } from "@/catalog/ProductPicker";
import { useT } from "@/i18n";
import { useState } from "react";
import type { EligibilityIds } from "./offerFormLogic";
import { MAX_PRODUCTS } from "./offerFormLogic";
import { MAX_LOOKUPS } from "./useProductNames";
import type { ProductNames } from "./useProductNames";

type Choice = { id: string; name: string };

export interface OfferRuleSetProps {
  /** Distinguishes the two sets in element ids and accessible names. */
  kind: "include" | "exclude";
  tenantId: string;
  value: EligibilityIds;
  onChange: (next: EligibilityIds) => void;
  categories: readonly Choice[];
  brands: readonly Choice[];
  /** The lists are loading or failed: an id they do not carry is not claimed unavailable. */
  listsKnown: boolean;
  productNames: ProductNames;
  /** Records a product's name when it is picked, so its chip is named at once. */
  onProductNamed: (productId: string, name: string) => void;
  disabled?: boolean;
}

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function ChoiceList({
  legend,
  name,
  choices,
  chosen,
  listsKnown,
  onToggle,
  disabled,
}: Readonly<{
  legend: string;
  name: string;
  choices: readonly Choice[];
  chosen: readonly string[];
  listsKnown: boolean;
  onToggle: (id: string) => void;
  disabled?: boolean;
}>): React.JSX.Element {
  const t = useT();
  const unlisted = chosen.filter((id) => !choices.some((c) => c.id === id));
  return (
    <fieldset className="offer-rule__group" disabled={disabled}>
      <legend className="offer-rule__legend">{legend}</legend>
      {choices.length === 0 && unlisted.length === 0 ? (
        <p className="content__sub">{t("offers.rules.noneAvailable")}</p>
      ) : null}
      <ul className="offer-rule__choices">
        {unlisted.map((id) => (
          <li key={id}>
            <label className="offer-rule__choice">
              <input type="checkbox" name={name} value={id} checked onChange={() => onToggle(id)} />
              {t(listsKnown ? "offers.rules.unavailable" : "offers.rules.selected")}
            </label>
          </li>
        ))}
        {choices.map((choice) => (
          <li key={choice.id}>
            <label className="offer-rule__choice">
              <input
                type="checkbox"
                name={name}
                value={choice.id}
                checked={chosen.includes(choice.id)}
                onChange={() => onToggle(choice.id)}
              />
              <bdi dir="auto">{choice.name}</bdi>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function ProductChips({
  kind,
  ids,
  names,
  onRemove,
  disabled,
}: Readonly<{
  kind: "include" | "exclude";
  ids: readonly string[];
  names: ProductNames;
  onRemove: (id: string) => void;
  disabled?: boolean;
}>): React.JSX.Element | null {
  const t = useT();
  if (ids.length === 0)
    return <p className="content__sub">{t(`offers.rules.${kind}.noProducts`)}</p>;
  const shown = ids.filter((id, i) => names.nameOf(id) !== undefined || i < MAX_LOOKUPS);
  return (
    <ul className="offer-rule__chips">
      {shown.map((id) => {
        const label = names.nameOf(id) ?? t("offers.rules.unavailableItem");
        return (
          <li key={id} className="offer-rule__chip">
            <bdi dir="auto">{label}</bdi>
            <button
              type="button"
              className="btn-ghost offer-rule__remove"
              disabled={disabled}
              onClick={() => onRemove(id)}
              aria-label={t("offers.rules.removeProduct", { name: label })}
            >
              ×
            </button>
          </li>
        );
      })}
      {names.unreadCount > 0 ? (
        <li className="content__sub">
          {t("offers.rules.moreProducts", { count: names.unreadCount })}
        </li>
      ) : null}
    </ul>
  );
}

export function OfferRuleSet({
  kind,
  tenantId,
  value,
  onChange,
  categories,
  brands,
  listsKnown,
  productNames,
  onProductNamed,
  disabled,
}: Readonly<OfferRuleSetProps>): React.JSX.Element {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const full = value.productIds.length >= MAX_PRODUCTS;
  return (
    <fieldset className="offer-rule" disabled={disabled}>
      <legend className="form-section__title">{t(`offers.rules.${kind}.title`)}</legend>
      <p className="field__hint">{t(`offers.rules.${kind}.hint`)}</p>

      <section className="offer-rule__group" aria-label={t("offers.rules.products")}>
        <h4 className="offer-rule__legend">{t("offers.rules.products")}</h4>
        <ProductChips
          kind={kind}
          ids={value.productIds}
          names={productNames}
          disabled={disabled}
          onRemove={(id) =>
            onChange({ ...value, productIds: value.productIds.filter((p) => p !== id) })
          }
        />
        {adding ? (
          <div className="offer-rule__picker">
            <ProductPicker
              tenantId={tenantId}
              selectedId={null}
              onSelect={(product) => {
                onProductNamed(product.productId, product.name);
                if (!value.productIds.includes(product.productId)) {
                  onChange({ ...value, productIds: [...value.productIds, product.productId] });
                }
              }}
            />
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              {t("offers.rules.doneAdding")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            disabled={disabled || full}
            onClick={() => setAdding(true)}
          >
            {t(`offers.rules.${kind}.addProduct`)}
          </button>
        )}
      </section>

      <ChoiceList
        legend={t("offers.rules.categories")}
        name={`${kind}-category`}
        choices={categories}
        chosen={value.categoryIds}
        listsKnown={listsKnown}
        disabled={disabled}
        onToggle={(id) => onChange({ ...value, categoryIds: toggle(value.categoryIds, id) })}
      />
      <ChoiceList
        legend={t("offers.rules.brands")}
        name={`${kind}-brand`}
        choices={brands}
        chosen={value.brandIds}
        listsKnown={listsKnown}
        disabled={disabled}
        onToggle={(id) => onChange({ ...value, brandIds: toggle(value.brandIds, id) })}
      />
    </fieldset>
  );
}
