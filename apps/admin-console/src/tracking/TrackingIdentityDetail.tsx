import { useStoreLabels } from "@/catalog/useCatalogProduct";
/**
 * RT-455 — one batch or serial (board `Inventory-item*.dc.html`, RT-972 notes
 * §4), owner / tenant_admin only. Any other role, and an identity of another
 * tenant, reads «هذه الدفعة غير متاحة.» without saying why (the reads answer
 * a non-disclosing 404, so the page asks nothing for another role).
 *
 * Sections, each its own read and its own state:
 *   01 the identity (`getTrackingIdentity`, II-5);
 *   02 its holds, active first, then the history (`listTrackingHolds` by
 *      identity, II-3);
 *   03 its stock per store × unit × status (`getTrackingIdentityPositions`,
 *      II-2), summed over the store's locations (OD-6: +5 at one location and
 *      −5 at another read as 0); quantities as sent, never summed here;
 *   04 its expiry corrections (`listTrackingIdentityExpiryCorrections`, II-4).
 *
 * Commands (owner approval, RT-455 comment 15245): section 02 places a quality
 * hold, or opens the active one's drawer for the release; section 04 corrects
 * the expiry date. Each answers 404 until RT-453 writes identities, and the
 * page says so instead of showing a success.
 *
 * Reached from a hold row or a product's batch table; `?store=` names the
 * store page it came from, for the back link.
 */
import { Banner } from "@/components/Banner";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { DetailPanel } from "@/components/DetailPanel";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import type { TrackingIdentity } from "@/lib/inventory-queries";
import type {
  ExpiryCorrection,
  TrackingHold,
  TrackingIdentityPositions,
} from "@/lib/tracking-queries";
import { TrackingPagesGate } from "@/tracked-selling/TrackingPagesGate";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { inventoryStatusKey, isUuid, trackingKindKey } from "../inventory/inventoryLogic";
import { BackLink, LoadMore, Machine, Quantity, ReadError, StaleError } from "../inventory/parts";
import {
  type InventoryScope,
  type PagedState,
  type ReadState,
  useInventoryScope,
} from "../inventory/useInventory";
import { HoldDrawer } from "./TrackingDrawers";
import { ExpiryForm, PlaceHoldDrawer } from "./TrackingForms";
import {
  ActorName,
  DateValue,
  HoldKindBadge,
  ProductName,
  ReasonLabel,
  StoreName,
  TrackingNamesProvider,
  When,
} from "./parts";
import { activeHolds, canReadHolds, canReleaseHold, holdKindKey } from "./trackingLogic";
import {
  useExpiryCorrections,
  useIdentityPositions,
  useMemberNames,
  useTrackingHolds,
  useTrackingIdentity,
} from "./useTracking";
import "../shell/surface.css";
import "../inventory/inventory.css";
import "./tracking.css";

const STATUS_ORDER = [
  "sellable",
  "return_inspection",
  "quality_hold",
  "damaged",
  "expired",
  "recall_hold",
] as const;

function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body">{children}</div>;
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// --- 01 Identity ------------------------------------------------------------------

function IdentitySection({
  identity,
}: Readonly<{ identity: TrackingIdentity }>): React.JSX.Element {
  const t = useT();
  return (
    <DetailPanel id="tracking-identity-data" index={1} title={t("tracking.identity.data")}>
      <Body>
        <dl className="tracking__fields" data-testid="tracking-identity-fields">
          <Field label={t("tracking.col.kind")}>{t(trackingKindKey(identity.kind))}</Field>
          <Field label={t("tracking.col.code")}>
            <Machine value={identity.code} />
          </Field>
          <Field label={t("tracking.col.expiry")}>
            <DateValue value={identity.expiryDate} />
          </Field>
          <Field label={t("tracking.col.manufactured")}>
            <DateValue value={identity.manufacturedOn} />
          </Field>
          <Field label={t("tracking.col.origin")}>{t("tracking.identity.originErp")}</Field>
        </dl>
      </Body>
    </DetailPanel>
  );
}

