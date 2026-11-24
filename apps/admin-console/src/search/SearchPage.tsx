/**
 * Global search: one term across the three things the contracts can actually
 * search, one page per section, no stitching and no invented figures.
 *
 * - Products: `consoleListCatalogProducts?q=` — an exact barcode, SKU or PLU,
 *   or a substring of the name. First 10, with a link to the catalog list
 *   for the rest.
 * - Sales: `consoleListSales?sale_number=` — an exact receipt number, in the
 *   active store's last 31 days. No active store, no lookup: the list read
 *   requires a store.
 * - Operators: no server search exists, so the page filters the one tenant
 *   roster read (`listMembers`) by name or email.
 *
 * A section the API refuses is omitted, as the attention ledger omits a
 * refused panel. The term lives in the URL (`?q=`), so a search is shareable
 * and Back returns to the previous term.
 */
import { Banner } from "@/components/Banner";
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { SectionIndex } from "@/components/SectionIndex";
import {
  canReadCatalog,
  statusBadgeClass,
  statusKey,
} from "@/catalog/catalogLogic";
import {
  type CatalogListState,
  useCatalogList,
  useCatalogScope,
} from "@/catalog/useCatalog";
import { formatNumber, Money, roleKey, useT } from "@/i18n";
import { useMembers } from "@/operators/useMembers";
import type { MemberRow } from "@/operators/useMembers";
import { BusinessDate, SaleNumber } from "@/sales/SaleParts";
import { canReadSales } from "@/sales/saleLogic";
import { type SaleListState, useSaleList, useSaleScope } from "@/sales/useSales";
import { foldForSearch } from "@/shell/Navigator";
import { useStoreDirectory } from "@/shift-closes/useShiftCloses";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  MAX_SALE_NUMBER_LENGTH,
  MAX_SEARCH_LENGTH,
  productSearchQuery,
  receiptSearchQuery,
  receiptWindow,
} from "./searchLogic";
import "./search.css";
import "../shell/surface.css";

function Section({
  position,
  title,
  hint,
  children,
}: Readonly<{
  position: number;
  title: string;
  hint: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <section className="section-panel search__section">
      <div className="section-panel__head">
        <SectionIndex position={position} />
        <h2 className="section-panel__title">{title}</h2>
      </div>
      <p className="search__hint">{hint}</p>
      {children}
    </section>
  );
}

function SectionError({
  onRetry,
}: Readonly<{ onRetry: () => void }>): React.JSX.Element {
  const t = useT();
  return (
    <Banner
      variant="danger"
      message={t("search.failed")}
      action={
        <button type="button" className="btn-secondary" onClick={onRetry}>
          {t("search.retry")}
        </button>
      }
    />
  );
}

