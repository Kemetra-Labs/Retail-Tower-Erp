import { NoAccess } from "@/auth/NoAccess";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { DataTableSkeleton } from "@/components/DataTableSkeleton";
import { DetailPanel } from "@/components/DetailPanel";
/**
 * RT-728 — one store's inventory: its stock locations (`listStockLocations`,
 * primary first) and its movement ledger (`listStockMovements` with
 * `scope=all`: every movement of the store, newest first, keyset paged with a
 * deliberate Load more; a failed continuation keeps the loaded rows).
 *
 * A movement with a product links to that product's on-hand at this store; an
 * ad-hoc (null-product) movement has no link. There is no free-text product
 * entry. Quantities are the API's exact strings. Read-only: no movement,
 * transfer or count is written from here. ERPNext book stock is not shown (it
 * stays on the stock-discrepancy view). A store outside the caller's scope is
 * the API's non-disclosing 404 and reads as not available.
 *
 * RT-1016 (v4.0 «Ink & Receipt»): the header is the Ink band, its facts the
 * served locations list (a full, unpaged read): how many and how many are
 * active, and none until that read answers. The two sections are numbered
 * panels with strip tables; the posting state is a text pill. Nothing the
 * ledger does changes: rows, then the stale error, then Load older (a failed
 * continuation keeps the rows).
 */
