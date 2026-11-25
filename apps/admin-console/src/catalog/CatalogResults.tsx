/**
 * RT-765 list results (CAT-C1a, RT-752 AC 4): the cards, their loading skeleton,
 * the error views and the empty states. Completeness is honest: only
 * `items: []` with `nextCursor: null` is "no items"; a short or empty page with
 * a cursor shows the cards so far and Load more. A 400 is a validation message,
 * never an empty list, and offers no Retry: the same query would be rejected
 * again. A 404 with a store in scope is a stale store, never "no items".
 *
 * Modern concept 2/6 (Catalog): the dense table rows become cards — the name,
 * status and price at a glance, the category and the primary codes under them.
 * The metadata the table carried (tax category, tracking, updated-at) sits
 * behind each card's details disclosure; the detail page still holds the full
 * record. There is no product image in the contract
 * (`ConsoleCatalogProductSummary` carries none), so the card's thumb is the
 * first letter of the name — a visual anchor, never a picture of the item.
 * The card's name is the link to the detail (the row's activation, as a link).
 * The disclosure is a button with `aria-expanded`, like the filter bar's
 * «فلاتر إضافية» toggle, not a native `<details>`: the content mounts only
 * when open.
 *
 * No smart insight line (rule 4) and no KPI strip (rule 3): the list is a
 * keyset walk with no totals in the contract, so any count would describe only
 * the loaded page and mislead; the loaded count stays where it was, in the
 * pager. Every value is the server's: no price or availability is computed
 * here.
 *
 * RT-1010 (v4.0): every result state sits in one results panel. The cards are
 * section panels (§12.5), so they share the one resting elevation.
 */
import { Banner } from "@/components/Banner";
import { DateTime, Money, useT } from "@/i18n";
import type { CatalogProduct } from "@/lib/catalog-queries";
import { useId, useState } from "react";
import { Link } from "react-router";
import { Notice, Pager, StoreStale, Unavailable } from "./CatalogPager";
import { availabilityKey, statusBadgeClass, statusKey, trackingKey } from "./catalogLogic";
import type { CatalogError, CatalogListState } from "./useCatalog";

/** A machine value (SKU, barcode, tax category): isolated LTR, "—" when absent. */
function Code({ value }: Readonly<{ value: string | null }>): React.JSX.Element {
  if (value === null) return <>—</>;
  return (
    <bdi dir="ltr" className="catalog-nowrap">
      {value}
    </bdi>
  );
}

/** The store's resolved price with a store in scope, else the tenant default. */
function Price({
  product,
  storeInScope,
}: Readonly<{ product: CatalogProduct; storeInScope: boolean }>): React.JSX.Element {
  const t = useT();
  // With a store in scope the price is the store's. A card without its storeView
  // (the contract always sends one) shows no price rather than the tenant's.
  if (storeInScope && !product.storeView) return <>—</>;
  const money = storeInScope ? product.storeView?.effectivePrice : product.defaultPrice;
  if (!money) return <>{t("catalog.value.noPrice")}</>;
  return <Money value={money.amount} currency={money.currencyCode} className="catalog-nowrap" />;
}

function Availability({ product }: Readonly<{ product: CatalogProduct }>): React.JSX.Element {
  const t = useT();
  const view = product.storeView;
  if (!view) return <>—</>;
  return (
    <span className="catalog-chips">
      <span className="badge">{t(availabilityKey(view.effectiveActive))}</span>
      {view.hasOverride ? (
        <span className="badge">{t("catalog.availability.override")}</span>
      ) : null}
    </span>
  );
}

/**
 * The codes a card shows, in the table's order: the primary SKU, then the
 * primary barcode. Absent values are omitted, never "—": a card shows what
 * the item has.
 */
function Codes({ product }: Readonly<{ product: CatalogProduct }>): React.JSX.Element | null {
  const codes = [product.primarySku, product.primaryBarcode].filter(
    (code): code is string => code !== null,
  );
  if (codes.length === 0) return null;
  return (
    <span className="catalog-card__codes">
      {codes.map((code, i) => (
        <span key={`${i}:${code}`} className="catalog-card__code">
          {i > 0 ? <span aria-hidden="true"> • </span> : null}
          <Code value={code} />
        </span>
      ))}
    </span>
  );
}

/**
 * One item as a card: the thumb (the name's first letter — the contract has no
 * image), the name as the link to the detail, the status and the store
 * availability, the price, and the category with the primary codes. The
 * metadata the table carried sits behind the details disclosure, with the
 * detail page's own labels (`catalog.detail.field.*`).
 */