function ProductsSection({
  q,
  position,
  list,
}: Readonly<{
  q: string;
  position: number;
  list: CatalogListState;
}>): React.JSX.Element | null {
  const t = useT();
  const captionId = useCaptionId();
  if (list.error?.kind === "not-found") return null;
  const moreHref = `/catalog/products?${new URLSearchParams({ q }).toString()}`;
  return (
    <Section position={position} title={t("search.products.title")} hint={t("search.products.hint")}>
      {list.isLoading ? (
        <ListState state="loading" label={t("search.loading")} />
      ) : list.error ? (
        <SectionError onRetry={list.retry} />
      ) : list.rows.length === 0 ? (
        <p>{t("search.products.empty", { q })}</p>
      ) : (
        <>
          <DataTableScroll captionId={captionId}>
            <table className="data-table">
              <caption id={captionId} className="data-table__caption">
                {t("search.products.title")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("search.products.col.name")}</th>
                  <th scope="col">{t("search.products.col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((p) => (
                  <tr key={p.productId}>
                    <td>
                      <Link to={`/catalog/products/${p.productId}`}>
                        <bdi>{p.name}</bdi>
                      </Link>
                    </td>
                    <td>
                      <span className={statusBadgeClass(p.status)}>{t(statusKey(p.status))}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTableScroll>
          {list.hasMore ? (
            <p className="search__more">
              {t("search.products.more", { count: formatNumber(list.rows.length, t.locale) })}{" "}
              <Link to={moreHref}>{t("search.products.seeAll")}</Link>
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

function SalesSection({
  q,
  position,
  list,
  hasStore,
  directoryReady,
}: Readonly<{
  q: string;
  position: number;
  list: SaleListState;
  hasStore: boolean;
  directoryReady: boolean;
}>): React.JSX.Element | null {
  const t = useT();
  const captionId = useCaptionId();
  if (list.error?.kind === "not-found") return null;
  return (
    <Section position={position} title={t("search.sales.title")} hint={t("search.sales.hint")}>
      {!hasStore ? (
        <p>{t("search.sales.needsStore")}</p>
      ) : !directoryReady ? (
        <ListState state="loading" label={t("search.loading")} />
      ) : q.length > MAX_SALE_NUMBER_LENGTH ? (
        <p>{t("search.sales.tooLong")}</p>
      ) : list.isLoading ? (
        <ListState state="loading" label={t("search.loading")} />
      ) : list.error ? (
        <SectionError onRetry={list.retry} />
      ) : list.rows.length === 0 ? (
        <p>{t("search.sales.empty", { q })}</p>
      ) : (
        <DataTableScroll captionId={captionId}>
          <table className="data-table">
            <caption id={captionId} className="data-table__caption">
              {t("search.sales.title")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("search.sales.col.number")}</th>
                <th scope="col">{t("search.sales.col.date")}</th>
                <th scope="col">{t("search.sales.col.total")}</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((s) => (
                <tr key={s.saleRef}>
                  <td>
                    <Link to={`/sales/${s.saleRef}`}>
                      <SaleNumber value={s.saleNumber} />
                    </Link>
                  </td>
                  <td>
                    <BusinessDate value={s.businessDate} />
                  </td>
                  <td>
                    <Money value={s.posTotal} currency={s.currencyCode} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableScroll>
      )}
    </Section>
  );
}

function OperatorsSection({
  q,
  position,
  rows,
  isLoading,
  notFound,
}: Readonly<{
  q: string;
  position: number;
  rows: MemberRow[];
  isLoading: boolean;
  notFound: boolean;
}>): React.JSX.Element | null {
  const t = useT();
  const captionId = useCaptionId();
  if (notFound) return null;
  return (
    <Section
      position={position}
      title={t("search.operators.title")}
      hint={t("search.operators.hint")}
    >
      {isLoading ? (
        <ListState state="loading" label={t("search.loading")} />
      ) : rows.length === 0 ? (
        <p>{t("search.operators.empty", { q })}</p>
      ) : (
        <DataTableScroll captionId={captionId}>
          <table className="data-table">
            <caption id={captionId} className="data-table__caption">
              {t("search.operators.title")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("search.operators.col.name")}</th>
                <th scope="col">{t("search.operators.col.email")}</th>
                <th scope="col">{t("search.operators.col.role")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.membershipId}>
                  <td>
                    <bdi>{m.displayName ?? m.email}</bdi>
                    {m.revoked ? (
                      <>
                        {" "}
                        <span className="badge">{t("operators.state.revoked")}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <bdi dir="ltr">{m.email}</bdi>
                  </td>
                  <td>{t(roleKey(m.roleCode))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableScroll>
      )}
    </Section>
  );
}

export function SearchPage(): React.JSX.Element {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const catalogScope = useCatalogScope();
  const saleScope = useSaleScope();
  const directory = useStoreDirectory(catalogScope.tenantId);
  const tooLong = q.length > MAX_SEARCH_LENGTH;
  const term = q === "" || tooLong ? null : q;

  const showProducts = canReadCatalog(catalogScope.role);
  const showSales = canReadSales(saleScope.role);
  const products = useCatalogList(
    catalogScope,
    showProducts ? productSearchQuery(term, catalogScope.activeStoreId) : null,
  );
  const window =
    directory.ready && saleScope.activeStoreId !== null
      ? receiptWindow(directory.timeZoneOf(saleScope.activeStoreId) ?? "UTC")
      : null;
  const sales = useSaleList(
    saleScope,
    showSales ? receiptSearchQuery(term, saleScope.activeStoreId, window) : null,
  );
  const members = useMembers(term === null ? null : catalogScope.tenantId);
  const operatorRows = useMemo(() => {
    if (term === null || members.result?.kind !== "rows") return [];
    const folded = foldForSearch(term);
    return members.result.rows.filter((m) =>
      foldForSearch(`${m.displayName ?? ""} ${m.email}`).includes(folded),
    );
  }, [members.result, term]);

  const settled = !products.isLoading && !sales.isLoading && !members.isLoading;
  const nothingVisible =
    term !== null &&
    settled &&
    (!showProducts || products.error?.kind === "not-found") &&
    (!showSales || sales.error?.kind === "not-found") &&
    members.result?.kind === "not-found";

  if (!catalogScope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("search.scopePrompt")}</p>
      </div>
    );
  }
  return (
    <div className="surface surface--v4 search-surface">
      <PageHeader
        title={t("search.title")}
        documentTitle={t("search.title")}
        subtitle={t("search.subtitle")}
      />
      <form
        className="search__form"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          setSearchParams(next === "" ? {} : { q: next });
        }}
      >
        <div className="field search__field">
          <label htmlFor="search-term">{t("search.input.label")}</label>
          <input
            id="search-term"
            className="input"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("search.input.placeholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary">
          {t("search.submit")}
        </button>
        {tooLong ? (
          <p className="search__error" role="alert">
            {t("catalog.filter.qTooLong")}
          </p>
        ) : null}
      </form>
      {q === "" ? (
        <section className="section-panel search__intro">
          <div className="section-panel__head">
            <h2 className="section-panel__title">{t("search.intro.title")}</h2>
          </div>
          <ul className="search__intro-list">
            <li>{t("search.intro.products")}</li>
            <li>{t("search.intro.sales")}</li>
            <li>{t("search.intro.operators")}</li>
          </ul>
        </section>
      ) : tooLong ? null : nothingVisible ? (
        <p>{t("search.nothing")}</p>
      ) : (
        <>
          {showProducts ? <ProductsSection q={q} position={1} list={products} /> : null}
          {showSales ? (
            <SalesSection
              q={q}
              position={2}
              list={sales}
              hasStore={saleScope.activeStoreId !== null}
              directoryReady={directory.ready}
            />
          ) : null}
          <OperatorsSection
            q={q}
            position={3}
            rows={operatorRows}
            isLoading={members.isLoading}
            notFound={members.result?.kind === "not-found"}
          />
        </>
      )}
    </div>
  );
}
