import { NoAccess } from "@/auth/NoAccess";
import { Banner } from "@/components/Banner";
/**
 * RT-728 — one product's on-hand at one store (`getOnHand`), reached from a
 * movement row of the store's ledger; there is no free-text product entry.
 * Shows the derived physical on-hand, its sellable share and the split by
 * inventory status, exactly as the API's strings, with the API's negative
 * flag. A failed read is Unknown, never zero. This is Retail Tower's derived
 * on-hand, not ERPNext book stock: ERP Book is labelled separately and only
 * links to the store's ERPNext snapshot view (RT-436: no typed per-product
 * read of it exists in Backend-Core, so no number is shown).
 *
 * RT-436 adds the status-disposition action (StatusMoveSection) for the roles
 * `createStatusMove` accepts.
 *
 * Tracking identities (`listTrackingIdentities`) are requested only for owner /
 * tenant_admin, the API's roles; a 403 / 404 omits the section. Read-only.
 *
 * RT-1016 (v4.0 «Ink & Receipt»): the header is the Ink band, its two facts the
 * served physical and sellable on-hand (`getOnHand`), and none while that read
 * is loading or has failed: an unknown balance is never drawn as a number, and
 * the band never changes colour for a negative one (the warning is a banner in
 * the on-hand panel). The panels are numbered only when more than one renders
 * for the role (on-hand, then the status move, then tracking).
 */
import { TableScrollRegion } from "@/components/DataTableScroll";
import { DetailPanel } from "@/components/DetailPanel";
import { type BandFacts, ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type { OnHand, TrackingIdentity } from "@/lib/inventory-queries";
import { ScopeMismatchBanner } from "@/shell/ScopeMismatchBanner";
import { useSignOut } from "@/shell/useSignOut";
import { canReadStockDiscrepancies } from "@/stock-discrepancies/stockDiscrepancyLogic";
import { Link, useParams } from "react-router";
import { StatusMoveSection } from "./StatusMoveSection";
import {
  canReadInventory,
  canReadTracking,
  inventoryStatusKey,
  isHiddenSection,
  isUuid,
  trackingKindKey,
} from "./inventoryLogic";
import { BackLink, LoadMore, Machine, Quantity, ReadError, StaleError, Unknown } from "./parts";
import { canMoveStock } from "./statusMoveLogic";
import {
  type InventoryScope,
  type PagedState,
  type ProductTarget,
  type ReadState,
  useInventoryScope,
  useOnHand,
  useTrackingIdentities,
} from "./useInventory";
import "../shell/surface.css";
import "./inventory.css";

interface Target {
  storeId: string;
  productId: string;
}

// --- On-hand ---------------------------------------------------------------------

/** Anything under a panel header that is not a table: a state, a banner, a note. */
function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body">{children}</div>;
}

function Unit({ unit }: Readonly<{ unit: string | null | undefined }>): React.JSX.Element {
  return unit ? <Machine value={unit} /> : <Unknown />;
}

/**
 * ERP Book is ERPNext's own recorded quantity. Backend-Core exposes no typed
 * per-product read of it (only the store's negative-quantity list and untyped
 * reconciliation detail), so no number is shown here: the label points to the
 * store's ERPNext snapshot view, which is the existing surface for it.
 */
function ErpBookEntry({
  storeId,
  role,
}: Readonly<{ storeId: string; role: string | null }>): React.JSX.Element {
  const t = useT();
  return (
    <div>
      <dt>{t("inventory.onHand.erpBook")}</dt>
      <dd data-testid="on-hand-erp-book" className="inventory__erp-book">
        {canReadStockDiscrepancies(role) ? (
          <Link to={`/stock-discrepancies/${storeId}`}>{t("inventory.onHand.erpBookLink")}</Link>
        ) : (
          t("inventory.onHand.erpBookNone")
        )}
      </dd>
    </div>
  );
}

