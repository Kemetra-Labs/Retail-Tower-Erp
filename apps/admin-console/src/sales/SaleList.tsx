import { ListHeaderBand } from "@/components/ListHeaderBand";
import { useT } from "@/i18n";
import type { SaleItem, SaleListQuery } from "@/lib/sale-queries";
import { useStoreDirectory } from "@/shift-closes/useShiftCloses";
/**
 * RT-587 — Sales search (spec 012 J1, read-only). One store's received sales
 * over an inclusive business-date range, newest first, keyset paged. Nothing
 * is read until a store and both dates are set (FR-004). Filters live in the
 * URL (FR-007). RT-960 (owner decision A): a URL with no filters applies the
 * active store and today in its zone; Clear returns to that default. With
 * no active store (tenant-wide scope) the prompt stays. A role the API refuses (store_staff) gets the non-disclosing
 * not-available state and no form (AC-5). The results and paging states are in
 * `SaleResults.tsx` and `SalePager.tsx`.
 */
import { useEffect } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { SaleFilterBar } from "./SaleFilterBar";
import { Unavailable } from "./SalePager";
import { QueryPrompt, Results } from "./SaleResults";
import {
  type FilterErrors,
  type SaleFilters,
  buildListQuery,
  emptyFilters,
  filtersFromSearch,
  filtersToSearch,
  isQueryReady,
  todayIn,
  validateFilters,
} from "./saleFilters";
import { canReadSales } from "./saleLogic";
import { type SaleListState, type SaleScope, useSaleList, useSaleScope } from "./useSales";
import "../shell/surface.css";
import "./sales.css";

/** What the URL asks for, and whether it may be read now. */
interface ListModel {
  filters: SaleFilters;
  errors: FilterErrors;
  valid: boolean;
  query: SaleListQuery | null;
}

function listModel(search: URLSearchParams, permitted: boolean): ListModel {
  const filters = filtersFromSearch(search);
  const errors = validateFilters(filters);
  const valid = Object.keys(errors).length === 0;
  const ready = permitted && valid && isQueryReady(filters);
  return { filters, errors, valid, query: ready ? buildListQuery(filters) : null };
}

/** The active store and today in its zone, once the roster names it; else null. */
function arrivalDefault(
  activeStoreId: string | null,
  stores: readonly { id: string; timezone?: string | null }[],
): SaleFilters | null {
  const store = activeStoreId ? stores.find((s) => s.id === activeStoreId) : undefined;
  if (!store) return null;
  const today = todayIn(store.timezone ?? "UTC");
  return { ...emptyFilters(), storeId: store.id, fromDate: today, toDate: today };
}

/**
 * Owner decision A (RT-960): whenever the URL has no filters (arrival, the nav
 * link from a filtered list), apply the default, replacing the empty entry so
 * Back does not return to it. It cannot loop: once written, the URL is not
 * empty.
 */
function useArrivalDefault(
  search: URLSearchParams,
  setSearch: ReturnType<typeof useSearchParams>[1],
  fallbackSearch: string,
): void {
  const empty = search.toString() === "";
  useEffect(() => {
    if (!empty || !fallbackSearch) return;
    setSearch(new URLSearchParams(fallbackSearch), { replace: true });
  }, [empty, fallbackSearch, setSearch]);
}

/** Below the form: the results of a ready query, or the prompt for a missing store or range. */
function ListBody({
  model,
  list,
  onOpen,
}: Readonly<{
  model: ListModel;
  list: SaleListState;
  onOpen: (row: SaleItem) => void;
}>): React.JSX.Element | null {
  if (model.query) return <Results list={list} onOpen={onOpen} />;
  return model.valid ? <QueryPrompt /> : null;
}

function Shell({
  scope,
  children,
}: Readonly<{ scope: SaleScope; children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      {/* RT-821: the daily report is reached from here, not from the sidebar (UX-09). */}
      <ListHeaderBand
        group={t("shell.nav.section.operations")}
        title={t("sales.list.title")}
        subtitle={t.rich("sales.list.sub", { tenant: <bdi>{scope.tenantName}</bdi> })}
        actions={
          <div className="surface__actions surface__actions--head">
            <Link to="/sales-daily" className="btn-secondary">
              {t("salesDaily.entry")}
            </Link>
          </div>
        }
      />
      {children}
    </div>
  );
}

export function SaleList(): React.JSX.Element {
  const t = useT();
  const scope = useSaleScope();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // A refused role reads nothing: the server would answer the same 404 (AC-5).
  const permitted = canReadSales(scope.role);
  const directory = useStoreDirectory(permitted ? scope.tenantId : null);
  const model = listModel(search, permitted);
  const list = useSaleList(scope, model.query);
  const fallback = permitted ? arrivalDefault(scope.activeStoreId, directory.stores) : null;
  useArrivalDefault(search, setSearch, fallback ? filtersToSearch(fallback).toString() : "");

  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("sales.list.scopePrompt")}</p>
      </div>
    );
  }
  if (!permitted) {
    return (
      <Shell scope={scope}>
        <Unavailable />
      </Shell>
    );
  }
  return (
    <Shell scope={scope}>
      <SaleFilterBar
        applied={model.filters}
        stores={directory.stores}
        activeStoreId={scope.activeStoreId}
        initialErrors={model.errors}
        onApply={(next) => setSearch(filtersToSearch(next))}
        // Clear returns to the arrival default (active store, today), or to nothing.
        onClear={() => setSearch(fallback ? filtersToSearch(fallback) : new URLSearchParams())}
      />
      <ListBody
        model={model}
        list={list}
        onOpen={(row) => navigate(`/sales/${row.saleRef}`, { state: { list: location.search } })}
      />
    </Shell>
  );
}
