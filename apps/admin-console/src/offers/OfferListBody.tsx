/**
 * RT-1338 offers list body: loading, error, empty, the table and "Load more". Errors show catalog
 * copy and the request id, never the server's words; a failed "Load more" keeps the rows shown.
 */
import { Banner } from "@/components/Banner";
import { BusyButton } from "@/components/BusyButton";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { ListState } from "@/components/ListState";
import { type MessageKey, useT } from "@/i18n";
import { getLocale } from "@/i18n/locale";
import type { OfferSummary } from "@/lib/offer-queries";
import { OfferStateBadge, ScheduleText, ScopeText } from "./OfferParts";
import type { OfferListValue, OfferReadError } from "./useOffers";

const ERROR_COPY: Record<OfferReadError["kind"], MessageKey> = {
  session: "offers.error.session",
  forbidden: "offers.error.forbidden",
  notFound: "offers.list.loadFailed",
  generic: "offers.list.loadFailed",
};

function offerName(row: OfferSummary): string {
  return getLocale() === "en" && row.nameEn ? row.nameEn : row.nameAr;
}

function OfferRow({
  row,
  roster,
  onOpen,
}: Readonly<{
  row: OfferSummary;
  roster: readonly { id: string; name?: string }[];
  onOpen: () => void;
}>): React.JSX.Element {
  const t = useT();
  const name = offerName(row);
  return (
    <tr className="data-table__row">
      <td>
        <bdi dir="auto">{name}</bdi>
        {row.hasDraft ? <span className="badge">{t("offers.list.hasDraft")}</span> : null}
      </td>
      <td>
        <OfferStateBadge state={row.state} />
      </td>
      <td>
        <ScheduleText schedule={row.schedule} />
      </td>
      <td>
        <ScopeText scope={row.storeScope} roster={roster} />
      </td>
      <td className="data-table__cell--num">
        {row.currentVersion === null ? "—" : row.currentVersion}
      </td>
      <td>
        <button
          type="button"
          className="btn-secondary"
          onClick={onOpen}
          aria-label={t("offers.list.openLabel", { name })}
        >
          {t("offers.list.open")}
        </button>
      </td>
    </tr>
  );
}

function OfferTable({
  rows,
  roster,
  onOpen,
}: Readonly<{
  rows: readonly OfferSummary[];
  roster: readonly { id: string; name?: string }[];
  onOpen: (offerId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table">
          <caption id={captionId} className="data-table__caption">
            {t("offers.list.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("offers.list.col.name")}</th>
              <th scope="col">{t("offers.list.col.state")}</th>
              <th scope="col">{t("offers.list.col.schedule")}</th>
              <th scope="col">{t("offers.list.col.stores")}</th>
              <th scope="col" className="data-table__cell--num">
                {t("offers.list.col.version")}
              </th>
              <th scope="col">
                <span className="sr-only">{t("offers.list.col.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <OfferRow
                key={row.offerId}
                row={row}
                roster={roster}
                onOpen={() => onOpen(row.offerId)}
              />
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

export function OfferListBody({
  list,
  filtered,
  roster,
  onOpen,
}: Readonly<{
  list: OfferListValue;
  filtered: boolean;
  roster: readonly { id: string; name?: string }[];
  onOpen: (offerId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const { rows, hasMore, isLoading, isFetchingNextPage, error, loadMore } = list;
  const emptyAll = !isLoading && !error && rows.length === 0 && !hasMore;
  return (
    <>
      {isLoading ? <ListState state="loading" label={t("offers.list.loadingNoun")} /> : null}
      {error ? (
        <Banner variant="danger" message={t(ERROR_COPY[error.kind])} requestId={error.requestId} />
      ) : null}
      {emptyAll ? (
        <ListState
          state="empty"
          emptyMessage={t(filtered ? "offers.list.emptyFiltered" : "offers.list.empty")}
        />
      ) : null}
      {!isLoading && rows.length > 0 ? (
        <OfferTable rows={rows} roster={roster} onOpen={onOpen} />
      ) : null}
      {!isLoading && hasMore ? (
        <div className="surface__actions">
          <BusyButton
            type="button"
            className="btn-secondary"
            onClick={loadMore}
            busy={isFetchingNextPage}
          >
            {t("offers.list.loadMore")}
          </BusyButton>
        </div>
      ) : null}
    </>
  );
}
