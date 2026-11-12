/**
 * RT-1338 brands page (RT-286 S6): the tenant's flat brand list, next to the items it classifies.
 * Brands are created and renamed here; the product form assigns one (`brandId`) and the item list
 * filters by it. The list is the whole non-retired set, so there is no paging.
 *
 * Read: owner, tenant_admin, store_manager. Create and rename: owner and tenant_admin (the controls
 * are hidden for a store_manager; Backend-Core stays the authority). No active tenant → a scope
 * prompt; any other role gets NoAccess and nothing is requested.
 */
import { NoAccess } from "@/auth/NoAccess";
import { Banner } from "@/components/Banner";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { ScopePrompt } from "@/components/ScopePrompt";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import type { CatalogBrand } from "@/lib/brand-queries";
import { useSignOut } from "@/shell/useSignOut";
import { useState } from "react";
import { BrandEditor } from "./BrandEditor";
import { canManageBrands, canReadBrands } from "./brandLogic";
import { type BrandListState, useCatalogBrands } from "./useBrands";
import "../shell/surface.css";

type Editing = { kind: "none" } | { kind: "create" } | { kind: "rename"; brand: CatalogBrand };

function BrandRows({
  brands,
  canManage,
  onRename,
}: Readonly<{
  brands: readonly CatalogBrand[];
  canManage: boolean;
  onRename: (brand: CatalogBrand) => void;
}>) {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table">
          <caption id={captionId} className="data-table__caption">
            {t("brands.list.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("brands.list.col.name")}</th>
              <th scope="col">{t("brands.list.col.updated")}</th>
              <th scope="col">
                <span className="sr-only">{t("brands.list.col.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {brands.map((brand) => (
              <tr key={brand.brandId} className="data-table__row">
                <td>
                  <bdi dir="auto">{brand.name}</bdi>
                </td>
                <td>{formatDateTime(brand.updatedAt)}</td>
                <td>
                  {canManage ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => onRename(brand)}
                      aria-label={t("brands.list.renameLabel", { name: brand.name })}
                    >
                      {t("brands.list.rename")}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

function BrandListBody({
  list,
  canManage,
  onRename,
}: Readonly<{
  list: BrandListState;
  canManage: boolean;
  onRename: (brand: CatalogBrand) => void;
}>): React.JSX.Element {
  const t = useT();
  const { brands, isLoading, failed } = list;
  return (
    <>
      {failed ? (
        <Banner
          variant="danger"
          message={t("brands.list.loadFailed")}
          action={
            <button type="button" className="btn-secondary" onClick={list.retry}>
              {t("brands.list.retry")}
            </button>
          }
        />
      ) : null}
      {isLoading ? <ListState state="loading" label={t("brands.list.loadingNoun")} /> : null}
      {!isLoading && !failed && brands.length === 0 ? (
        <ListState state="empty" emptyMessage={t("brands.list.empty")} />
      ) : null}
      {brands.length > 0 ? (
        <BrandRows brands={brands} canManage={canManage} onRename={onRename} />
      ) : null}
    </>
  );
}

export function BrandList(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const { context } = useActiveContextValue();
  const tenant = context?.active_tenant ?? null;
  const allowed = canReadBrands(context?.active_role_code);
  const canManage = canManageBrands(context?.active_role_code);
  const list = useCatalogBrands(tenant?.id ?? null, allowed);
  const [editing, setEditing] = useState<Editing>({ kind: "none" });

  if (!tenant?.id) {
    return <ScopePrompt message={t("brands.list.scopePrompt")} />;
  }
  if (!allowed) return <NoAccess onSignOut={signOut} />;

  const newButton = canManage ? (
    <button type="button" className="btn-primary" onClick={() => setEditing({ kind: "create" })}>
      {t("brands.list.create")}
    </button>
  ) : undefined;
  return (
    <div className="surface">
      <ListHeaderBand
        group={t("shell.nav.section.stock")}
        title={t("brands.list.title")}
        subtitle={t.rich("brands.list.subtitle", { tenant: <bdi>{tenant.name ?? tenant.id}</bdi> })}
        actions={newButton}
      />
      <BrandListBody
        list={list}
        canManage={canManage}
        onRename={(brand) => setEditing({ kind: "rename", brand })}
      />
      {editing.kind === "none" ? null : (
        <BrandEditor
          // A rename of another brand mounts a fresh form.
          key={editing.kind === "rename" ? editing.brand.brandId : "create"}
          tenantId={tenant.id}
          brand={editing.kind === "rename" ? editing.brand : undefined}
          onClose={() => setEditing({ kind: "none" })}
        />
      )}
    </div>
  );
}