function ProductCard({
  product,
  storeInScope,
}: Readonly<{ product: CatalogProduct; storeInScope: boolean }>): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const factsId = useId();
  return (
    <li className="section-panel catalog-card">
      <div className="catalog-card__main">
        <span className="catalog-card__thumb" aria-hidden="true">
          {product.name.charAt(0)}
        </span>
        <div className="catalog-card__head">
          <h2 className="catalog-card__name">
            <Link to={`/catalog/products/${product.productId}`}>{product.name}</Link>
          </h2>
          <span className="catalog-card__badges">
            <span className={statusBadgeClass(product.status)}>{t(statusKey(product.status))}</span>
            {storeInScope ? <Availability product={product} /> : null}
          </span>
        </div>
      </div>
      <p className="catalog-card__price">
        <Price product={product} storeInScope={storeInScope} />
      </p>
      <p className="catalog-card__meta">
        <span className="catalog-card__category">
          {product.categoryName ?? t("catalog.value.noCategory")}
        </span>
        <Codes product={product} />
      </p>
      <div className="catalog-card__more">
        <button
          type="button"
          className="catalog-card__more-btn"
          aria-expanded={open}
          aria-controls={factsId}
          onClick={() => setOpen(!open)}
        >
          {t("catalog.list.cardMore")}
        </button>
        {open ? (
          <dl id={factsId} className="catalog-card__facts">
            <div>
              <dt>{t("catalog.detail.field.taxCategory")}</dt>
              <dd>
                <Code value={product.taxCategory} />
              </dd>
            </div>
            <div>
              <dt>{t("catalog.detail.field.tracking")}</dt>
              <dd>{t(trackingKey(product.trackingMode))}</dd>
            </div>
            <div>
              <dt>{t("catalog.detail.field.updatedAt")}</dt>
              <dd>
                <DateTime value={product.updatedAt} className="catalog-nowrap" />
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    </li>
  );
}

/** Six placeholder cards, in the grid's shape: flat bars, no animation. */
function CardSkeleton({ caption }: Readonly<{ caption: string }>): React.JSX.Element {
  const t = useT();
  return (
    <div
      className="catalog-grid"
      role="status"
      aria-busy="true"
      aria-label={`${caption}: ${t("catalog.list.loadingNoun")}`}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="section-panel catalog-card catalog-card--skeleton"
          aria-hidden="true"
        >
          <span className="catalog-card__bar catalog-card__bar--name" />
          <span className="catalog-card__bar catalog-card__bar--price" />
          <span className="catalog-card__bar catalog-card__bar--meta" />
        </div>
      ))}
    </div>
  );
}

/** How each error kind is told. Only a generic failure can succeed on a retry. */
const ERROR_BANNERS = {
  generic: { variant: "danger", message: "catalog.list.loadFailed", retry: true },
  session: { variant: "danger", message: "catalog.list.sessionExpired", retry: false },
  rejected: { variant: "warning", message: "catalog.list.filterRejected", retry: false },
} as const;

function ErrorView({
  error,
  storeInScope,
  onRetry,
}: Readonly<{
  error: CatalogError;
  storeInScope: boolean;
  onRetry: () => void;
}>): React.JSX.Element {
  const t = useT();
  if (error.kind === "not-found") return storeInScope ? <StoreStale /> : <Unavailable />;
  const banner = ERROR_BANNERS[error.kind];
  return (
    <Banner
      variant={banner.variant}
      message={t(banner.message)}
      requestId={error.requestId}
      action={
        banner.retry ? (
          <button type="button" className="btn-secondary" onClick={onRetry}>
            {t("catalog.list.retry")}
          </button>
        ) : undefined
      }
    />
  );
}

function EmptyNotice({
  filtered,
  summary,
  onClear,
}: Readonly<{
  filtered: boolean;
  summary: React.ReactNode;
  onClear: () => void;
}>): React.JSX.Element {
  const t = useT();
  if (!filtered) {
    // No create control: creating an item is its own slice, and waits on an owner decision (RT-752 D9).
    return <Notice message={t("catalog.list.empty")} hint={t("catalog.list.emptyHint")} />;
  }
  return (
    <Notice
      message={t.rich("catalog.list.emptyFiltered", { filters: summary })}
      hint={t("catalog.list.emptyFilteredHint")}
      action={
        <button type="button" className="btn-secondary" onClick={onClear}>
          {t("catalog.list.clearFilters")}
        </button>
      }
    />
  );
}

export interface CatalogResultsProps {
  list: CatalogListState;
  /** A store is in scope: the list was requested with `store_id`. */
  storeInScope: boolean;
  /** The applied filters differ from the default: an empty walk is a filtered one. */
  filtered: boolean;
  /** The applied filters in words, for the filtered-empty message. */
  summary: React.ReactNode;
  /** The search text is set: exact code matches are listed first (stated in the caption). */
  searching: boolean;
  onClearFilters: () => void;
}

/** Only `items: []` with `nextCursor: null` is "no items". */
function isEmptyWalk(list: CatalogListState): boolean {
  return list.rows.length === 0 && list.ended;
}

export function Results(props: Readonly<CatalogResultsProps>): React.JSX.Element {
  return (
    <div className="section-panel catalog-results">
      <ResultState {...props} />
    </div>
  );
}

function ResultState({
  list,
  storeInScope,
  filtered,
  summary,
  searching,
  onClearFilters,
}: Readonly<CatalogResultsProps>): React.JSX.Element {
  const t = useT();
  const captionId = useId();
  const caption = t(searching ? "catalog.list.captionSearch" : "catalog.list.caption");
  if (list.isLoading) {
    return (
      <>
        <p id={captionId} className="catalog-grid__caption">
          {caption}
        </p>
        <CardSkeleton caption={caption} />
      </>
    );
  }
  if (list.error) {
    return <ErrorView error={list.error} storeInScope={storeInScope} onRetry={list.retry} />;
  }
  if (isEmptyWalk(list)) {
    return <EmptyNotice filtered={filtered} summary={summary} onClear={onClearFilters} />;
  }
  return (
    <>
      <p id={captionId} className="catalog-grid__caption">
        {caption}
      </p>
      {list.rows.length > 0 ? (
        <ul className="catalog-grid" aria-labelledby={captionId}>
          {list.rows.map((product) => (
            <ProductCard key={product.productId} product={product} storeInScope={storeInScope} />
          ))}
        </ul>
      ) : (
        <output className="catalog-partial">{t("catalog.list.partialPage")}</output>
      )}
      <Pager list={list} storeInScope={storeInScope} />
    </>
  );
}
