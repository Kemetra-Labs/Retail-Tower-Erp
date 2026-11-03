/**
 * RT-455 TR-3: the paged history lists, owner / tenant_admin only (any other
 * role is a 403, so they are never mounted for it): released holds
 * (`listTrackingHolds?status=released`) and past recalls
 * (`listInventoryRecalls`), newest first, Load more on `nextCursor`. A paged
 * list never shows a total (UX-10.17).
 *
 * A `TrackingHold` carries the identity's id but not its code or expiry, so a
 * released hold links to the identity detail instead of naming the code (no
 * per-row identity read: that would be a request per row).
 */
import { TableScrollRegion } from "@/components/DataTableScroll";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type { RecallSummary, TrackingHold } from "@/lib/tracking-queries";
import { Link } from "react-router";
import { LoadMore, Machine, ReadError, StaleError } from "../inventory/parts";
import type { InventoryScope, PagedState } from "../inventory/useInventory";
import { ActorName, ProductName, ReasonLabel, When } from "./parts";
import { holdKindKey } from "./trackingLogic";
import { useRecalls, useTrackingHolds } from "./useTracking";

function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body inventory__panel-body--solo">{children}</div>;
}

/** Loading, a first-page failure or the empty list; null once there are rows. */
function PagedStatus<T>({
  list,
  noun,
  failedKey,
  emptyKey,
}: Readonly<{
  list: PagedState<T>;
  noun: string;
  failedKey: "tracking.released.loadFailed" | "tracking.recalls.loadFailed";
  emptyKey: "tracking.released.empty" | "tracking.recalls.empty";
}>): React.JSX.Element | null {
  const t = useT();
  if (list.isLoading) {
    return (
      <Body>
        <ListState state="loading" label={noun} />
      </Body>
    );
  }
  if (list.error) {
    return (
      <Body>
        <ReadError
          error={list.error}
          failedKey={failedKey}
          notFoundKey={failedKey}
          onRetry={list.retry}
        />
      </Body>
    );
  }
  if (list.rows.length === 0 && !list.hasMore) {
    return (
      <Body>
        <ListState state="empty" emptyMessage={t(emptyKey)} />
      </Body>
    );
  }
  return null;
}

function Continuation<T>({
  list,
  label,
}: Readonly<{ list: PagedState<T>; label: string }>): React.JSX.Element {
  return (
    <>
      {list.inlineError ? (
        <Body>
          <StaleError error={list.inlineError} onRetry={list.retry} />
        </Body>
      ) : null}
      <LoadMore
        hasMore={list.hasMore}
        isFetching={list.isFetchingNextPage}
        label={label}
        onLoadMore={list.loadMore}
      />
    </>
  );
}

/** A hold's identity: the detail link (the hold carries no code). */
export function IdentityLink({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const t = useT();
  return (
    <Link to={`/tracking/identities/${id}`} aria-label={t("tracking.identity.openLabel", { id })}>
      {t("tracking.identity.open")}
    </Link>
  );
}

// --- Released holds ----------------------------------------------------------------

function ReleasedTable({ rows }: Readonly<{ rows: readonly TrackingHold[] }>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips" data-testid="tracking-released-table">
          <caption id={captionId} className="data-table__caption">
            {t("tracking.released.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("tracking.col.kind")}</th>
              <th scope="col">{t("tracking.col.product")}</th>
              <th scope="col">{t("tracking.col.identity")}</th>
              <th scope="col">{t("tracking.col.reason")}</th>
              <th scope="col">{t("tracking.col.placedAt")}</th>
              <th scope="col">{t("tracking.col.releasedAt")}</th>
              <th scope="col">{t("tracking.col.releasedBy")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((hold) => (
              <tr key={hold.id} className="data-table__row data-table__row--static">
                <td>
                  <span className="badge">{t(holdKindKey(hold.kind))}</span>
                </td>
                <th scope="row">
                  <ProductName id={hold.tenantProductRef} />
                </th>
                <td>
                  <IdentityLink id={hold.trackingIdentityId} />
                </td>
                <td>
                  <ReasonLabel code={hold.reasonCode} />
                </td>
                <td>
                  <When iso={hold.placedAt} />
                </td>
                <td>{hold.releasedAt ? <When iso={hold.releasedAt} /> : null}</td>
                <td>{hold.releasedBy ? <ActorName userId={hold.releasedBy} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

export function ReleasedPanel({ scope }: Readonly<{ scope: InventoryScope }>): React.JSX.Element {
  const t = useT();
  const list = useTrackingHolds(scope, "released");
  const status = (
    <PagedStatus
      list={list}
      noun={t("tracking.released.loadingNoun")}
      failedKey="tracking.released.loadFailed"
      emptyKey="tracking.released.empty"
    />
  );
  if (list.isLoading || list.error || (list.rows.length === 0 && !list.hasMore)) return status;
  return (
    <>
      <ReleasedTable rows={list.rows} />
      <Continuation list={list} label={t("tracking.released.loadMore")} />
    </>
  );
}

// --- Recalls ---------------------------------------------------------------------------

function RecallsTable({
  rows,
  onOpen,
}: Readonly<{ rows: readonly RecallSummary[]; onOpen: (id: string) => void }>) {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips" data-testid="tracking-recalls-table">
          <caption id={captionId} className="data-table__caption">
            {t("tracking.recalls.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("tracking.col.product")}</th>
              <th scope="col">{t("tracking.col.reference")}</th>
              <th scope="col">{t("tracking.col.reason")}</th>
              <th scope="col">{t("tracking.col.effectiveAt")}</th>
              <th scope="col">{t("tracking.col.createdBy")}</th>
              <th scope="col" className="num">
                {t("tracking.col.activeHolds")}
              </th>
              <th scope="col">{t("tracking.col.action")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((recall) => (
              <tr key={recall.id} className="data-table__row data-table__row--static">
                <th scope="row">
                  <ProductName id={recall.tenantProductRef} />
                </th>
                <td>
                  <Machine value={recall.reference} />
                </td>
                <td>
                  <ReasonLabel code={recall.reasonCode} />
                </td>
                <td>
                  <When iso={recall.effectiveAt} />
                </td>
                <td>
                  <ActorName userId={recall.createdBy} />
                </td>
                <td className="num">
                  {t("tracking.recalls.holdCount", {
                    active: recall.activeHoldCount,
                    total: recall.holdCount,
                  })}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onOpen(recall.id)}
                    aria-label={t("tracking.recalls.openLabel", { reference: recall.reference })}
                  >
                    {t("tracking.action.open")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

export function RecallsPanel({
  scope,
  onOpen,
}: Readonly<{ scope: InventoryScope; onOpen: (id: string) => void }>): React.JSX.Element {
  const t = useT();
  const list = useRecalls(scope);
  const status = (
    <PagedStatus
      list={list}
      noun={t("tracking.recalls.loadingNoun")}
      failedKey="tracking.recalls.loadFailed"
      emptyKey="tracking.recalls.empty"
    />
  );
  if (list.isLoading || list.error || (list.rows.length === 0 && !list.hasMore)) return status;
  return (
    <>
      <RecallsTable rows={list.rows} onOpen={onOpen} />
      <Continuation list={list} label={t("tracking.recalls.loadMore")} />
    </>
  );
}