// --- 02 Holds ---------------------------------------------------------------------

function ActiveHoldLines({ holds }: Readonly<{ holds: readonly TrackingHold[] }>) {
  const t = useT();
  const active = activeHolds(holds);
  if (active.length === 0) {
    return <p data-testid="tracking-identity-no-hold">{t("tracking.identity.noActiveHold")}</p>;
  }
  return (
    <ul className="tracking__active-holds" data-testid="tracking-identity-active-holds">
      {active.map((hold) => (
        <li key={hold.id}>
          <HoldKindBadge kind={hold.kind} />{" "}
          {t("tracking.identity.heldSince", { kind: t(holdKindKey(hold.kind)) })}{" "}
          <When iso={hold.placedAt} />
        </li>
      ))}
    </ul>
  );
}

function HoldHistoryTable({ rows }: Readonly<{ rows: readonly TrackingHold[] }>) {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips" data-testid="tracking-identity-holds">
          <caption id={captionId} className="data-table__caption">
            {t("tracking.identity.holdsCaption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("tracking.col.kind")}</th>
              <th scope="col">{t("tracking.col.status")}</th>
              <th scope="col">{t("tracking.col.reason")}</th>
              <th scope="col">{t("tracking.col.placedAt")}</th>
              <th scope="col">{t("tracking.col.placedBy")}</th>
              <th scope="col">{t("tracking.col.releasedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((hold) => (
              <tr key={hold.id} className="data-table__row data-table__row--static">
                <th scope="row">{t(holdKindKey(hold.kind))}</th>
                <td>{t(hold.active ? "tracking.hold.active" : "tracking.hold.released")}</td>
                <td>
                  <ReasonLabel code={hold.reasonCode} />
                </td>
                <td>
                  <When iso={hold.placedAt} />
                </td>
                <td>
                  <ActorName userId={hold.placedBy} />
                </td>
                <td>{hold.releasedAt ? <When iso={hold.releasedAt} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

/** Loading, first-page failure or empty for a paged section; null once there are rows. */
function PagedBody<T>({
  list,
  noun,
  failedKey,
  emptyKey,
}: Readonly<{
  list: PagedState<T>;
  noun: string;
  failedKey: "tracking.identity.holdsFailed" | "tracking.identity.correctionsFailed";
  emptyKey: "tracking.identity.holdsEmpty" | "tracking.identity.correctionsEmpty";
}>): React.JSX.Element | null {
  const t = useT();
  if (list.isLoading) return <ListState state="loading" label={noun} />;
  if (list.error) {
    return (
      <ReadError
        error={list.error}
        failedKey={failedKey}
        notFoundKey={failedKey}
        onRetry={list.retry}
      />
    );
  }
  if (list.rows.length === 0 && !list.hasMore) {
    return <ListState state="empty" emptyMessage={t(emptyKey)} />;
  }
  return null;
}

/**
 * The primary action of the holds section: «وضع حجز جودة» while no quality
 * hold is active; with one, the hold's drawer, where the owner releases it (a
 * tenant_admin sees the release recessed, with the reason).
 */
function HoldAction({
  scope,
  identity,
  holds,
}: Readonly<{
  scope: InventoryScope;
  identity: TrackingIdentity;
  holds: readonly TrackingHold[];
}>) {
  const t = useT();
  const [placing, setPlacing] = useState(false);
  const [openHold, setOpenHold] = useState<string | null>(null);
  const quality = holds.find((hold) => hold.active && hold.kind === "quality_hold");
  const owner = canReleaseHold(scope.role);
  return (
    <div className="tracking__actions">
      {quality ? (
        <button
          type="button"
          className={owner ? "btn-danger-quiet" : "btn-secondary"}
          onClick={() => setOpenHold(quality.id)}
        >
          {owner ? t("tracking.release.submit") : t("tracking.identity.viewHold")}
        </button>
      ) : (
        <button type="button" className="btn-primary" onClick={() => setPlacing(true)}>
          {t("tracking.placeHold.open")}
        </button>
      )}
      {placing ? (
        <PlaceHoldDrawer
          identityId={identity.id}
          code={identity.code}
          onClose={() => setPlacing(false)}
        />
      ) : null}
      {openHold ? (
        <HoldDrawer
          scope={scope}
          holdId={openHold}
          code={identity.code}
          onClose={() => setOpenHold(null)}
        />
      ) : null}
    </div>
  );
}

function HoldsSection({
  scope,
  identity,
}: Readonly<{ scope: InventoryScope; identity: TrackingIdentity }>) {
  const t = useT();
  const identityId = identity.id;
  const list = useTrackingHolds(scope, "all", identityId);
  // The hold state and the action come from their own read of the ACTIVE holds
  // (at most one per kind, so one page), never from page 1 of the history.
  const active = useTrackingHolds(scope, "active", identityId);
  const status = (
    <PagedBody
      list={list}
      noun={t("tracking.identity.holdsNoun")}
      failedKey="tracking.identity.holdsFailed"
      emptyKey="tracking.identity.holdsEmpty"
    />
  );
  const ready = !list.isLoading && !list.error;
  // A failed refresh keeps the last page on screen (inlineError): the hold state
  // is then uncertain, so neither the hold lines nor the action are shown.
  const activeReady = !active.isLoading && !active.error && !active.inlineError && !active.hasMore;
  return (
    <DetailPanel id="tracking-identity-holds" index={2} title={t("tracking.identity.holds")}>
      <Body>
        {activeReady ? <ActiveHoldLines holds={active.rows} /> : null}
        {/* An unknown hold state offers no action: placing one could only be refused. */}
        {activeReady ? <HoldAction scope={scope} identity={identity} holds={active.rows} /> : null}
        {active.error ? (
          <ReadError
            error={active.error}
            failedKey="tracking.identity.holdsFailed"
            notFoundKey="tracking.identity.holdsFailed"
            onRetry={active.retry}
          />
        ) : null}
        {active.inlineError ? (
          <ReadError
            error={active.inlineError}
            failedKey="tracking.identity.holdsFailed"
            notFoundKey="tracking.identity.holdsFailed"
            onRetry={active.retry}
          />
        ) : null}
        {status}
      </Body>
      {ready && list.rows.length > 0 ? <HoldHistoryTable rows={list.rows} /> : null}
      {list.inlineError ? (
        <Body>
          <StaleError error={list.inlineError} onRetry={list.retry} />
        </Body>
      ) : null}
      <LoadMore
        hasMore={list.hasMore}
        isFetching={list.isFetchingNextPage}
        label={t("tracking.identity.holdsMore")}
        onLoadMore={list.loadMore}
      />
    </DetailPanel>
  );
}

// --- 03 Positions -----------------------------------------------------------------

function PositionsTable({ data }: Readonly<{ data: TrackingIdentityPositions }>) {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips" data-testid="tracking-identity-positions">
          <caption id={captionId} className="data-table__caption">
            {t("tracking.positions.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("tracking.col.store")}</th>
              <th scope="col">{t("tracking.col.unit")}</th>
              <th scope="col" className="num">
                {t("tracking.positions.total")}
              </th>
              {STATUS_ORDER.map((status) => (
                <th key={status} scope="col" className="num">
                  {t(inventoryStatusKey(status))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.stores.map((row) => (
              <tr
                key={`${row.storeId}:${row.stockingUnit}`}
                className="data-table__row data-table__row--static"
              >
                <th scope="row">
                  <StoreName id={row.storeId} />
                </th>
                <td>
                  <Machine value={row.stockingUnit} />
                </td>
                <td className="num">
                  <Quantity value={row.quantity} />
                </td>
                {STATUS_ORDER.map((status) => {
                  const cell = row.statusQuantities.find((q) => q.inventoryStatus === status);
                  return (
                    <td key={status} className="num">
                      {cell ? (
                        <Quantity value={cell.quantity} />
                      ) : (
                        <span className="inventory__unknown">{t("inventory.value.unknown")}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

function PositionsSection({
  positions,
}: Readonly<{ positions: ReadState<TrackingIdentityPositions> }>) {
  const t = useT();
  let body: React.ReactNode;
  if (positions.isLoading) {
    body = (
      <Body>
        <ListState state="loading" label={t("tracking.positions.loadingNoun")} />
      </Body>
    );
  } else if (positions.data && positions.data.stores.length === 0) {
    body = (
      <Body>
        <ListState state="empty" emptyMessage={t("tracking.positions.empty")} />
      </Body>
    );
  } else if (positions.data) {
    body = (
      <>
        <PositionsTable data={positions.data} />
        {positions.inlineError ? (
          <Body>
            <StaleError error={positions.inlineError} onRetry={positions.retry} />
          </Body>
        ) : null}
      </>
    );
  } else {
    body = (
      <Body>
        {positions.error ? (
          <ReadError
            error={positions.error}
            failedKey="tracking.positions.loadFailed"
            notFoundKey="tracking.identity.notFound"
            onRetry={positions.retry}
          />
        ) : null}
      </Body>
    );
  }
  return (
    <DetailPanel id="tracking-identity-stock" index={3} title={t("tracking.positions.title")}>
      {body}
      <Body>
        <p className="tracking__muted">{t("tracking.positions.note")}</p>
      </Body>
    </DetailPanel>
  );
}

// --- 04 Expiry corrections --------------------------------------------------------

function CorrectionsTable({ rows }: Readonly<{ rows: readonly ExpiryCorrection[] }>) {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table
          className="data-table data-table--strips"
          data-testid="tracking-identity-corrections"
        >
          <caption id={captionId} className="data-table__caption">
            {t("tracking.corrections.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("tracking.col.createdAt")}</th>
              <th scope="col">{t("tracking.corrections.old")}</th>
              <th scope="col">{t("tracking.corrections.new")}</th>
              <th scope="col">{t("tracking.col.reason")}</th>
              <th scope="col">{t("tracking.col.note")}</th>
              <th scope="col">{t("tracking.corrections.by")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="data-table__row data-table__row--static">
                <th scope="row">
                  <When iso={row.createdAt} />
                </th>
                <td>
                  <DateValue value={row.oldExpiryDate} />
                </td>
                <td>
                  <DateValue value={row.newExpiryDate} />
                </td>
                <td>
                  <ReasonLabel code={row.reasonCode} />
                </td>
                <td>{row.note ? <bdi>{row.note}</bdi> : t("tracking.value.none")}</td>
                <td>
                  <ActorName userId={row.createdBy} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

function CorrectionsSection({
  scope,
  identity,
}: Readonly<{ scope: InventoryScope; identity: TrackingIdentity }>) {
  const t = useT();
  const identityId = identity.id;
  const list = useExpiryCorrections(scope, identityId);
  const status = (
    <PagedBody
      list={list}
      noun={t("tracking.corrections.loadingNoun")}
      failedKey="tracking.identity.correctionsFailed"
      emptyKey="tracking.identity.correctionsEmpty"
    />
  );
  const ready = !list.isLoading && !list.error && list.rows.length > 0;
  return (
    <DetailPanel
      id="tracking-identity-corrections"
      index={4}
      title={t("tracking.corrections.title")}
    >
      <Body>
        <p className="tracking__muted">{t("tracking.corrections.note")}</p>
        <ExpiryForm identityId={identityId} current={identity.expiryDate} />
        <h3 className="tracking__subhead">{t("tracking.corrections.history")}</h3>
        {status}
      </Body>
      {ready ? <CorrectionsTable rows={list.rows} /> : null}
      {list.inlineError ? (
        <Body>
          <StaleError error={list.inlineError} onRetry={list.retry} />
        </Body>
      ) : null}
      <LoadMore
        hasMore={list.hasMore}
        isFetching={list.isFetchingNextPage}
        label={t("tracking.corrections.loadMore")}
        onLoadMore={list.loadMore}
      />
    </DetailPanel>
  );
}

// --- Page -------------------------------------------------------------------------

function backTo(identity: TrackingIdentity | undefined, storeId: string | null): string {
  if (identity && isUuid(storeId ?? undefined)) {
    return `/inventory/stores/${storeId}/products/${identity.productId}`;
  }
  return "/tracking";
}

function NotAvailable({ back }: Readonly<{ back: string }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface" data-testid="tracking-identity-unavailable">
      <BackLink to={back} label={t("tracking.identity.back")} />
      <Banner variant="warning" message={t("tracking.identity.notFound")} />
    </div>
  );
}

function IdentityView({
  scope,
  identityId,
  storeId,
}: Readonly<{ scope: InventoryScope; identityId: string; storeId: string | null }>) {
  const t = useT();
  const { context } = useActiveContextValue();
  const identity = useTrackingIdentity(scope, identityId);
  const positions = useIdentityPositions(scope, identityId);
  const storeName = useStoreLabels(
    scope.tenantId,
    { id: context?.active_store?.id ?? null, name: context?.active_store?.name ?? null },
    true,
  );
  const members = useMemberNames(scope.tenantId, true);
  const names = useMemo(
    () => ({ storeName: (id: string) => storeName(id).name, members }),
    [storeName, members],
  );
  const data = identity.data;
  const back = backTo(data, storeId);
  if (identity.error?.kind === "not-found") return <NotAvailable back={back} />;
  return (
    <TrackingNamesProvider value={names}>
      <div className="surface inventory--v4 tracking">
        <BackLink to={back} label={t("tracking.identity.back")} />
        <ListHeaderBand
          group={t("shell.nav.section.operations")}
          title={data ? <Machine value={data.code} /> : t("tracking.identity.titleLoading")}
          subtitle={
            data
              ? t.rich("tracking.identity.sub", {
                  kind: t(trackingKindKey(data.kind)),
                  product: <ProductName id={data.productId} />,
                })
              : undefined
          }
        />
        {identity.isLoading ? (
          <ListState state="loading" label={t("tracking.identity.loadingNoun")} />
        ) : null}
        {identity.error ? (
          <ReadError
            error={identity.error}
            failedKey="tracking.identity.loadFailed"
            notFoundKey="tracking.identity.notFound"
            onRetry={identity.retry}
          />
        ) : null}
        {data ? (
          <>
            <IdentitySection identity={data} />
            <HoldsSection scope={scope} identity={data} />
            <PositionsSection positions={positions} />
            <CorrectionsSection scope={scope} identity={data} />
          </>
        ) : null}
      </div>
    </TrackingNamesProvider>
  );
}

export function TrackingIdentityDetail(): React.JSX.Element {
  const t = useT();
  const { identityId } = useParams();
  const [search] = useSearchParams();
  const scope = useInventoryScope();
  const storeId = search.get("store");
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("inventory.scopePrompt")}</p>
      </div>
    );
  }
  // Another role gets the same answer as an unknown identity: nothing is asked.
  if (!canReadHolds(scope.role) || !isUuid(identityId)) return <NotAvailable back="/tracking" />;
  // Keyed by the identity: moving to another batch remounts the page, so no form
  // state or held Idempotency-Key carries over to the new identity's commands.
  return (
    // RT-455 part 1 (OD-T4): hidden while tracked selling is off.
    <TrackingPagesGate tenantId={scope.tenantId} role={scope.role}>
      <IdentityView key={identityId} scope={scope} identityId={identityId} storeId={storeId} />
    </TrackingPagesGate>
  );
}