function OnHandFigures({
  onHand,
  storeId,
  role,
}: Readonly<{ onHand: OnHand; storeId: string; role: string | null }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      {onHand.negativeBalance ? (
        <Body>
          <Banner variant="warning" message={t("inventory.onHand.negative")} />
        </Body>
      ) : null}
      <TableScrollRegion>
        {(captionId) => (
          <table className="data-table data-table--strips">
            <caption id={captionId} className="data-table__caption">
              {t("inventory.onHand.byStatus")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("inventory.onHand.col.status")}</th>
                <th scope="col" className="num">
                  {t("inventory.onHand.col.quantity")}
                </th>
              </tr>
            </thead>
            <tbody>
              {onHand.statusQuantities.map((row) => (
                <tr key={row.inventoryStatus} className="data-table__row data-table__row--static">
                  <th scope="row">{t(inventoryStatusKey(row.inventoryStatus))}</th>
                  <td className="num">
                    <Quantity value={row.quantity} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableScrollRegion>
      <Body>
        <p className="inventory__note">{t("inventory.onHand.note")}</p>
        <dl className="inventory__figures">
          <ErpBookEntry storeId={storeId} role={role} />
        </dl>
        <p className="inventory__note">{t("inventory.onHand.erpBookNote")}</p>
      </Body>
    </>
  );
}

function OnHandSection({
  onHand,
  storeId,
  role,
  index,
}: Readonly<{
  onHand: ReadState<OnHand>;
  storeId: string;
  role: string | null;
  index: number | undefined;
}>): React.JSX.Element {
  const t = useT();
  let body: React.JSX.Element;
  if (onHand.isLoading) {
    body = (
      <Body>
        <ListState state="loading" label={t("inventory.onHand.loadingNoun")} />
      </Body>
    );
  } else if (onHand.data) {
    body = (
      <>
        <OnHandFigures onHand={onHand.data} storeId={storeId} role={role} />
        {onHand.inlineError ? (
          <Body>
            <StaleError error={onHand.inlineError} onRetry={onHand.retry} />
          </Body>
        ) : null}
      </>
    );
  } else {
    body = (
      <Body>
        {/* No answer: the quantity is Unknown, never shown as zero. */}
        <p data-testid="on-hand-quantity">
          {t("inventory.onHand.physical")}: <Unknown />
        </p>
        {onHand.error ? (
          <ReadError
            error={onHand.error}
            failedKey="inventory.onHand.loadFailed"
            notFoundKey="inventory.product.notFound"
            onRetry={onHand.retry}
          />
        ) : null}
      </Body>
    );
  }
  return (
    <DetailPanel id="inventory-on-hand" index={index} title={t("inventory.onHand.title")}>
      {body}
    </DetailPanel>
  );
}

// --- Tracking identities ------------------------------------------------------------

function TrackingTable({ items }: Readonly<{ items: TrackingIdentity[] }>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips">
          <caption id={captionId} className="data-table__caption">
            {t("inventory.tracking.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("inventory.tracking.col.kind")}</th>
              <th scope="col">{t("inventory.tracking.col.code")}</th>
              <th scope="col">{t("inventory.tracking.col.expiry")}</th>
              <th scope="col">{t("inventory.tracking.col.manufactured")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((id) => (
              <tr key={id.id} className="data-table__row data-table__row--static">
                <td>{t(trackingKindKey(id.kind))}</td>
                <th scope="row">
                  <Machine value={id.code} />
                </th>
                <td>
                  {id.expiryDate ? <Machine value={id.expiryDate} /> : t("inventory.value.none")}
                </td>
                <td>
                  {id.manufacturedOn ? (
                    <Machine value={id.manufacturedOn} />
                  ) : (
                    t("inventory.value.none")
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

function TrackingBody({ list }: Readonly<{ list: PagedState<TrackingIdentity> }>) {
  const t = useT();
  if (list.isLoading) {
    return (
      <Body>
        <ListState state="loading" label={t("inventory.tracking.loadingNoun")} />
      </Body>
    );
  }
  if (list.error) {
    return (
      <Body>
        <ReadError
          error={list.error}
          failedKey="inventory.tracking.loadFailed"
          notFoundKey="inventory.product.notFound"
          onRetry={list.retry}
        />
      </Body>
    );
  }
  if (list.rows.length === 0 && !list.hasMore) {
    return (
      <Body>
        <ListState state="empty" emptyMessage={t("inventory.tracking.empty")} />
      </Body>
    );
  }
  return (
    <>
      <TrackingTable items={list.rows} />
      {list.inlineError ? (
        <Body>
          <StaleError error={list.inlineError} onRetry={list.retry} />
        </Body>
      ) : null}
      <LoadMore
        hasMore={list.hasMore}
        isFetching={list.isFetchingNextPage}
        label={t("inventory.tracking.loadMore")}
        onLoadMore={list.loadMore}
      />
    </>
  );
}

function TrackingSection({
  target,
  index,
}: Readonly<{ target: ProductTarget; index: number | undefined }>) {
  const t = useT();
  const list = useTrackingIdentities(target);
  // The API's refusal (403 / non-disclosing 404) means: not for this caller. Omit.
  if (list.error && isHiddenSection(list.error.kind)) return null;
  return (
    <DetailPanel id="inventory-tracking" index={index} title={t("inventory.tracking.title")}>
      <TrackingBody list={list} />
    </DetailPanel>
  );
}

// --- Page ------------------------------------------------------------------------

/**
 * The served physical and sellable on-hand, as the band's facts; none until it
 * answers, and none while a re-read has failed (the panel keeps its figures and
 * says so, so the band never shows a number the page itself calls stale).
 */
function useBandFacts(onHand: ReadState<OnHand>): BandFacts | undefined {
  const t = useT();
  const data = onHand.data;
  if (!data || onHand.inlineError) return undefined;
  return [
    {
      label: t("inventory.onHand.physical"),
      value: (
        <span data-testid="on-hand-quantity">
          <Quantity value={data.quantity} /> <Unit unit={data.stockingUnit} />
        </span>
      ),
    },
    {
      label: t("inventory.onHand.sellable"),
      value: (
        <span data-testid="on-hand-sellable">
          <Quantity value={data.sellableQuantity} /> <Unit unit={data.stockingUnit} />
        </span>
      ),
    },
  ];
}

function ProductView({
  scope,
  target,
}: Readonly<{ scope: InventoryScope; target: Target }>): React.JSX.Element {
  const t = useT();
  const onHand = useOnHand({ scope, ...target });
  const facts = useBandFacts(onHand);
  // Panels are numbered by what renders for this role; a lone panel carries no badge.
  const moves = canMoveStock(scope.role);
  const tracking = canReadTracking(scope.role);
  const numbered = moves || tracking;
  const trackingIndex = moves ? 3 : 2;
  return (
    <div className="surface inventory--v4">
      <BackLink to={`/inventory/stores/${target.storeId}`} label={t("inventory.product.back")} />
      <ListHeaderBand
        group={t("shell.nav.section.operations")}
        title={t("inventory.product.title")}
        subtitle={t.rich("inventory.product.sub", { ref: <Machine value={target.productId} /> })}
        facts={facts ? { label: t("inventory.band.onHand.label"), items: facts } : undefined}
      />
      {/* A deep link to another store's view never switches scope (RT-268); the
          notice sits under the band, which never carries state. */}
      <ScopeMismatchBanner storeId={target.storeId} />
      <OnHandSection
        onHand={onHand}
        storeId={target.storeId}
        role={scope.role}
        index={numbered ? 1 : undefined}
      />
      {moves ? (
        <StatusMoveSection
          scope={scope}
          storeId={target.storeId}
          productId={target.productId}
          onHand={onHand}
          index={2}
        />
      ) : null}
      {tracking ? <TrackingSection target={{ scope, ...target }} index={trackingIndex} /> : null}
    </div>
  );
}

function NotAvailable({ storeId }: Readonly<{ storeId: string | undefined }>): React.JSX.Element {
  const t = useT();
  const back = isUuid(storeId) ? `/inventory/stores/${storeId}` : "/inventory";
  return (
    <div className="surface">
      <BackLink to={back} label={t("inventory.product.back")} />
      <Banner variant="warning" message={t("inventory.product.notFound")} />
    </div>
  );
}

export function InventoryProduct(): React.JSX.Element {
  const t = useT();
  const { storeId, productId } = useParams();
  const scope = useInventoryScope();
  const signOut = useSignOut();
  if (!canReadInventory(scope.role)) return <NoAccess onSignOut={signOut} />;
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("inventory.scopePrompt")}</p>
      </div>
    );
  }
  if (isUuid(storeId) && isUuid(productId)) {
    return <ProductView scope={scope} target={{ storeId, productId }} />;
  }
  // A deep link to another store's view never switches scope (RT-268).
  return (
    <>
      <ScopeMismatchBanner storeId={storeId} />
      <NotAvailable storeId={storeId} />
    </>
  );
}
