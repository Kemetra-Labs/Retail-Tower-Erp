import { FilterBar, type FilterChip, FilterField, isolate } from "@/components/FilterBar";
import { type MessageKey, useT } from "@/i18n";
/**
 * RT-765 catalog filters (CAT-C1a, RT-752 AC 4), laid out by the shared
 * FilterBar (RT-960). Search text and status (default «نشط») sit on the main
 * row; category and brand sit behind the bar's «فلاتر إضافية» disclosure, and
 * the category also has a quick chip row under the bar (`CatalogCategoryChips`,
 * the concept's category chips, fed by the same category read). Apply writes
 * them to the URL. The store is not a filter here: it comes from the
 * scope header. The
 * search text is sent exactly as typed (no trim): an exact barcode, SKU or
 * quick-sale code keeps its leading zeros and every space, so a pasted trailing
 * space is a miss, not something silently fixed.
 */
import type { CatalogBrand } from "@/lib/brand-queries";
import type { CatalogCategory } from "@/lib/catalog-queries";
import { useState } from "react";
import {
  type CatalogFilters,
  type FilterErrors,
  MAX_QUERY_LENGTH,
  STATUS_FILTERS,
  defaultFilters,
  statusFilterKey,
  validateFilters,
} from "./catalogLogic";
import "./catalog.css";

export interface CatalogFilterBarProps {
  applied: CatalogFilters;
  categories: readonly CatalogCategory[];
  categoriesLoading: boolean;
  categoriesFailed: boolean;
  /** RT-1338: the tenant's brands, for the brand filter. */
  brands: readonly CatalogBrand[];
  brandsLoading: boolean;
  brandsFailed: boolean;
  /** Errors already present in the applied filters (a hand-edited URL). */
  initialErrors: FilterErrors;
  onApply: (filters: CatalogFilters) => void;
  onClear: () => void;
}

/** A category the list does not carry: "Unavailable" only once the list is known. */
function missingLabelKey(loading: boolean, failed: boolean): MessageKey {
  if (loading) return "catalog.filter.categoryLoading";
  return failed ? "catalog.filter.categorySelected" : "catalog.filter.categoryStale";
}

/** The category options, plus the applied one when the list does not carry it (a retired category). */
function CategoryOptions({
  categories,
  appliedId,
  loading,
  failed,
}: Readonly<{
  categories: readonly CatalogCategory[];
  appliedId: string;
  loading: boolean;
  failed: boolean;
}>): React.JSX.Element {
  const t = useT();
  const known = categories.some((c) => c.categoryId.toLowerCase() === appliedId);
  const missing = appliedId !== "" && !known;
  return (
    <>
      <option value="">{t("catalog.filter.categoryAll")}</option>
      {categories.map((c) => (
        <option key={c.categoryId} value={c.categoryId.toLowerCase()}>
          {c.name}
        </option>
      ))}
      {missing ? <option value={appliedId}>{t(missingLabelKey(loading, failed))}</option> : null}
    </>
  );
}

/** The brand options, plus the applied one when the list does not carry it (a retired brand). */
function BrandOptions({
  brands,
  appliedId,
  loading,
  failed,
}: Readonly<{
  brands: readonly CatalogBrand[];
  appliedId: string;
  loading: boolean;
  failed: boolean;
}>): React.JSX.Element {
  const t = useT();
  const known = brands.some((b) => b.brandId.toLowerCase() === appliedId);
  const missing = appliedId !== "" && !known;
  let missingKey: MessageKey = "catalog.filter.brandStale";
  if (loading) missingKey = "catalog.filter.brandLoading";
  else if (failed) missingKey = "catalog.filter.brandSelected";
  return (
    <>
      <option value="">{t("catalog.filter.brandAll")}</option>
      {brands.map((b) => (
        <option key={b.brandId} value={b.brandId.toLowerCase()}>
          {b.name}
        </option>
      ))}
      {missing ? <option value={appliedId}>{t(missingKey)}</option> : null}
    </>
  );
}

function useChips(
  applied: CatalogFilters,
  brands: readonly CatalogBrand[],
  onApply: (filters: CatalogFilters) => void,
): FilterChip[] {
  const t = useT();
  const defaults = defaultFilters();
  const chips: FilterChip[] = [];
  if (applied.q !== "") {
    chips.push({
      key: "q",
      label: `${t("catalog.filter.q")}: ${isolate(applied.q)}`,
      onRemove: () => onApply({ ...applied, q: "" }),
    });
  }
  if (applied.status !== defaults.status) {
    chips.push({
      key: "status",
      label: `${t("catalog.filter.status")}: ${isolate(t(statusFilterKey(applied.status)))}`,
      onRemove: () => onApply({ ...applied, status: defaults.status }),
    });
  }
  // No category chip here: the category chip row under the bar
  // (`CatalogCategoryChips`) is the category control, and its pressed state
  // already says which category is applied.
  if (applied.brandId !== "") {
    const name =
      brands.find((b) => b.brandId.toLowerCase() === applied.brandId)?.name ??
      t("catalog.filter.brandSelected");
    chips.push({
      key: "brand",
      label: `${t("catalog.filter.brand")}: ${isolate(name)}`,
      onRemove: () => onApply({ ...applied, brandId: "" }),
    });
  }
  return chips;
}

/**
 * Modern concept 2/6 (Catalog): the category chips — "All categories" plus one
 * chip per category, as a segmented group (§12.6: `aria-pressed`, the pressed
 * segment in the action-fill pair). A chip writes into the draft, like the
 * category select behind «فلاتر إضافية»: Apply commits it to the URL, and an
 * unsaved draft (a typed search, a changed status) survives the click. The
 * chips use the category read the filter bar already makes, so they read
 * nothing new. With no categories (still loading, failed, or the tenant has
 * none) the row renders nothing: the category select behind «فلاتر إضافية»
 * still covers a retired or selected category.
 *
 * The chips are catalog-scoped classes, not the shared `.segmented`: that
 * class lives only in `overview.css`, which this page does not load.
 */
