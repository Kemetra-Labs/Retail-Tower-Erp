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
import { useT } from "@/i18n";
import type { RecallSummary, TrackingHold } from "@/lib/tracking-queries";
import { Link } from "react-router";
import { Machine } from "../inventory/parts";
import type { InventoryScope } from "../inventory/useInventory";
import { PagedPanel } from "./PagedPanel";
import { ActorName, ProductName, ReasonLabel, When } from "./parts";
import { holdKindKey } from "./trackingLogic";
import { useRecalls, useTrackingHolds } from "./useTracking";

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
  const list = useTrackingHolds(scope, "released");
  return (
    <PagedPanel
      list={list}
      loadingKey="tracking.released.loadingNoun"
      failedKey="tracking.released.loadFailed"
      emptyKey="tracking.released.empty"
      moreKey="tracking.released.loadMore"
    >
      {(rows) => <ReleasedTable rows={rows} />}
    </PagedPanel>
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
  const list = useRecalls(scope);
  return (
    <PagedPanel
      list={list}
      loadingKey="tracking.recalls.loadingNoun"
      failedKey="tracking.recalls.loadFailed"
      emptyKey="tracking.recalls.empty"
      moreKey="tracking.recalls.loadMore"
    >
      {(rows) => <RecallsTable rows={rows} onOpen={onOpen} />}
    </PagedPanel>
  );
}
