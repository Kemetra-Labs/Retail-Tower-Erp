import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
/**
 * RT-766 — Catalog product detail «الصنف» (CAT-C1b, RT-752 AC 2 and D3). A
 * full, deep-linkable page: the tenant's values first, then the item's
 * identifiers, then each store's override as the raw deviation it is (RT-752
 * D8: the UI never computes `override ?? tenant`). The page itself edits
 * nothing. RT-768 adds, for owner and tenant_admin only and only on an item that
 * is not retired, a link to the edit route and the Retire action; a retired item
 * and `store_manager` see no Edit or Retire. RT-769 (CAT-C2b) adds, under the
 * same rule (owner and tenant_admin, item not retired), the identifier Add /
 * Retire drawers. RT-770 (CAT-C2c) adds, for owner, tenant_admin and
 * store_manager on an item that is not retired, a drawer that sets or clears
 * one store's deviation (availability; tax for owner and tenant_admin only),
 * opened from that store's override or, for the store in scope, from "Set
 * values". A product the API
 * refuses (another tenant, a role outside the catalog, an id that is not a UUID)
 * is one non-disclosing "not available" state. With a store in scope the page
 * links to that store's on-hand stock (RT-728); it shows no ERP data.
 */
import { DetailGrid, HeaderStatus } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import type { CatalogProductDetail as ProductDetail } from "@/lib/catalog-queries";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { StoreOverrides, TenantValues } from "./CatalogDetailSections";
import { Notice } from "./CatalogPager";
import { ProductIdentifiers } from "./ProductIdentifiers";
import { ProductRetire } from "./ProductRetire";
import { type OverrideOutcome, StoreOverrideDrawer } from "./StoreOverrideDrawer";
import { inventoryPath, isProductId } from "./catalogDetailLogic";
import { canReadCatalog, statusBadgeClass, statusKey } from "./catalogLogic";
import { canWriteCatalog } from "./productFormLogic";
import { canWriteOverrides } from "./storeOverrideLogic";
import { type CatalogScope, useCatalogScope } from "./useCatalog";
import {
  type CatalogProductError,
  type StoreLabel,
  useCatalogProduct,
  useStoreLabels,
} from "./useCatalogProduct";
import "../shell/surface.css";
import "./catalog.css";

function BackLink(): React.JSX.Element {
  const t = useT();
  return (
    <Link to="/catalog/products" className="surface__back">
      <BackArrow /> {t("catalog.detail.back")}
    </Link>
  );
}

/** The one non-disclosing state: it never says why, and it names no request. */
function NotAvailable(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <BackLink />
      <Notice
        message={t("catalog.detail.unavailable")}
        hint={t("catalog.detail.unavailableHint")}
      />
    </div>
  );
}

/** A failed read. Only a rate limit or a server failure can succeed on a retry. */
function ReadFailure({
  error,
  onRetry,
}: Readonly<{ error: CatalogProductError; onRetry: () => void }>): React.JSX.Element {
  const t = useT();
  if (error.kind === "not-found") return <NotAvailable />;
  const retry = (
    <GatedButton type="button" className="btn-secondary" onClick={onRetry}>
      {t("catalog.detail.retry")}
    </GatedButton>
  );
  return (
    <div className="surface">
      <BackLink />
      {error.kind === "session" ? (
        <Banner
          variant="danger"
          message={t("catalog.detail.sessionExpired")}
          requestId={error.requestId}
        />
      ) : (
        <Banner
          variant={error.kind === "rate-limited" ? "warning" : "danger"}
          message={t(
            error.kind === "rate-limited"
              ? "catalog.detail.rateLimited"
              : "catalog.detail.loadFailed",
          )}
          requestId={error.requestId}
          action={retry}
        />
      )}
    </div>
  );
}

/** A store as copy names it: its name when known, else its id. */
function storeNameOf(label: StoreLabel): string {
  return label.name ?? label.id;
}