function CatalogCategoryChips({
  categoryId,
  categories,
  onSelect,
}: Readonly<{
  categoryId: string;
  categories: readonly CatalogCategory[];
  onSelect: (categoryId: string) => void;
}>): React.JSX.Element | null {
  const t = useT();
  if (categories.length === 0) return null;
  return (
    <fieldset className="catalog-chips-row" aria-label={t("catalog.filter.categoriesLabel")}>
      <button
        type="button"
        className="catalog-chip"
        aria-pressed={categoryId === ""}
        onClick={() => onSelect("")}
      >
        {t("catalog.filter.categoryAll")}
      </button>
      {categories.map((category) => {
        // The form's options carry the id lower case (the contract's id is
        // case-insensitive); the chips match them.
        const id = category.categoryId.toLowerCase();
        return (
          <button
            key={category.categoryId}
            type="button"
            className="catalog-chip"
            aria-pressed={categoryId === id}
            onClick={() => onSelect(id)}
          >
            {category.name}
          </button>
        );
      })}
    </fieldset>
  );
}

export function CatalogFilterBar({
  applied,
  categories,
  categoriesLoading,
  categoriesFailed,
  brands,
  brandsLoading,
  brandsFailed,
  initialErrors,
  onApply,
  onClear,
}: Readonly<CatalogFilterBarProps>): React.JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState<CatalogFilters>(applied);
  const [errors, setErrors] = useState<FilterErrors>(initialErrors);
  const chips = useChips(applied, brands, onApply);

  // The URL is the source of truth: when the applied filters change from outside
  // (Back, a deep link, a tenant change, a removed chip) the draft follows. The
  // form stays mounted, so keyboard focus survives an Apply.
  const appliedKey = JSON.stringify(applied);
  const [syncedKey, setSyncedKey] = useState(appliedKey);
  if (syncedKey !== appliedKey) {
    setSyncedKey(appliedKey);
    setDraft(applied);
    setErrors(initialErrors);
  }

  const set =
    <K extends keyof CatalogFilters>(key: K) =>
    (value: CatalogFilters[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const found = validateFilters(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onApply(draft);
  }

  function clear(): void {
    setDraft(defaultFilters());
    setErrors({});
    onClear();
  }

  const message = (key: MessageKey | undefined) => (key ? t(key) : undefined);
  // Category and brand sit behind «فلاتر إضافية»: the count is the applied
  // hidden filters, and the disclosure opens when one of them has an error
  // (a hand-edited URL), so the error is never hidden.
  const extraActive = (applied.categoryId !== "" ? 1 : 0) + (applied.brandId !== "" ? 1 : 0);
  const extraOpen = Boolean(errors.category ?? errors.brand);
  return (
    <>
      <FilterBar
        label={t("catalog.filter.label")}
        onSubmit={submit}
        onClear={clear}
        chips={chips}
        extraActive={extraActive}
        extraOpen={extraOpen}
        extra={
          <>
            <FilterField
              id="cf-category"
              label={t("catalog.filter.category")}
              error={message(errors.category)}
            >
              <select
                id="cf-category"
                className="input"
                aria-invalid={errors.category ? true : undefined}
                aria-describedby={categoriesFailed ? "cf-category-note" : undefined}
                value={draft.categoryId}
                onChange={(e) => set("categoryId")(e.target.value)}
              >
                <CategoryOptions
                  categories={categories}
                  appliedId={draft.categoryId}
                  loading={categoriesLoading}
                  failed={categoriesFailed}
                />
              </select>
            </FilterField>
            <FilterField
              id="cf-brand"
              label={t("catalog.filter.brand")}
              error={message(errors.brand)}
            >
              <select
                id="cf-brand"
                className="input"
                aria-invalid={errors.brand ? true : undefined}
                aria-describedby={brandsFailed ? "cf-brand-note" : undefined}
                value={draft.brandId}
                onChange={(e) => set("brandId")(e.target.value)}
              >
                <BrandOptions
                  brands={brands}
                  appliedId={draft.brandId}
                  loading={brandsLoading}
                  failed={brandsFailed}
                />
              </select>
            </FilterField>
          </>
        }
        note={
          <>
            <p id="cf-q-note" className="filter-bar__note-line">
              {t("catalog.filter.qNote")}
            </p>
            {categoriesFailed ? (
              <p id="cf-category-note" className="filter-bar__note-line">
                {t("catalog.filter.categoriesFailed")}
              </p>
            ) : null}
            {brandsFailed ? (
              <p id="cf-brand-note" className="filter-bar__note-line">
                {t("catalog.filter.brandsFailed")}
              </p>
            ) : null}
          </>
        }
      >
        <FilterField id="cf-q" label={t("catalog.filter.q")} error={message(errors.q)}>
          <input
            id="cf-q"
            className="input"
            dir="auto"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={MAX_QUERY_LENGTH}
            aria-describedby="cf-q-note"
            aria-invalid={errors.q ? true : undefined}
            value={draft.q}
            onChange={(e) => set("q")(e.target.value)}
          />
        </FilterField>
        <FilterField id="cf-status" label={t("catalog.filter.status")}>
          <select
            id="cf-status"
            className="input"
            value={draft.status}
            onChange={(e) => set("status")(e.target.value as CatalogFilters["status"])}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {t(statusFilterKey(s))}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>
      <CatalogCategoryChips
        categoryId={draft.categoryId}
        categories={categories}
        onSelect={set("categoryId")}
      />
    </>
  );
}