import { type BandFacts, ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { DateTime, type T, formatNumber, useT } from "@/i18n";
import type { StockLocation, StockMovement } from "@/lib/inventory-queries";
import { ScopeMismatchBanner } from "@/shell/ScopeMismatchBanner";
import { useSignOut } from "@/shell/useSignOut";
import { useStoreList } from "@/stores/useStoreQueries";
import { Link, useParams } from "react-router";
import {
  canReadInventory,
  integrationStateKey,
  integrationTone,
  inventoryStatusKey,
  isUuid,
  locationKindKey,
  locationLabel,
  movementProductId,
  movementTypeKey,
} from "./inventoryLogic";
import { BackLink, LoadMore, Machine, Quantity, ReadError, StaleError, Unknown } from "./parts";
import {
  type InventoryError,
  type InventoryScope,
  type PagedState,
  type ReadState,
  useInventoryScope,
  useStockLocations,
  useStoreMovements,
} from "./useInventory";
import "../shell/surface.css";
import "./inventory.css";

type LocationsState = ReadState<{ items: StockLocation[] }>;

// --- Locations ------------------------------------------------------------------

function LocationsTable({ items }: Readonly<{ items: StockLocation[] }>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips">
          <caption id={captionId} className="data-table__caption">
            {t("inventory.locations.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("inventory.locations.col.name")}</th>
              <th scope="col">{t("inventory.locations.col.code")}</th>
              <th scope="col">{t("inventory.locations.col.kind")}</th>
              <th scope="col">{t("inventory.locations.col.active")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((loc) => (
              <tr key={loc.id} className="data-table__row data-table__row--static">
                <th scope="row">
                  <bdi dir="auto">{loc.name}</bdi>
                </th>
                <td>
                  <Machine value={loc.code} />
                </td>
                <td>{t(locationKindKey(loc.kind))}</td>
                <td>
                  <span className={loc.isActive ? "badge badge--success" : "badge badge--warning"}>
                    {t(
                      loc.isActive ? "inventory.locations.active" : "inventory.locations.inactive",
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

/** Anything under a panel header that is not a table: a state, a banner, a note. */
function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body">{children}</div>;
}

/** A re-read failure keeps the rows above it; the notice sits inside the panel. */
function StaleBody({
  error,
  onRetry,
}: Readonly<{ error: InventoryError | undefined; onRetry: () => void }>): React.JSX.Element | null {
  if (!error) return null;
  return (
    <Body>
      <StaleError error={error} onRetry={onRetry} />
    </Body>
  );
}

function LocationsSection({ locations }: Readonly<{ locations: LocationsState }>) {
  const t = useT();
  let body: React.JSX.Element;
  if (locations.isLoading) {
    body = (
      <Body>
        <ListState state="loading" label={t("inventory.locations.loadingNoun")} />
      </Body>
    );
  } else if (locations.error) {
    body = (
      <Body>
        <ReadError
          error={locations.error}
          failedKey="inventory.locations.loadFailed"
          notFoundKey="inventory.store.notFound"
          onRetry={locations.retry}
        />
      </Body>
    );
  } else if (!locations.data || locations.data.items.length === 0) {
    body = (
      <Body>
        <ListState state="empty" emptyMessage={t("inventory.locations.empty")} />
      </Body>
    );
  } else {
    body = (
      <>
        <LocationsTable items={locations.data.items} />
        <StaleBody error={locations.inlineError} onRetry={locations.retry} />
      </>
    );
  }
  return (
    <DetailPanel id="inventory-locations" index={1} title={t("inventory.locations.title")}>
      {body}
    </DetailPanel>
  );
}

// --- Movement ledger -------------------------------------------------------------

function columns(t: T): { key: string; header: string }[] {
  return [
    { key: "occurredAt", header: t("inventory.movements.col.occurredAt") },
    { key: "type", header: t("inventory.movements.col.type") },
    { key: "product", header: t("inventory.movements.col.product") },
    { key: "quantity", header: t("inventory.movements.col.quantity") },
    { key: "position", header: t("inventory.movements.col.position") },
    { key: "reason", header: t("inventory.movements.col.reason") },
    { key: "erp", header: t("inventory.movements.col.erp") },
  ];
}

function ProductCell({
  storeId,
  movement,
}: Readonly<{ storeId: string; movement: StockMovement }>) {
  const t = useT();
  const productId = movementProductId(movement);
  if (!productId) return <span className="muted">{t("inventory.movements.adhoc")}</span>;
  return (
    <Link
      to={`/inventory/stores/${storeId}/products/${productId}`}
      aria-label={t("inventory.movements.openProduct", { ref: productId })}
    >
      <Machine value={productId} />
    </Link>
  );
}

function MovementRow({
  storeId,
  movement,
  locations,
}: Readonly<{
  storeId: string;
  movement: StockMovement;
  locations: StockLocation[] | undefined;
}>): React.JSX.Element {
  const t = useT();
  const location = locationLabel(locations, movement.stockLocationId);
  return (
    <tr className="data-table__row data-table__row--static">
      <td>
        <DateTime value={movement.occurredAt} />
      </td>
      <td>{t(movementTypeKey(movement.movementType))}</td>
      <td>
        <ProductCell storeId={storeId} movement={movement} />
      </td>
      <td className="num" data-testid="movement-quantity">
        <Quantity value={movement.quantity} /> <Machine value={movement.stockingUnit} />
      </td>
      <td>
        {location ? <bdi dir="auto">{location}</bdi> : <Unknown />}
        {" · "}
        {t(inventoryStatusKey(movement.inventoryStatus))}
      </td>
      <td className="inventory__wrap">
        {movement.reason ? (
          <bdi dir="auto">{movement.reason}</bdi>
        ) : (
          <span className="muted">{t("inventory.value.none")}</span>
        )}
      </td>
      <td>
        <span className={`badge ${integrationTone(movement.integrationState)}`.trim()}>
          {t(integrationStateKey(movement.integrationState))}
        </span>
      </td>
    </tr>
  );
}

function MovementsBody({
  storeId,
  movements,
  locations,
}: Readonly<{
  storeId: string;
  movements: PagedState<StockMovement>;
  locations: StockLocation[] | undefined;
}>): React.JSX.Element {
  const t = useT();
  const cols = columns(t);
  const caption = t("inventory.movements.caption");
  if (movements.isLoading) {
    return (
      <DataTableSkeleton
        caption={caption}
        columns={cols}
        label={t("inventory.movements.loadingNoun")}
      />
    );
  }
  if (movements.error) {
    return (
      <Body>
        <ReadError
          error={movements.error}
          failedKey="inventory.movements.loadFailed"
          notFoundKey="inventory.store.notFound"
          onRetry={movements.retry}
        />
      </Body>
    );
  }
  if (movements.rows.length === 0 && !movements.hasMore) {
    return (
      <Body>
        <ListState state="empty" emptyMessage={t("inventory.movements.empty")} />
      </Body>
    );
  }
  return (
    <>
      <TableScrollRegion>
        {(captionId) => (
          <table className="data-table data-table--strips">
            <caption id={captionId} className="data-table__caption">
              {caption}
            </caption>
            <thead>
              <tr>
                {cols.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    className={col.key === "quantity" ? "num" : undefined}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {movements.rows.map((m) => (
                <MovementRow key={m.id} storeId={storeId} movement={m} locations={locations} />
              ))}
            </tbody>
          </table>
        )}
      </TableScrollRegion>
      {/* A failed continuation keeps the rows above and retries at the boundary. */}
      <StaleBody error={movements.inlineError} onRetry={movements.retry} />
      <LoadMore
        hasMore={movements.hasMore}
        isFetching={movements.isFetchingNextPage}
        label={t("inventory.movements.loadMore")}
        onLoadMore={movements.loadMore}
      />
    </>
  );
}

// --- Page ------------------------------------------------------------------------

function useStoreName(tenantId: string | null, storeId: string): string | undefined {
  const { result } = useStoreList(tenantId);
  return result?.kind === "rows" ? result.rows.find((s) => s.id === storeId)?.name : undefined;
}

/** The served locations list, as the band's two facts; none until it answers. */
function useBandFacts(locations: LocationsState): BandFacts | undefined {
  const t = useT();
  if (!locations.data) return undefined;
  const items = locations.data.items;
  return [
    { label: t("inventory.band.locations"), value: formatNumber(items.length) },
    {
      label: t("inventory.band.activeLocations"),
      value: formatNumber(items.filter((l) => l.isActive).length),
    },
  ];
}

function StoreView({
  scope,
  storeId,
}: Readonly<{ scope: InventoryScope; storeId: string }>): React.JSX.Element {
  const t = useT();
  const name = useStoreName(scope.tenantId, storeId);
  const locations = useStockLocations({ scope, storeId });
  const movements = useStoreMovements({ scope, storeId });
  const facts = useBandFacts(locations);
  return (
    <div className="surface inventory--v4">
      <BackLink to="/inventory" label={t("inventory.store.back")} />
      <ListHeaderBand
        group={t("shell.nav.section.operations")}
        title={name ? <bdi dir="auto">{name}</bdi> : t("inventory.store.title")}
        subtitle={t("inventory.store.sub")}
        facts={facts ? { label: t("inventory.band.store.label"), items: facts } : undefined}
      />
      {/* A deep link to another store's view never switches scope (RT-268); the
          notice sits under the band, which never carries state. */}
      <ScopeMismatchBanner storeId={storeId} />
      <div className="inventory__strip">
        <p className="inventory__note">{t("inventory.note.readOnly")}</p>
        <p className="inventory__note">{t("inventory.note.erpBook")}</p>
      </div>
      <LocationsSection locations={locations} />
      <DetailPanel id="inventory-movements" index={2} title={t("inventory.movements.title")}>
        <Body>
          <p className="content__sub">{t("inventory.movements.sub")}</p>
        </Body>
        <MovementsBody storeId={storeId} movements={movements} locations={locations.data?.items} />
      </DetailPanel>
    </div>
  );
}

function NotAvailable(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <BackLink to="/inventory" label={t("inventory.store.back")} />
      <ReadError
        error={{ kind: "not-found" }}
        failedKey="inventory.movements.loadFailed"
        notFoundKey="inventory.store.notFound"
        onRetry={() => undefined}
      />
    </div>
  );
}

export function InventoryStore(): React.JSX.Element {
  const t = useT();
  const { storeId } = useParams();
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
  return (
    // A malformed route id would be a contract 400: it is never sent.
    isUuid(storeId) ? (
      <StoreView scope={scope} storeId={storeId} />
    ) : (
      <>
        <ScopeMismatchBanner storeId={storeId} />
        <NotAvailable />
      </>
    )
  );
}
