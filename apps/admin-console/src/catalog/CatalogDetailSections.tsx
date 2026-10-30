/**
 * RT-766 detail sections (CAT-C1b, RT-752 AC 2): the tenant's values, the
 * item's identifiers and each store's override. Read-only text throughout: the
 * price is a value, not a disabled input. Overrides are the store's raw
 * deviations beside the labelled tenant value; nothing here computes what a
 * store resolves (RT-752 D8). Codes are isolated LTR and kept as stored
 * (`white-space: pre-wrap`, so leading zeros and inner spaces survive). RT-770
 * lets the page put each store's write controls beside its name; the section
 * itself still edits nothing.
 *
 * RT-961: each section is a section panel (DESIGN.md §5); the identifiers
 * table sits under its panel header, and the tenant price is end-aligned.
 * Tables scroll in their own region (RT-826), so a narrow panel never clips
 * a row action.
 */
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { DateTime, Money, type T, useT } from "@/i18n";
import type { CatalogIdentifier, CatalogMoney, CatalogProductDetail } from "@/lib/catalog-queries";
import {
  type Deviation,
  deviationFieldKey,
  identifierKey,
  identifierTypeKey,
  storeDeviations,
  tenantAvailable,
} from "./catalogDetailLogic";
import { availabilityKey, statusBadgeClass, statusKey, trackingKey } from "./catalogLogic";
import type { StoreLabel } from "./useCatalogProduct";

/** A machine value (identifier, tax category, id): LTR-isolated, exactly as stored. */
function Code({ value }: Readonly<{ value: string }>): React.JSX.Element {
  return (
    <bdi dir="ltr" className="catalog-code">
      {value}
    </bdi>
  );
}

/** A section panel; `table` sits edge to edge under the panel's body. */
function Section({
  id,
  title,
  table,
  children,
}: Readonly<{
  id: string;
  title: string;
  table?: React.ReactNode;
  children?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <DetailPanel id={id} title={title}>
      {children ? <PanelBody>{children}</PanelBody> : null}
      {table}
    </DetailPanel>
  );
}

const Row = LedgerField;

/** The tenant default price as read-only text; no price says the POS will not sell the item. */
export function TenantPrice({
  price,
}: Readonly<{ price: CatalogMoney | null }>): React.JSX.Element {
  const t = useT();
  if (!price) return <>{t("catalog.detail.noPriceNotice")}</>;
  return <Money value={price.amount} currency={price.currencyCode} />;
}

export function TenantValues({
  product,
}: Readonly<{ product: CatalogProductDetail }>): React.JSX.Element {
  const t = useT();
  const { summary } = product;
  return (
    <Section id="catalog-detail-tenant" title={t("catalog.detail.tenant.title")}>
      <dl className="surface__detail">
        <Row label={t("catalog.detail.field.status")}>
          <span className={statusBadgeClass(summary.status)}>{t(statusKey(summary.status))}</span>
        </Row>
        <Row label={t("catalog.detail.field.description")}>
          {product.description ? (
            <bdi dir="auto" className="catalog-description">
              {product.description}
            </bdi>
          ) : (
            t("catalog.detail.value.noDescription")
          )}
        </Row>
        <Row label={t("catalog.detail.field.category")}>
          {summary.categoryName ? (
            <bdi dir="auto">{summary.categoryName}</bdi>
          ) : (
            t("catalog.value.noCategory")
          )}
        </Row>
        <Row label={t("catalog.detail.field.taxCategory")}>
          <Code value={summary.taxCategory} />
        </Row>
        <Row label={t("catalog.detail.field.tenantAvailability")}>
          {t(availabilityKey(tenantAvailable(summary)))}
        </Row>
        <Row label={t("catalog.detail.field.tracking")}>{t(trackingKey(summary.trackingMode))}</Row>
        <Row label={t("catalog.detail.field.price")} money>
          <TenantPrice price={summary.defaultPrice} />
        </Row>
        <Row label={t("catalog.detail.field.updatedAt")}>
          <DateTime value={summary.updatedAt} />
        </Row>
      </dl>
    </Section>
  );
}

/** A store as a label: its name when known, else its id, isolated LTR. */
function StoreName({ label }: Readonly<{ label: StoreLabel }>): React.JSX.Element {
  return label.name ? <bdi dir="auto">{label.name}</bdi> : <Code value={label.id} />;
}