function Loaded({
  product,
  scope,
  reload,
}: Readonly<{
  product: ProductDetail;
  scope: CatalogScope;
  reload: () => Promise<ProductDetail | undefined>;
}>): React.JSX.Element {
  const t = useT();
  const { summary } = product;
  const retired = summary.status === "retired";
  const canWrite = canWriteCatalog(scope.role) && !retired && scope.tenantId !== null;
  const [justRetired, setJustRetired] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // After Retire the confirmation is gone: focus goes to the page title, which now says so.
  useEffect(() => {
    if (justRetired) titleRef.current?.focus();
  }, [justRetired]);
  const needsNames =
    product.storeOverrides.length > 0 || product.identifiers.some((i) => i.storeId !== null);
  const storeLabel = useStoreLabels(
    scope.tenantId,
    { id: scope.activeStoreId, name: scope.activeStoreName },
    needsNames,
  );
  const onHand = inventoryPath(scope.role, scope.activeStoreId, summary.productId);
  // RT-770: store deviations are writable by every override role while the item is not retired.
  const overridesWritable = canWriteOverrides(scope.role) && !retired && scope.tenantId !== null;
  const [editingStore, setEditingStore] = useState<string | null>(null);
  const [overrideDone, setOverrideDone] = useState<{
    outcome: OverrideOutcome;
    store: string;
  } | null>(null);
  const activeStoreId = scope.activeStoreId;
  const activeHasOverride = product.storeOverrides.some((o) => o.storeId === activeStoreId);
  function openOverride(storeId: string): void {
    setOverrideDone(null);
    setEditingStore(storeId);
  }
  return (
    <div className="surface">
      <BackLink />
      <PageHeader
        title={<bdi dir="auto">{summary.name}</bdi>}
        titleRef={titleRef}
        subtitle={t.rich(
          canWriteCatalog(scope.role) || canWriteOverrides(scope.role)
            ? "catalog.detail.subWriter"
            : "catalog.detail.sub",
          {
            tenant: <bdi>{scope.tenantName}</bdi>,
          },
        )}
        actions={
          onHand || canWrite ? (
            <div className="surface__actions surface__actions--head">
              {onHand ? (
                <Link to={onHand} className="btn-ghost">
                  {t("catalog.detail.inventoryLink", { store: scope.activeStoreName ?? "" })}
                </Link>
              ) : null}
              {canWrite ? (
                <Link to={`/catalog/products/${summary.productId}/edit`} className="btn-primary">
                  {t("catalog.detail.edit")}
                </Link>
              ) : null}
            </div>
          ) : null
        }
      >
        <HeaderStatus label={t("catalog.detail.field.status")}>
          <span className={statusBadgeClass(summary.status)}>{t(statusKey(summary.status))}</span>
        </HeaderStatus>
      </PageHeader>
      {justRetired ? (
        <Banner variant="success" message={t("catalog.retire.done", { name: summary.name })} />
      ) : null}
      {retired && !justRetired ? (
        <Banner variant="info" message={t("catalog.detail.retiredNotice")} />
      ) : null}
      <DetailGrid>
        <TenantValues product={product} />
      </DetailGrid>
      <ProductIdentifiers
        product={product}
        writableTenantId={canWrite ? scope.tenantId : null}
        storeLabel={storeLabel}
        reload={reload}
      />
      <StoreOverrides
        product={product}
        storeLabel={storeLabel}
        storeActions={
          overridesWritable
            ? (storeId, label) => (
                <div className="catalog-detail__store-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    aria-haspopup="dialog"
                    onClick={() => openOverride(storeId)}
                  >
                    {t("catalog.override.change", { store: storeNameOf(label) })}
                  </button>
                </div>
              )
            : undefined
        }
      >
        {overrideDone ? (
          <Banner
            variant="success"
            message={t(
              overrideDone.outcome === "saved"
                ? "catalog.override.saved"
                : "catalog.override.removed",
              { store: overrideDone.store },
            )}
          />
        ) : null}
        {overridesWritable && activeStoreId && !activeHasOverride ? (
          <div className="surface__actions catalog-retire__actions">
            <button
              type="button"
              className="btn-secondary"
              aria-haspopup="dialog"
              onClick={() => openOverride(activeStoreId)}
            >
              {t("catalog.override.add", { store: storeNameOf(storeLabel(activeStoreId)) })}
            </button>
          </div>
        ) : null}
        {overridesWritable && !activeStoreId ? (
          <p className="catalog-detail__note">{t("catalog.override.chooseStore")}</p>
        ) : null}
      </StoreOverrides>
      {editingStore && scope.tenantId ? (
        <StoreOverrideDrawer
          product={product}
          storeId={editingStore}
          storeName={storeNameOf(storeLabel(editingStore))}
          role={scope.role}
          tenantId={scope.tenantId}
          reload={reload}
          onClose={() => setEditingStore(null)}
          onDone={(outcome) => {
            setOverrideDone({ outcome, store: storeNameOf(storeLabel(editingStore)) });
            setEditingStore(null);
          }}
        />
      ) : null}
      {canWrite && scope.tenantId ? (
        <ProductRetire
          product={product}
          tenantId={scope.tenantId}
          reload={reload}
          onRetired={() => setJustRetired(true)}
        />
      ) : null}
    </div>
  );
}

function DetailContent({
  scope,
  productId,
}: Readonly<{ scope: CatalogScope; productId: string | null }>): React.JSX.Element {
  const t = useT();
  const { product, isLoading, error, retry, reload } = useCatalogProduct(scope.tenantId, productId);
  if (productId === null) return <NotAvailable />;
  if (isLoading) {
    return (
      <div className="surface">
        <BackLink />
        <ListState state="loading" label={t("catalog.detail.loadingNoun")} />
      </div>
    );
  }
  // A failed re-read keeps the item on screen (its Retire section says the reload failed).
  if (product) return <Loaded product={product} scope={scope} reload={reload} />;
  if (error) return <ReadFailure error={error} onRetry={retry} />;
  return <div className="surface" />;
}

export function CatalogProductDetail(): React.JSX.Element {
  const t = useT();
  const { productId } = useParams();
  const scope = useCatalogScope();
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("catalog.detail.scopePrompt")}</p>
      </div>
    );
  }
  // A refused role or an id the API would reject reads nothing: the server would answer 404 / 400.
  const readable = canReadCatalog(scope.role) && isProductId(productId);
  return <DetailContent scope={scope} productId={readable ? productId : null} />;
}