function IdentifierRow({
  identifier,
  storeLabel,
  rowAction,
}: Readonly<{
  identifier: CatalogIdentifier;
  storeLabel: (id: string) => StoreLabel;
  rowAction?: (identifier: CatalogIdentifier) => React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  return (
    <tr>
      <td>{t(identifierTypeKey(identifier.identifierType))}</td>
      <td>
        <Code value={identifier.value} />
      </td>
      <td>
        {identifier.storeId ? (
          <StoreName label={storeLabel(identifier.storeId)} />
        ) : (
          t("catalog.detail.identifiers.scopeAll")
        )}
      </td>
      <td>{identifier.sourceSystem ? <Code value={identifier.sourceSystem} /> : "—"}</td>
      {rowAction ? <td className="catalog-identifiers__action">{rowAction(identifier)}</td> : null}
    </tr>
  );
}

/**
 * The item's active identifiers. Read-only by default; RT-769 passes, for a
 * writer on an item that is not retired, `actions` (the Add control and the
 * outcome of the last write) and `rowAction` (each row's Retire control).
 */
export function Identifiers({
  identifiers,
  storeLabel,
  actions,
  rowAction,
}: Readonly<{
  identifiers: readonly CatalogIdentifier[];
  storeLabel: (id: string) => StoreLabel;
  actions?: React.ReactNode;
  rowAction?: (identifier: CatalogIdentifier) => React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const captionId = useCaptionId();
  const empty = identifiers.length === 0;
  const table = empty ? null : (
    <DataTableScroll captionId={captionId}>
      <table className="data-table catalog-readonly">
        <caption id={captionId} className="data-table__caption">
          {t("catalog.detail.identifiers.caption")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("catalog.detail.identifiers.col.type")}</th>
            <th scope="col">{t("catalog.detail.identifiers.col.value")}</th>
            <th scope="col">{t("catalog.detail.identifiers.col.scope")}</th>
            <th scope="col">{t("catalog.detail.identifiers.col.source")}</th>
            {rowAction ? <th scope="col">{t("catalog.identifier.col.actions")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {identifiers.map((identifier) => (
            <IdentifierRow
              key={identifierKey(identifier)}
              identifier={identifier}
              storeLabel={storeLabel}
              rowAction={rowAction}
            />
          ))}
        </tbody>
      </table>
    </DataTableScroll>
  );
  return (
    <Section
      id="catalog-detail-identifiers"
      title={t("catalog.detail.identifiers.title")}
      table={table}
    >
      {actions || empty ? (
        <>
          {actions}
          {empty ? (
            <p className="catalog-detail__empty">{t("catalog.detail.identifiers.empty")}</p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function DeviationValue({
  deviation,
  side,
}: Readonly<{ deviation: Deviation; side: "override" | "tenant" }>): React.JSX.Element {
  const t = useT();
  switch (deviation.field) {
    case "availability":
      return <>{t(availabilityKey(deviation[side]))}</>;
    case "taxCategory":
      return <Code value={deviation[side]} />;
    case "price": {
      const money = deviation[side];
      if (!money) return <>{t("catalog.value.noPrice")}</>;
      return <Money value={money.amount} currency={money.currencyCode} />;
    }
  }
}

function DeviationRow({
  deviation,
  t,
}: Readonly<{ deviation: Deviation; t: T }>): React.JSX.Element {
  return (
    <tr>
      <td>{t(deviationFieldKey(deviation.field))}</td>
      <td>
        <DeviationValue deviation={deviation} side="override" />
      </td>
      <td>
        <DeviationValue deviation={deviation} side="tenant" />
      </td>
    </tr>
  );
}

function StoreOverride({
  deviations,
  label,
  actions,
}: Readonly<{
  deviations: Deviation[];
  label: StoreLabel;
  /** RT-770: the store's write controls, beside its name; none for a reader. */
  actions?: React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const captionId = useCaptionId();
  const name = (
    <h3 className="catalog-detail__store-name">
      <StoreName label={label} />
    </h3>
  );
  return (
    <div className="catalog-detail__store">
      {actions ? (
        <div className="catalog-detail__store-head">
          {name}
          {actions}
        </div>
      ) : (
        name
      )}
      {deviations.length === 0 ? (
        <p className="catalog-detail__empty">{t("catalog.detail.overrides.noValues")}</p>
      ) : (
        <DataTableScroll captionId={captionId}>
          <table className="data-table catalog-readonly">
            <caption id={captionId} className="data-table__caption">
              {t("catalog.detail.overrides.caption", { store: label.name ?? label.id })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("catalog.detail.overrides.col.setting")}</th>
                <th scope="col">{t("catalog.detail.overrides.col.store")}</th>
                <th scope="col">{t("catalog.detail.overrides.col.tenant")}</th>
              </tr>
            </thead>
            <tbody>
              {deviations.map((deviation) => (
                <DeviationRow key={deviation.field} deviation={deviation} t={t} />
              ))}
            </tbody>
          </table>
        </DataTableScroll>
      )}
    </div>
  );
}

export function StoreOverrides({
  product,
  storeLabel,
  storeActions,
  children,
}: Readonly<{
  product: CatalogProductDetail;
  storeLabel: (id: string) => StoreLabel;
  /** RT-770: the write controls of one store's override, for a role that may write. */
  storeActions?: (storeId: string, label: StoreLabel) => React.ReactNode;
  /** RT-770: the outcome of the last write and the control to add a store's values. */
  children?: React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const stores = storeDeviations(product.storeOverrides, product.summary);
  return (
    <Section id="catalog-detail-overrides" title={t("catalog.detail.overrides.title")}>
      <p className="catalog-detail__note">{t("catalog.detail.overrides.sub")}</p>
      {children}
      {stores.length === 0 ? (
        <p className="catalog-detail__empty">{t("catalog.detail.overrides.empty")}</p>
      ) : (
        stores.map((store) => {
          const label = storeLabel(store.storeId);
          return (
            <StoreOverride
              key={store.storeId}
              deviations={store.deviations}
              label={label}
              actions={storeActions?.(store.storeId, label)}
            />
          );
        })
      )}
    </Section>
  );
}
